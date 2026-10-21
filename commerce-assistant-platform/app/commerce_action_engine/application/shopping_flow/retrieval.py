"""Bounded catalog retrieval and independent candidate evidence checks."""

from app.commerce_action_engine.actions.catalog import (
    Product,
    SearchAttribute,
    SearchPredicate,
    SearchToolArgs,
)
from app.commerce_action_engine.actions.shopping.constraints import (
    category_parts,
    matches_attribute,
    matches_category,
    normalized,
    schema_value,
)
from app.commerce_action_engine.actions.shopping.contracts import (
    ShoppingClarification,
)
from app.commerce_action_engine.actions.shopping.grounding import (
    plan_clarification,
)
from app.commerce_action_engine.actions.shopping.meaning import verified_products
from app.commerce_action_engine.actions.shopping.personalization import (
    prepare as personalization_prepare,
)
from app.commerce_action_engine.actions.shopping.recommendations import (
    product_list_parts,
    purpose_groups,
)
from app.commerce_action_engine.contracts import AssistantBlock
from app.commerce_action_engine.execution.language.shopping import (
    contains_phrase,
)
from app.commerce_resolution_engine.diagnostics import capture_enabled, debug_record

from .catalog import ShoppingCatalog
from .contracts import (
    GroundedShopping,
    PreparedShopping,
    ReferenceSelection,
    RetrievedShopping,
    ShoppingAnswer,
)
from .presentation import ShoppingResponder


async def retrieve_candidates(
    prepared: PreparedShopping,
    grounded: GroundedShopping,
    references: ReferenceSelection,
    *,
    catalog: ShoppingCatalog,
    responder: ShoppingResponder,
) -> RetrievedShopping | ShoppingAnswer:
    plan, schema, meaning = references.plan, grounded.schema, grounded.meaning
    filters, purpose = grounded.filters, grounded.purpose
    category_fallback, reserved_searches = (
        grounded.category_fallback,
        grounded.reserved_searches,
    )
    message, required_names = prepared.message, prepared.required_names
    revision_changed = prepared.revision_changed
    reference, excluded_ids = references.product, references.excluded_ids
    active_profile = None

    def answer(
        text: str,
        blocks: tuple[AssistantBlock, ...] = (),
        *,
        clarification: str | None = None,
        verified_read: bool = False,
        pending_shopping: ShoppingClarification | None = None,
    ) -> ShoppingAnswer:
        return responder.build(
            text,
            blocks,
            plan=plan,
            schema=schema,
            calls=catalog.calls,
            clarification=clarification,
            verified_read=verified_read,
            pending_shopping=pending_shopping,
            active_profile=active_profile,
        )

    search_args = SearchToolArgs(
        # Without a managed classification filter, a wildcard fills the
        # bounded candidate window with unrelated categories. Retrieve by
        # the requested category first, then verify category membership.
        query="*" if reference else (category_fallback or plan.query).strip(),
        category_id=str(reference.category_id) if reference else plan.category_id,
        currency=plan.currency,
        min_price=plan.min_price,
        max_price=plan.max_price,
        exclusive_min=plan.exclusive_min,
        exclusive_max=plan.exclusive_max,
        in_stock=plan.in_stock,
        excluded_product_ids=sorted(excluded_ids)[:20],
        attributes=[
            SearchAttribute(name=name, value=value) for name, value in filters.items()
        ],
        predicates=[
            SearchPredicate(
                name=c.name,
                operator=c.operator,
                value=schema_value(
                    next(d for d in schema.attributes if d.code == c.name), c.value
                ),
            )
            for c in plan.attributes
            if c.operator != "eq"
            and any(d.code == c.name and d.filterable for d in schema.attributes)
        ],
    )
    groups = (
        purpose_groups(plan, schema, purpose)
        if not reference
        and (not plan.unresolved_requirements or plan.discovery_refined)
        else []
    )
    fallback_parts = (
        category_parts(category_fallback) if category_fallback and not groups else []
    )
    item_parts = (
        product_list_parts(plan, schema)
        if not reference
        and not groups
        and not category_fallback
        and not reserved_searches
        else []
    )
    # Reserve the entire list, never silently truncate the requested items.
    if len(item_parts) + 1 > catalog.limit - catalog.calls:
        item_parts = []
    if catalog.planning and item_parts:
        catalog.planning.compose_category_search(1 + len(item_parts))
    if len(fallback_parts) <= 1:
        fallback_parts = []
    # Reserve optional reads before the first search; a fallback may not enlarge
    # an already executed plan. Keep the request's total tool budget intact.
    fallback_parts = fallback_parts[: max(0, catalog.limit - catalog.calls - 1)]
    if reserved_searches:
        fallback_parts = fallback_parts[: max(0, reserved_searches - 2)]
    if catalog.planning and fallback_parts and not reserved_searches:
        catalog.planning.compose_category_search(1 + len(fallback_parts))
    if groups and len(groups) <= catalog.limit - catalog.calls:
        if catalog.planning and not reserved_searches:
            catalog.planning.compose_purpose_search(len(groups))
        grouped_products: list[Product] = []
        for group in groups:
            args = search_args.model_copy(deep=True)
            args.attributes.append(SearchAttribute(name=group.name, value=group.value))
            result = await catalog.call("search_products", args)
            grouped_products.extend(
                p for p in result.products if matches_attribute(p, group)
            )
        result.products = grouped_products
    else:
        groups = []
        result = await catalog.call("search_products", search_args)
    compound_products = (
        [p for p in result.products if contains_phrase(p.name, plan.query)]
        if item_parts
        else []
    )
    if compound_products:
        result.products = compound_products
    if item_parts and not compound_products:
        candidates: list[Product] = []
        for part in item_parts:
            args = search_args.model_copy(deep=True)
            args.query = part
            partial = await catalog.call("search_products", args)
            candidates.extend(p for p in partial.products if matches_category(p, part))
        result.products = list({p.id: p for p in candidates}.values())
        # Each bounded query has its own facets; none describes the union.
        result.catalog_profile = None
    if (
        category_fallback
        and not any(matches_category(p, category_fallback) for p in result.products)
        and fallback_parts
    ):
        candidates = []
        for part in fallback_parts:
            if catalog.calls >= catalog.limit:
                break
            args = search_args.model_copy(deep=True)
            args.query = part
            partial = await catalog.call("search_products", args)
            candidates.extend(p for p in partial.products if matches_category(p, part))
        result.products = list({p.id: p for p in candidates}.values())
    products_before_checks = len(result.products)
    applied_checks: list[str] = []
    check_steps: list[dict[str, object]] = []
    capture_filters = capture_enabled()

    def checked(label: str, reason: str) -> None:
        if not capture_filters:
            return
        before = check_steps[-1]["after"] if check_steps else products_before_checks
        applied_checks.append(label)
        check_steps.append(
            {
                "check": label,
                "before": before,
                "after": len(result.products),
                "rejection_reason": reason,
            }
        )

    def record_local_filters() -> None:
        if applied_checks:
            debug_record(
                "catalog_filter",
                {
                    "products_before": products_before_checks,
                    "products_after": len(result.products),
                    "checks": applied_checks,
                    "check_steps": check_steps,
                },
            )

    if purpose is not None:
        # Independently verify the retrieval selector even if a tool returns noise.
        result.products = [p for p in result.products if matches_attribute(p, purpose)]
        checked("Requested purpose", "purpose_mismatch")
    if excluded_ids:
        result.products = [p for p in result.products if str(p.id) not in excluded_ids]
        checked("Excluded products", "excluded_product")
    memory_clarification = personalization_prepare(message, result.products)
    if memory_clarification:
        record_local_filters()
        return answer(memory_clarification)
    if required_names:
        result.products = [
            p
            for p in result.products
            if all(contains_phrase(p.name, name) for name in required_names)
        ]
        checked("Required product names", "required_name_mismatch")
    if plan.category_id:
        # Product names cannot prove category membership. Verify primary and
        # secondary IDs against the live merchant hierarchy independently.
        category_ids = {plan.category_id}
        while True:
            descendants = {
                str(category.id)
                for category in schema.categories
                if category.parent_id and str(category.parent_id) in category_ids
            }
            if descendants <= category_ids:
                break
            category_ids.update(descendants)
        result.products = [
            product
            for product in result.products
            if category_ids.intersection(
                {str(product.category_id), *(str(id) for id in product.category_ids)}
            )
        ]
        if not schema.categories_complete and result.catalog_profile is not None:
            result.catalog_profile.complete = False
        checked("Category membership", "category_id_mismatch")
    if category_fallback:
        result.products = [
            product
            for product in result.products
            if matches_category(product, category_fallback)
        ]
        checked("Category text match", "category_text_mismatch")
    if (
        plan.shopping_context
        and not reference
        and not plan.category_id
        and not plan.required_product_ids
        and plan.query != "*"
        and not any(
            d.semantic_role == "classification"
            and any(c.name == d.code for c in plan.attributes)
            for d in schema.attributes
        )
    ):
        # A typed use or recipient never proves product identity. When the
        # merchant schema cannot resolve the requested target, independently
        # verify lexical retrieval against catalog names/categories/SKUs. A
        # broad fallback result (for example bread for sewing supplies) cannot
        # become a recommendation merely because its price is acceptable.
        result.products = [
            product
            for product in result.products
            if matches_category(product, plan.query)
            or normalized(product.sku) == normalized(plan.query)
        ]
        checked("Product identity", "product_identity_mismatch")
    if meaning is not None:

        def record_requirements(rows: list[dict[str, object]]) -> None:
            applied_checks.extend(str(row["check"]) for row in rows)
            check_steps.extend(rows)

        result.products = verified_products(
            result.products,
            meaning,
            on_checks=record_requirements if capture_filters else None,
        )
    record_local_filters()
    if result.catalog_profile and result.catalog_profile.revision != schema.version:
        return answer(
            "The catalog changed during this search. Please try your request again so I can use the latest product information."
        )
    if any(
        not any(d.code == c.name and d.filterable for d in schema.attributes)
        for c in plan.attributes
    ):
        # Retrieval facets cannot prove an evidence-only constraint.
        result.catalog_profile = None
    active_profile = result.catalog_profile
    pending = plan_clarification(plan, schema, result.catalog_profile)
    if pending is not None:
        question = pending.question
        if revision_changed:
            question = (
                "The catalog has changed, so I refreshed the available choices. "
                + question
            )
            pending.question = question
        return answer(question, pending_shopping=pending)
    if (
        result.catalog_profile is not None
        and not result.catalog_profile.complete
        and not result.products
    ):
        return answer(
            "I couldn’t complete this catalog search. Please narrow the product or feature and try again."
        )
    if plan.required_product_ids:
        before_ids = len(result.products)
        result.products = [
            p for p in result.products if str(p.id) in plan.required_product_ids
        ]
        if capture_filters:
            debug_record(
                "catalog_filter",
                {
                    "products_before": before_ids,
                    "products_after": len(result.products),
                    "checks": ["Required product IDs"],
                    "check_steps": [
                        {
                            "check": "Required product IDs",
                            "before": before_ids,
                            "after": len(result.products),
                            "rejection_reason": "product_id_mismatch",
                        }
                    ],
                },
            )
    return RetrievedShopping(result, tuple(groups))
