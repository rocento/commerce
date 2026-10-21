"""Ground product identities and customer constraints against the current merchant schema."""

import re
from dataclasses import replace
from decimal import InvalidOperation

from app.commerce_action_engine.actions.catalog import (
    CatalogSchema,
    SearchToolArgs,
)
from app.commerce_action_engine.actions.catalog import no_match as discovery_no_match
from app.commerce_action_engine.actions.catalog.workflow import broad_value_request
from app.commerce_action_engine.actions.shopping.constraints import (
    normalized,
    numeric_constraints,
    preserve_schema_constraints,
    schema_value,
    structured_filters,
)
from app.commerce_action_engine.actions.shopping.context import (
    GroundedRelationship,
    ShoppingContextError,
    ground_context,
)
from app.commerce_action_engine.actions.shopping.contracts import (
    Constraint,
    ShoppingClarification,
    ShoppingIntent,
)
from app.commerce_action_engine.actions.shopping.gifts import gift_preferences
from app.commerce_action_engine.actions.shopping.grounding import (
    attribute_clarification,
    ground_request,
    observed_schema,
    required_uncertainty,
)
from app.commerce_action_engine.actions.shopping.literal_identity import (
    contains_value,
    matches_name,
    source_name,
    without_name,
)
from app.commerce_action_engine.actions.shopping.meaning import (
    MeaningConflict,
    apply_meaning,
)
from app.commerce_action_engine.actions.shopping.pricing import (
    empty_price_range,
    retain_price_bounds,
)
from app.commerce_action_engine.actions.shopping.quantity_language import (
    quantity_comparisons,
)
from app.commerce_action_engine.actions.shopping.recommendations import (
    CatalogPurposeUnavailable,
    product_list_parts,
    purpose_filter,
)
from app.commerce_action_engine.application.responses import finish
from app.commerce_action_engine.contracts import AssistantBlock
from app.commerce_action_engine.execution.core.meaning import (
    ConstraintFrame,
    Requirement,
    Span,
    Value,
    clarify,
    merge_requirements,
)
from app.commerce_action_engine.platform import meaning_summary
from app.commerce_action_engine.shared.errors import RuntimeErrorCode
from app.commerce_resolution_engine.contracts import (
    Message,
)

from .catalog import ShoppingCatalog
from .contracts import (
    GroundedShopping,
    IdentityGrounding,
    PreparedShopping,
    ShoppingAnswer,
)
from .presentation import ShoppingResponder


async def ground_identity(
    prepared: PreparedShopping,
    *,
    schema: CatalogSchema,
    catalog: ShoppingCatalog,
    responder: ShoppingResponder,
) -> IdentityGrounding | ShoppingAnswer:
    """Resolve exact identities before interpreting words as category attributes."""
    plan = prepared.plan.model_copy(deep=True)
    gate, message = prepared.gate, prepared.message
    grounded_constraints: list[Constraint] = []
    reserved_searches = 0
    literal_identity_text: str | None = None
    if product_list_parts(plan, schema):
        # A dictionary label for one list member cannot constrain the whole list.
        # Independently specified categories are excluded by product_list_parts.
        plan.category = None

    # Both search and recommendation share the same runtime-schema grounding.
    # Exact catalog identity is checked before accepting descriptive decomposition.
    if not prepared.resuming and (
        gate is None or gate.legacy_intent in {"PRODUCT_SEARCH", "PRODUCT_RECOMMEND"}
    ):
        product_text = gate.entities.get("productText") if gate is not None else None
        try:
            grounded = ground_request(
                plan,
                message,
                schema,
                product_text=product_text if isinstance(product_text, str) else None,
            )
            if (
                grounded.frame.category_id
                and any(
                    d.filterable and d.data_type == "text" and not d.options
                    for d in schema.attributes
                )
                and (plan.attributes or grounded.frame.unresolved_requirements)
                and catalog.calls < catalog.limit - 2
            ):
                reserved_searches = min(5, catalog.limit - catalog.calls)
                if catalog.planning:
                    catalog.planning.compose_category_search(reserved_searches)
                observations = await catalog.call(
                    "search_products",
                    SearchToolArgs(query="*", category_id=grounded.frame.category_id),
                )
                schema = observed_schema(schema, observations.catalog_profile)
                grounded = ground_request(
                    plan,
                    message,
                    schema,
                    product_text=product_text
                    if isinstance(product_text, str)
                    else None,
                )
        except ValueError as error:
            return responder.build(
                str(error), plan=plan, schema=schema, calls=catalog.calls
            )
        identity = None
        literal_query = (
            source_name(
                message,
                product_text,
                include_tail=bool(gate and gate.entities.get("size")),
            )
            if isinstance(product_text, str)
            else None
        ) or grounded.literal_query
        if plan.sort_by or gate and gate.search_update:
            # Explicit corrections retain their typed filters; do not reinterpret
            # the composite edited query as a new name-only request.
            literal_query = grounded.literal_query
        if (
            literal_query
            # List retrieval tries the intact name first. Avoid spending the
            # bounded tool budget on a duplicate identity-only probe.
            and not product_list_parts(grounded.frame, schema)
            and not plan.cheaper
            and plan.presentation in {"search", "recommend"}
            and catalog.calls < catalog.limit - 1
        ):
            if catalog.planning and not reserved_searches:
                # Reserve identity plus scoped retrieval before either read.
                # The existing catalog composition permits at most five
                # searches and still enforces the request's total tool budget.
                reserved_searches = min(5, catalog.limit - catalog.calls)
                catalog.planning.compose_category_search(reserved_searches)
            literal = await catalog.call(
                "search_products",
                SearchToolArgs(
                    query=literal_query,
                    min_price=plan.min_price,
                    max_price=plan.max_price,
                    exclusive_min=plan.exclusive_min,
                    exclusive_max=plan.exclusive_max,
                    currency=plan.currency,
                ),
            )
            identities = [
                p for p in literal.products if matches_name(literal_query, p, schema)
            ]
            if len(identities) == 1:
                identity = identities[0]
        if identity is None:
            plan = grounded.frame
            grounded_constraints = list(grounded.required_constraints)
        else:
            literal_identity_text = literal_query
            plan.query = literal_query or plan.query
            assert literal_query is not None
            outside = without_name(message, literal_query)
            # Name-only descriptors are identity words. Repeated or separate
            # customer constraints remain mandatory and are grounded below.
            plan.attributes = [
                c
                for c in plan.attributes
                if not contains_value(literal_query, c.value)
                or contains_value(outside, c.value)
            ]
            if (
                plan.brand
                and contains_value(literal_query, plan.brand)
                and not contains_value(outside, plan.brand)
            ):
                plan.brand = None
            plan.category_id = str(identity.category_id)
            plan.category = identity.category_name or None
            plan.required_product_ids = [str(identity.id)]
            plan.unresolved_requirements = []

    return IdentityGrounding(
        plan,
        schema,
        tuple(grounded_constraints),
        reserved_searches,
        literal_identity_text,
    )


async def ground_shopping(
    prepared: PreparedShopping,
    *,
    schema: CatalogSchema,
    default_currency: str | None,
    catalog: ShoppingCatalog,
    responder: ShoppingResponder,
    commerce_meaning: bool,
    history: tuple[Message, ...],
) -> GroundedShopping | ShoppingAnswer | None:
    contextual_requirements: tuple[GroundedRelationship, ...] = ()
    if prepared.plan.shopping_context:
        contextual_plan = prepared.plan.model_copy(deep=True)
        try:
            contextual_requirements = ground_context(contextual_plan, schema)
        except ShoppingContextError as error:
            return responder.build(
                str(error), plan=contextual_plan, schema=schema, calls=catalog.calls
            )
        prepared = replace(prepared, plan=contextual_plan)
    identity = await ground_identity(
        prepared,
        schema=schema,
        catalog=catalog,
        responder=responder,
    )
    if isinstance(identity, ShoppingAnswer):
        return identity
    plan, schema = identity.plan, identity.schema
    message = prepared.message
    constraint_message = prepared.constraint_message
    gate = prepared.gate
    revision_changed = prepared.revision_changed
    generic = {"product", "products", "item", "items"}
    meaning = None
    active_profile = None
    grounded_constraints = list(identity.required_constraints)
    reserved_searches = identity.reserved_searches
    literal_identity_text = identity.literal_text

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

    # Customer limits remain authoritative even if model extraction omits them.
    try:
        non_price_spans = tuple(
            span for _, span in numeric_constraints(constraint_message, schema)
        ) + tuple(
            (quantity.start, quantity.end)
            for quantity in quantity_comparisons(constraint_message)
        )
    except ValueError:
        return answer("Please clarify the required measurement, comparison, and unit.")
    if revision_changed or prepared.resuming:
        # The owner-bound continuation frame contains the accepted budget.
        # Re-reading the original message would restore a superseded amount
        # or currency after the shopper answers our replacement question.
        constraint_message = ""
        non_price_spans = ()
    try:
        explicit_prices = retain_price_bounds(
            {}, constraint_message, ignore_spans=non_price_spans
        )
    except ValueError as error:
        return answer(str(error))
    if not plan.shopping:
        if explicit_prices or re.search(r"\bcheaper\b|\bsize\s+\d", message.casefold()):
            return answer(
                "Please clarify the product and requirements you want me to search for."
            )
        return None
    if "get_catalog_schema" not in catalog.tools:
        raise RuntimeErrorCode("tool_not_allowed")
    try:
        plan = ShoppingIntent.model_validate(
            retain_price_bounds(
                plan.model_dump(),
                constraint_message,
                literal_ties=True,
                ignore_spans=non_price_spans,
            )
        )
    except ValueError:
        return answer(
            "Please clarify the price range using one currency and a non-empty range."
        )
    attribute_message = (
        without_name(message, literal_identity_text)
        if literal_identity_text
        else message
    )
    pending_attribute = attribute_clarification(plan, attribute_message, schema)
    if pending_attribute is not None:
        return answer(pending_attribute.question, pending_shopping=pending_attribute)
    unresolved = required_uncertainty(plan)
    if unresolved:
        return answer(unresolved)
    required_constraints = [
        *grounded_constraints,
        *(row.constraint for row in contextual_requirements),
    ]
    if plan.category and not plan.category_id:
        classifications = [
            d
            for d in schema.attributes
            if d.semantic_role == "classification"
            and any(normalized(o.code) == normalized(plan.category) for o in d.options)
        ]
        if len(classifications) == 1:
            category_constraint = Constraint(
                name=classifications[0].code, value=plan.category
            )
            plan.attributes.append(category_constraint)
            if prepared.interpreted:
                required_constraints.append(category_constraint.model_copy(deep=True))
            plan.category = None
    category_fallback = (
        plan.category.replace("_", " ")
        if plan.category and plan.query == "*" and not plan.category_id
        else None
    )
    if plan.brand:
        brands = [
            d for d in schema.attributes if d.semantic_role == "brand" and d.filterable
        ]
        if len(brands) == 1:
            plan.attributes.append(Constraint(name=brands[0].code, value=plan.brand))
            plan.brand = None
    # Preserve literal managed option requests using the discovered schema, never fixed industry filters.
    value_browse = prepared.interpreted and broad_value_request(message)
    catalog_message = "" if value_browse else message
    if literal_identity_text:
        # An exact catalog name is identity evidence, not an implicit attribute
        # request. Still enforce separate modifiers elsewhere in the message.
        catalog_message = re.sub(
            r"(?<!\w)" + re.escape(literal_identity_text) + r"(?!\w)",
            " ",
            catalog_message,
            count=1,
            flags=re.IGNORECASE,
        )
    explicit_purpose = (
        not value_browse
        and prepared.interpreted
        and gate is not None
        and "catalogPurpose" in gate.entities
    )
    purpose_query = plan.query
    purpose_constraints = (
        [c.model_copy(deep=True) for c in plan.attributes] if explicit_purpose else []
    )
    try:
        purpose = purpose_filter(plan, schema, explicit=explicit_purpose)
        if prepared.resuming:
            # A server-issued answer is already a typed customer selection. Do
            # not reinterpret its bare label as new unrelated option evidence.
            pass
        elif commerce_meaning:
            meaning = apply_meaning(
                plan, catalog_message, schema, history, record_meaning=meaning_summary
            )
        else:
            plan.attributes = preserve_schema_constraints(
                catalog_message, plan.attributes, schema
            )
        if contextual_requirements:
            # Verification must keep these requirements even when alternatives
            # are requested or meaning extraction is disabled or resumed.
            typed = tuple(
                Requirement(
                    field=row.constraint.name,
                    operator="neq" if row.relation.negated else "eq",
                    value=Value(kind="text", text=row.constraint.value),
                    strength="hard",
                    source="session" if prepared.resuming else "current_customer",
                    confidence=1.0,
                    evidence=()
                    if prepared.resuming
                    else (
                        Span(
                            turn=len(history[-6:]),
                            start=row.relation.start,
                            end=row.relation.end,
                        ),
                    ),
                )
                for row in contextual_requirements
            )
            meaning = merge_requirements(
                (meaning or ConstraintFrame()).requirements, typed
            )
            decision = clarify(meaning)
            meaning_summary(meaning, decision)
            if decision.required:
                fields = ", ".join(decision.fields)
                raise MeaningConflict(
                    f"Your requirements conflict for {fields}. Which value or range should I use?"
                )
        if explicit_purpose:
            # The requested product and its explicit filters remain required;
            # semantic preference extraction must not broaden the search.
            plan.query = purpose_query
            plan.attributes.extend(
                c for c in purpose_constraints if c not in plan.attributes
            )
        # Typed relationships were verified against literal customer text and
        # the catalog before their spans were masked. Later meaning extraction
        # must not demote them to inferred preferences because that text is gone.
        # Catalog-grounded categories carry the same mandatory constraint.
        plan.attributes.extend(
            c for c in required_constraints if c not in plan.attributes
        )
        plan.preferences = [
            c for c in plan.preferences if c not in required_constraints
        ]
        gift_preferences(plan, schema)
        filters = structured_filters(plan.attributes, schema, allow_evidence_only=True)
        for preference in plan.preferences:
            definition = next(
                (
                    d
                    for d in schema.attributes
                    if normalized(preference.name)
                    in {normalized(d.code), normalized(d.label)}
                ),
                None,
            )
            if definition:
                try:
                    preference.value = str(schema_value(definition, preference.value))
                    preference.name = definition.code
                except (ValueError, InvalidOperation):
                    pass
    except MeaningConflict as conflict:
        return answer(str(conflict))
    except CatalogPurposeUnavailable:
        return answer(discovery_no_match(None), finish([], browse_catalog=True))
    except (ValueError, InvalidOperation, OverflowError):
        return answer(
            "Please clarify the required attribute and value using the current catalog options. I could not safely express every requirement as an available filter."
        )
    if purpose is not None:
        if purpose.name in filters and filters[purpose.name] != purpose.value:
            return answer(
                "Please clarify which intended use you want me to search for."
            )
        filters[purpose.name] = purpose.value
        if not explicit_purpose:
            plan.query = "*"
        else:
            if purpose not in plan.attributes:
                plan.attributes.append(purpose)
            plan.preferences = [c for c in plan.preferences if c not in plan.attributes]
            plan.intended_use = None
        if (
            not explicit_purpose
            and purpose not in plan.preferences
            and len(plan.preferences) < 5
        ):
            plan.preferences.append(purpose)
    query_words = set(normalized(plan.query).split())
    attribute_words = {
        word for c in plan.attributes for word in normalized(c.value).split()
    }
    if (
        query_words
        and query_words <= generic | attribute_words | {"my", "some"}
        and (not explicit_purpose or query_words <= generic | {"my", "some"})
    ):
        plan.query = "*"
    if re.search(r"\bin stock\b|\bavailable now\b", message.casefold()):
        plan.in_stock = True
    if empty_price_range(plan):
        return answer(
            "The minimum budget exceeds the maximum. Please clarify the price range."
        )
    plan.alternatives = plan.alternatives and bool(
        re.search(
            r"\b(?:show|allow|include|accept) (?:me )?alternatives\b|\b(?:can|may) relax\b",
            message.casefold(),
        )
    )
    if re.search(
        r"\b(?:not|no|never|without|keep|must)\b.*\b(?:alternatives|relax|budget|size|color|brand|stock)\b",
        message.casefold(),
    ):
        plan.alternatives = False
    if plan.sort_by in {"price_asc", "price_desc"}:
        plan.cheaper = False
    else:
        plan.cheaper = plan.cheaper or bool(
            re.search(r"\bcheaper\b", message.casefold())
        )
    if plan.clarification:
        return answer(
            "I couldn't express every requirement as a catalog filter. Please specify the product type, currency, budget, and required attribute values."
        )
    if (
        (plan.max_price is not None or plan.min_price is not None)
        and not plan.currency
        and not plan.cheaper
        and not (gate and gate.entities.get("cheaperReferences"))
    ):
        plan.currency = default_currency
        if not plan.currency:
            return answer(
                "Which currency should I use for your budget?", clarification="currency"
            )

    return GroundedShopping(
        plan=plan,
        default_currency=default_currency,
        schema=schema,
        meaning=meaning,
        filters=filters,
        purpose=purpose,
        category_fallback=category_fallback,
        reserved_searches=reserved_searches,
    )
