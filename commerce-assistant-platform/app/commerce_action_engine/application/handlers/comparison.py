"""Resolve explicit comparison names/SKUs without guessing product identities."""

from collections.abc import AsyncGenerator, Callable
from typing import cast

from app.commerce_action_engine.actions.catalog import Product
from app.commerce_action_engine.actions.catalog.comparison import (
    ComparisonReader,
    comparison_query,
    distinct_comparison_products,
)
from app.commerce_action_engine.actions.catalog.references import suggestions
from app.commerce_action_engine.application.ports import EventFactory
from app.commerce_action_engine.application.responses import card, catalog_block
from app.commerce_action_engine.contracts import AssistantEvent, AssistantProductPrompt
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.platform import phase


def clear_comparison_event(make_event: EventFactory) -> AssistantEvent:
    # The selection belongs to this browser. Only the client can acknowledge
    # completion; persisted server history records the request, not a write claim.
    return make_event(
        "message.delta",
        code="clear_comparison",
        text="Requested to clear your comparison list in this browser.",
    )


async def comparison_events(
    *,
    request: InterpretedRequest,
    commerce_tools: Callable[[], ComparisonReader],
    make_event: EventFactory,
    metadata: dict[str, object],
) -> AsyncGenerator[AssistantEvent, None]:
    if request.legacy_intent == "CLEAR_COMPARISON":
        metadata.update(route_reason="comparison_clear", tools=[], tool_calls=0)
        yield clear_comparison_event(make_event)
        return
    items = request.entities.get("items", [])
    references = (
        [item.get("productText", "") for item in items if isinstance(item, dict)]
        if isinstance(items, list)
        else []
    )
    if (
        len(references) == 1
        and isinstance(references[0], str)
        and 0 < len(references[0].strip()) <= 120
    ):
        prompt = AssistantProductPrompt(
            query=references[0], quantity=1, action="compare"
        )
        metadata.update(
            route_reason="comparison_product_choice", tools=[], tool_calls=0
        )
        yield make_event(
            "message.delta", text="Choose two to five products to compare."
        )
        yield make_event(
            "content.blocks",
            blocks=[{"kind": "product_prompt", "product_prompt": prompt.model_dump()}],
        )
        return
    if not 2 <= len(references) <= 5 or any(
        not isinstance(r, str) or not r.strip() or len(r) > 200 for r in references
    ):
        yield make_event(
            "message.delta",
            text="Please name two to five products to compare, using their full names or SKUs.",
        )
        return
    yield make_event("progress", stage="catalog")
    products = []
    read_tools: list[str] = []
    metadata.update(route_reason="product_comparison", tools=read_tools, tool_calls=0)
    reader = commerce_tools()
    for reference in cast(list[str], references):
        query = comparison_query(reference)
        read_tools.append(query.tool_name)
        metadata["tool_calls"] = len(read_tools)
        with phase("tool"):
            match = await query.execute(reader)
        found = match.candidates
        if match.product is None:
            yield make_event(
                "message.delta",
                text=f"For “{reference}”: {suggestions(found)} Please repeat the comparison with your chosen full names or SKUs.",
            )
            if found:
                block = catalog_block(
                    "product_list",
                    [card(Product.model_validate(p), [], []) for p in found[:5]],
                    "Choose a product to compare",
                )
                yield make_event(
                    "content.blocks",
                    blocks=[block.model_dump(mode="json", exclude_unset=True)],
                )
            return
        product = match.product
        if match.requires_variant:
            yield make_event(
                "message.delta",
                text=f"Please choose a specific variant of {product.name} to compare.",
            )
            return
        products.append(product)
    if not distinct_comparison_products(products):
        yield make_event(
            "message.delta",
            text="Some references identify the same product. Please choose two to five different products.",
        )
        return
    block = catalog_block(
        "comparison_table",
        [card(p, [], []) for p in products],
        "Compare current catalog facts",
    )
    yield make_event(
        "content.blocks", blocks=[block.model_dump(mode="json", exclude_unset=True)]
    )
    yield make_event(
        "message.delta", text="Here is the comparison using current catalog facts."
    )
