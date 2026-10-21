"""Answer a single product question from an exact, capability-scoped catalog read."""

import re
from collections.abc import AsyncGenerator
from decimal import Decimal
from uuid import UUID

from app.commerce_action_engine.actions.catalog import Product
from app.commerce_action_engine.actions.catalog.product_facts import (
    PRODUCT_FACT_INTENTS,
    ProductFactReader,
    catalog_fact,
    factual_product,
)
from app.commerce_action_engine.actions.catalog.references import exact_products, key
from app.commerce_action_engine.application.ports import EventFactory
from app.commerce_action_engine.application.responses import card, catalog_block
from app.commerce_action_engine.contracts import AssistantEvent
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.platform import phase
from app.commerce_action_engine.shared.errors import ToolUnavailable

__all__ = ["PRODUCT_FACT_INTENTS", "product_fact_events"]

_DESCRIPTORS = frozenset({"category", "material", "brand", "color", "size", "flavor"})
_SELECTED_REFERENCES = frozenset(
    {"it", "this", "that", "this product", "that product", "selected product"}
)


async def product_fact_events(
    reader: ProductFactReader,
    request: InterpretedRequest,
    make_event: EventFactory,
    metadata: dict[str, object] | None = None,
    *,
    product_id: UUID | None = None,
    original_message: str | None = None,
) -> AsyncGenerator[AssistantEvent, None]:
    """A reader already bound to the admitted tenant is the only source of products."""
    tracked = metadata if metadata is not None else {}
    read_tools: list[str] = []
    tracked.update(
        route_reason="product_fact_selection",
        product_fact_status="selection_required",
        completion_disposition="clarification",
        tools=read_tools,
        tool_calls=0,
    )
    if (
        request.status != "RESOLVED"
        or request.legacy_intent not in PRODUCT_FACT_INTENTS
        or request.confidence.raw < 0.65
        or request.missing
        or request.request_type
        or request.operations
        or request.requires_confirmation
        or set(request.entities)
        - {"productText", "product_reference", "quantity", *_DESCRIPTORS}
        or (
            "quantity" in request.entities
            and (
                request.legacy_intent != "CHECK_PRICE"
                or type(request.entities["quantity"]) is not int
                or not 1 <= request.entities["quantity"] <= 99999
            )
        )
        or (
            "product_reference" in request.entities
            and request.entities["product_reference"] != "CURRENT"
        )
    ):
        yield make_event(
            "message.delta",
            text="Please ask one product question with the full product name or SKU.",
        )
        return
    reference = request.entities.get("productText")
    if reference is not None and (
        not isinstance(reference, str) or not 0 < len(reference.strip()) <= 200
    ):
        yield make_event(
            "message.delta", text="Please give the full product name or SKU to check."
        )
        return
    reference = reference.strip() if isinstance(reference, str) else None
    if product_id is None and (not reference or key(reference) in _SELECTED_REFERENCES):
        yield make_event(
            "message.delta",
            text="Which product should I check? Please select it or give its full name or SKU.",
            **(
                {
                    "clarification": {
                        "original_message": original_message,
                        "question": "Which product should I check? Please give its full name or SKU.",
                    }
                }
                if original_message and not reference
                else {}
            ),
        )
        return

    yield make_event("progress", stage="catalog")
    if product_id is not None:
        read_tools.append("get_product")
        tracked["tool_calls"] = len(read_tools)
        with phase("tool"):
            product = Product.model_validate(await reader.product(product_id))
        if product.id != product_id:
            raise ToolUnavailable()
        if (
            reference
            and key(reference) not in _SELECTED_REFERENCES
            and not exact_products([product.model_dump(mode="json")], reference)
        ):
            yield make_event(
                "message.delta",
                text="The selected product does not match that name or SKU. Please select the product you want me to check.",
            )
            return
    else:
        assert reference is not None
        read_tools.append("search_products")
        tracked["tool_calls"] = len(read_tools)
        with phase("tool"):
            found = await reader.search_cart_product(reference)
        exact = exact_products(found, reference)
        if len(exact) != 1:
            yield make_event(
                "message.delta",
                text="Please select the matching product or repeat your question with its full name or SKU."
                if found
                else "I couldn't find that exact product. Please check its full name or SKU.",
            )
            if found:
                block = catalog_block(
                    "product_list",
                    [
                        card(factual_product(Product.model_validate(item)), [], [])
                        for item in found[:5]
                    ],
                    "Choose a product to check",
                )
                yield make_event(
                    "content.blocks",
                    blocks=[block.model_dump(mode="json", exclude_unset=True)],
                )
            return
        # Refresh the selected identity; search ranking is never authority for a fact.
        selected_id = Product.model_validate(exact[0]).id
        read_tools.append("get_product")
        tracked["tool_calls"] = len(read_tools)
        with phase("tool"):
            product = Product.model_validate(await reader.product(selected_id))
        if product.id != selected_id or not exact_products(
            [product.model_dump(mode="json")], reference
        ):
            raise ToolUnavailable()

    # Extra descriptors are admitted only as literal parts of the verified name/SKU.
    # They must never silently become additional filters or product specifications.
    identity_text = key(product.name + " " + product.sku)
    if any(
        not isinstance(value, str)
        or not value.strip()
        or not re.search(
            r"(?<!\w)" + re.escape(key(value)) + r"s?(?!\w)", identity_text
        )
        for name, value in request.entities.items()
        if name in _DESCRIPTORS
    ):
        yield make_event(
            "message.delta",
            text="Please select the exact product and ask which published detail you want me to check.",
        )
        return
    if product.product_type != "simple":
        yield make_event(
            "message.delta",
            text=f"Please choose a specific variant of {product.name} so I can check its current details.",
        )
        return

    known = True
    if request.legacy_intent == "CHECK_PRICE":
        text = f"{product.name} costs {product.price} {product.currency} at the current catalog price. Tax, delivery and cart discounts are checked at checkout."
        if "quantity" in request.entities:
            quantity = request.entities["quantity"]
            assert type(quantity) is int  # Validated before any catalog reads.
            subtotal = Decimal(product.price) * quantity
            text = (
                f"{quantity} × {product.name} at {product.price} {product.currency} each "
                f"has a catalog subtotal of {subtotal} {product.currency}, before tax, "
                "delivery and cart discounts. Availability for this quantity is checked at checkout."
            )
    elif request.legacy_intent == "CHECK_STOCK":
        if product.in_stock is None:
            known = False
            text = f"Availability for {product.name} is not confirmed. Select a delivery location to check current availability."
        else:
            text = f"{product.name} is {'in stock' if product.in_stock else 'out of stock'} for the current delivery context."
    elif request.legacy_intent == "PRODUCT_DETAILS":
        text = f"Here are the current catalog details published for {product.name}."
    else:
        assert request.legacy_intent is not None
        fact = catalog_fact(product, request.legacy_intent)
        known = fact.status == "known"
        if known:
            text = f"{product.name} — {fact.label}: {fact.value}."
            if request.legacy_intent == "PRODUCT_ALLERGENS":
                text += " This is the published allergen information; it does not confirm personal allergy safety."
        elif fact.status == "conflicting":
            text = f"The published {fact.label.lower()} values for {product.name} conflict, so I can't confirm this detail. Please contact the store."
        else:
            text = f"I don't have a confirmed published {fact.label.lower()} value for {product.name}. Please contact the store for this detail."
    tracked.update(
        route_reason="product_facts" if known else "product_fact_unavailable",
        product_fact_status="answered" if known else "missing",
    )
    tracked.pop("completion_disposition", None)
    if known:
        tracked["completion_evidence"] = "read_result"
    yield make_event("message.delta", text=text)
    block = catalog_block(
        "product_card", [card(factual_product(product), [], [])], product.name
    )
    yield make_event(
        "content.blocks", blocks=[block.model_dump(mode="json", exclude_unset=True)]
    )
