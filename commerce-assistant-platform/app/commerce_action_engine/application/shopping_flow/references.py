"""Resolve fresh product references for details, comparison and cheaper alternatives."""

import re
import time
from decimal import Decimal

from app.commerce_action_engine.actions.catalog import (
    CompareArgs,
    Product,
    ProductArgs,
)
from app.commerce_action_engine.actions.shopping.constraints import (
    mismatches,
)
from app.commerce_action_engine.actions.shopping.contracts import (
    ShoppingClarification,
)
from app.commerce_action_engine.actions.shopping.meaning import product_facts
from app.commerce_action_engine.actions.shopping.pricing import (
    empty_price_range,
)
from app.commerce_action_engine.application.responses import card, catalog_block, finish
from app.commerce_action_engine.application.shopping_presentation import (
    plain,
    render,
)
from app.commerce_action_engine.contracts import AssistantBlock
from app.commerce_action_engine.execution.core.meaning import verify
from app.commerce_action_engine.shared.errors import RuntimeErrorCode

from .catalog import ShoppingCatalog
from .contracts import (
    GroundedShopping,
    PreparedShopping,
    ReferenceSelection,
    ShoppingAnswer,
)
from .presentation import ShoppingResponder


async def resolve_references(
    prepared: PreparedShopping,
    grounded: GroundedShopping,
    *,
    catalog: ShoppingCatalog,
    responder: ShoppingResponder,
) -> ReferenceSelection | ShoppingAnswer:
    plan = grounded.plan.model_copy(deep=True)
    schema, meaning = grounded.schema, grounded.meaning
    message, gate = prepared.message, prepared.gate
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

    def candidate_failures(product: Product) -> list[str]:
        failures = mismatches(product, plan, None)
        if (
            plan.required_product_ids
            and str(product.id) not in plan.required_product_ids
        ):
            failures.append("requested product identity")
        if meaning is not None:
            failures.extend(
                f"{failure.field}: {failure.code}"
                for failure in verify(
                    meaning, product_facts(product), now=int(time.time())
                )
            )
        return list(dict.fromkeys(failures))

    if catalog.planning and (
        plan.cheaper
        or plan.presentation == "compare"
        or re.search(r"\bcompare\b", message.casefold())
    ):
        from app.commerce_action_engine.execution.core.meaning import ConstraintFrame

        catalog.planning.refine(
            "cheaper-alternative" if plan.cheaper else "comparison",
            meaning or ConstraintFrame(),
        )
    reference = None
    ids = list(
        dict.fromkeys(
            value.lower()
            for value in re.findall(
                r"/products/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?![0-9a-fA-F-])",
                message,
            )
        )
    )
    if not plan.cheaper and (
        plan.presentation == "compare" or re.search(r"\bcompare\b", message.casefold())
    ):
        if not 2 <= len(ids) <= 5:
            return answer(
                "Please select or paste two to five product links to compare current catalog facts."
            )
        result = await catalog.call("compare_products", CompareArgs(product_ids=ids))
        by_id = {str(p.id): p for p in result.products}
        if len(result.products) != len(ids) or set(by_id) != set(ids):
            raise RuntimeErrorCode("invalid_reference")
        products = [by_id[id] for id in ids]
        products = [
            p.model_copy(
                update={"attributes": [a for a in p.attributes if a.comparable]}
            )
            for p in products
        ]
        if any(p.product_type != "simple" for p in products):
            return answer(
                "Please select specific variants so I can compare their actual catalog facts."
            )
        cards = [card(p, [], candidate_failures(p)) for p in products]
        block = catalog_block(
            "comparison_table", cards, "Compare current catalog facts"
        )
        text = "Product comparison:\n" + "\n".join(
            f"{plain(p.name)}: {p.price} {p.currency}. {p.route}" for p in cards
        )
        text += "\n" + "\n".join(
            f"{plain(row.label)}: {' | '.join(plain(v) for v in row.values)}"
            for row in block.rows or []
        )
        comparison_blocks = finish([block])
        return answer(
            text + "\n" + (comparison_blocks[-2].text or ""),
            comparison_blocks,
            verified_read=True,
        )
    if not plan.cheaper and plan.presentation == "detail":
        if len(ids) != 1:
            return answer(
                "Please paste one product link to see its current catalog details."
            )
        result = await catalog.call("get_product", ProductArgs(product_id=ids[0]))
        if len(result.products) != 1 or str(result.products[0].id) != ids[0]:
            raise RuntimeErrorCode("invalid_reference")
        product = result.products[0]
        if product.product_type != "simple":
            return answer(
                "Please choose a specific variant to see its actual price and availability."
            )
        failures = candidate_failures(product)
        return answer(
            (
                f"Catalog details for {plain(product.name)}: {product.price} {product.currency}. Requirements not verified: "
                + ", ".join(failures)
            )
            if meaning is not None and failures
            else render(result.products, plan, None),
            finish(
                [
                    catalog_block(
                        "product_card",
                        [card(product, [], candidate_failures(product))],
                        "Product details",
                    )
                ]
            ),
        )
    if plan.cheaper:
        reference_ids = set(
            re.findall(
                r"/products/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?![0-9a-fA-F-])",
                message,
            )
        )
        if len(reference_ids) != 1:
            return answer(
                "Please paste one product link so I can find items in its category at a lower current price."
            )
        product_id = reference_ids.pop()
        result = await catalog.call("get_product", ProductArgs(product_id=product_id))
        if (
            len(result.products) != 1
            or str(result.products[0].id).lower() != product_id.lower()
        ):
            raise RuntimeErrorCode("invalid_reference")
        reference = result.products[0]
        if reference.product_type != "simple":
            return answer(
                "Please paste a specific variant's product link so I can compare its actual price."
            )
        if plan.currency and plan.currency != reference.currency:
            return answer(
                "The reference product uses a different currency. Please choose a product in your budget currency."
            )
        plan.currency = reference.currency
        if plan.max_price is None or Decimal(reference.price) <= Decimal(
            plan.max_price
        ):
            plan.max_price = reference.price
            plan.exclusive_max = True
    # Browsing without a product phrase uses the existing bounded catalog search.
    if plan.presentation == "search" and not plan.query.strip():
        plan.query = "*"
    if not plan.query.strip() and not reference:
        return answer("What kind of product would you like to find?")
    if empty_price_range(plan):
        return answer(
            "Please clarify the price range; no price can satisfy both limits."
        )
    excluded = gate.entities.get("excludedProducts", []) if gate else []
    cheaper = gate.entities.get("cheaperReferences", []) if gate else []
    if (
        not isinstance(excluded, list)
        or not isinstance(cheaper, list)
        or any(not isinstance(value, str) for value in [*excluded, *cheaper])
    ):
        return answer(
            "I couldn't verify the earlier products. Please choose a product to compare prices."
        )
    excluded_ids = {value for value in excluded if isinstance(value, str)}
    if cheaper:
        ids_to_check = [value for value in cheaper if isinstance(value, str)][:5]
        references = (
            await catalog.call("get_product", ProductArgs(product_id=ids_to_check[0]))
            if len(ids_to_check) == 1
            else await catalog.call(
                "compare_products", CompareArgs(product_ids=ids_to_check)
            )
        )
        if {str(p.id) for p in references.products} != set(ids_to_check):
            return answer(
                "I couldn't verify the earlier products. Please choose a product to compare prices."
            )
        currencies = {p.currency for p in references.products}
        if len(currencies) != 1 or (plan.currency and plan.currency not in currencies):
            return answer(
                "The earlier products use different currencies. Which product should I find cheaper options for?"
            )
        plan.currency = next(iter(currencies))
        ceiling = min(Decimal(p.price) for p in references.products)
        if plan.max_price is None or ceiling <= Decimal(plan.max_price):
            plan.max_price = str(ceiling)
            plan.exclusive_max = True
        plan.sort_by = "price_asc"
        if empty_price_range(plan):
            return answer(
                "No cheaper price fits your earlier price range. Would you like to change that range?"
            )
    return ReferenceSelection(plan, reference, frozenset(excluded_ids))
