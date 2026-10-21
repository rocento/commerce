"""Start a customer-owned reorder review; chat never places an order directly."""

from collections.abc import AsyncGenerator, Callable
from uuid import UUID

from app.commerce_action_engine.actions.orders import OrderReader, reorder_read
from app.commerce_action_engine.application.ports import EventFactory
from app.commerce_action_engine.contracts import AssistantEvent
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.shared.errors import ToolUnavailable


async def reorder_events(
    *,
    request: InterpretedRequest,
    commerce_tools: Callable[[], OrderReader],
    selected_id: UUID | None,
    authenticated: bool,
    make_event: EventFactory,
) -> AsyncGenerator[AssistantEvent, None]:
    if not authenticated:
        yield make_event(
            "message.delta",
            text="Please sign in to reorder from your order history.",
            code="login_required",
        )
        return
    query = reorder_read(request.entities, selected_id)
    if query is None:
        yield make_event(
            "message.delta",
            text="Please choose a valid order number from your order history.",
        )
        return
    yield make_event("progress", stage="order")
    try:
        orders = await query.execute(commerce_tools())
    except ToolUnavailable:
        yield make_event(
            "message.delta",
            text="I couldn’t load that order from your account. Check its number or choose an order from your history. No new order was placed.",
        )
        return
    if not orders:
        yield make_event(
            "message.delta",
            text="I couldn't find a previous order to reorder in your account.",
        )
        return
    for order in orders[:10]:
        yield make_event("card.order", order=order.model_dump(mode="json"))
    yield make_event(
        "message.delta",
        text="Choose Reorder on the order you want to repeat. If your cart is empty, I’ll rebuild it using current prices and availability. Otherwise, choose whether to keep the cart and add the order items or clear it and rebuild. You’ll see the resulting cart. An unchanged original delivery address can be reused; a different default or changed address needs confirmation. Unavailable or changed products need your choice. You’ll confirm the final total and delivery at checkout; no new order has been placed.",
    )
