"""Present the current delivery result without taking over turn admission."""

from collections.abc import AsyncGenerator, Callable

from app.commerce_action_engine.actions.customer import DeliveryReader
from app.commerce_action_engine.application.ports import EventFactory
from app.commerce_action_engine.contracts import AssistantEvent
from app.commerce_action_engine.platform import phase


async def delivery_events(
    *,
    commerce_tools: Callable[[], DeliveryReader],
    metadata: dict[str, object],
    make_event: EventFactory,
) -> AsyncGenerator[AssistantEvent, None]:
    metadata["route_reason"] = "delivery_status"
    yield make_event("progress", stage="catalog")
    metadata.update({"tools": ["delivery_status"], "tool_calls": 1})
    with phase("tool"):
        delivery = await commerce_tools().delivery()
    metadata["completion_evidence"] = "read_result"
    if not delivery.configured:
        text = "Delivery is available. Choose a delivery location at checkout for the final quote."
    elif delivery.deliverable:
        text = "Delivery is available for this location. Choose a delivery location at checkout for the final quote."
    else:
        text = "Delivery is not available for this location. Choose another delivery location or contact support."
    yield make_event("message.delta", text=text)
