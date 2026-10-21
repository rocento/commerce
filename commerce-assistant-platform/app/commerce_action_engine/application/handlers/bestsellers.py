"""Present period-specific sales rankings without exposing sales/customer records."""

from collections.abc import AsyncGenerator, Callable

from app.commerce_action_engine.actions.catalog.bestsellers import (
    BestsellerReader,
    sales_period,
)
from app.commerce_action_engine.application.ports import EventFactory
from app.commerce_action_engine.application.responses import card, catalog_block
from app.commerce_action_engine.contracts import AssistantEvent
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.platform import phase


async def bestseller_events(
    *,
    request: InterpretedRequest,
    commerce_tools: Callable[[], BestsellerReader],
    metadata: dict[str, object],
    make_event: EventFactory,
) -> AsyncGenerator[AssistantEvent, None]:
    period = sales_period(request.entities)
    metadata.update(tools=["get_bestsellers"], tool_calls=1)
    reader = commerce_tools()
    yield make_event("progress", stage="catalog")
    with phase("tool"):
        result = await reader.bestsellers(period)
    label = period.replace("_", " ")
    dates = f"{result.start:%Y-%m-%d %H:%M} to {result.end:%Y-%m-%d %H:%M} UTC"
    scope = (
        "in your delivery area"
        if result.scope == "delivery_area"
        else "across the store"
    )
    if result.products:
        block = catalog_block(
            "recommendation_group",
            [
                card(product, [f"Best seller {label}"], [])
                for product in result.products
            ],
            f"Best sellers {label}",
        )
        yield make_event(
            "content.blocks", blocks=[block.model_dump(mode="json", exclude_unset=True)]
        )
        text = f"Best sellers {label} {scope} ({dates}), ranked by units in completed orders placed during that period. Showing current catalog products from the top 50 ranked products. Prices shown are current."
    else:
        text = f"No current catalog products with qualifying completed sales were found for {label} ({dates})."
    yield make_event("message.delta", text=text)
