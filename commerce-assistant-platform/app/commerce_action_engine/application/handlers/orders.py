"""Present admitted standard-contract order reads with the turn event factory.

The legacy_intent field preserves the intent used by the current route policy;
primary_intent may describe a different semantic head. Neither grants authority.
"""

import re
from collections.abc import AsyncGenerator, Callable
from uuid import UUID

from app.commerce_action_engine.actions.orders import (
    OrderReader,
    order_read,
    shipment_id,
)
from app.commerce_action_engine.application.ports import EventFactory
from app.commerce_action_engine.contracts import AssistantEvent
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.platform import phase
from app.commerce_action_engine.shared.errors import ToolUnavailable


async def order_events(
    *,
    authenticated: bool,
    request: InterpretedRequest,
    message: str,
    commerce_tools: Callable[[], OrderReader],
    metadata: dict[str, object],
    make_event: EventFactory,
    selected_id: UUID | None = None,
) -> AsyncGenerator[AssistantEvent, None]:
    if not authenticated:
        metadata["route_reason"] = "login_required"
        yield make_event(
            "message.delta",
            text="Please sign in to view your orders.",
            code="login_required",
        )
    else:
        yield make_event("progress", stage="order")
        query = order_read(message, request.entities, selected_id)
        number = query.number
        if number or query.order_id:
            metadata["route_reason"] = query.route_reason
            metadata.update({"tools": [query.tool_name], "tool_calls": 1})
            try:
                with phase("tool"):
                    order = (await query.execute(commerce_tools()))[0]
            except ToolUnavailable:
                if query.order_id:
                    raise
                yield make_event(
                    "message.delta",
                    text=f"I couldn’t find {f'order #{number}' if number else 'the selected order'} in your account. Check the order number or open My orders.",
                    code="unknown",
                )
            else:
                yield make_event("card.order", order=order.model_dump(mode="json"))
                text = f"Here are the details for order #{order.number}. Current status: {order.status.replace('_', ' ')}."
                if re.search(
                    r"\b(?:items|products|what did i buy|what is in)\b",
                    message,
                    re.IGNORECASE,
                ):
                    text += " This order summary does not include purchased items, so I can't list them here yet."
                elif re.search(
                    r"\b(?:total|cost|pay|paid|how much)\b", message, re.IGNORECASE
                ):
                    text = f"Order #{order.number} totals {order.total} {order.currency}, including delivery of {order.delivery_fee}."
                elif request.legacy_intent == "ORDER_CANCEL_ELIGIBILITY":
                    text += (
                        " Cancellation is available."
                        if order.cancellation_available
                        else " Cancellation is not currently available."
                    )
                elif request.legacy_intent in {"ORDER_DAMAGED", "ORDER_WRONG_ITEM"}:
                    text += " Open a support ticket below to report the issue for this order."
                yield make_event("message.delta", text=text)
        else:
            metadata["route_reason"] = query.route_reason
            metadata.update({"tools": [query.tool_name], "tool_calls": 1})
            with phase("tool"):
                orders = await query.execute(commerce_tools())
            latest_only = bool(
                re.search(
                    r"\b(?:last|latest|most\s+recent|newest)\s+order\b",
                    message,
                    re.IGNORECASE,
                )
            )
            orders = orders[:1] if latest_only or query.oldest else orders[:5]
            if not orders:
                yield make_event("message.delta", text="You don't have any orders yet.")
            else:
                for order in orders:
                    yield make_event("card.order", order=order.model_dump(mode="json"))
                if request.legacy_intent in {"ORDER_DAMAGED", "ORDER_WRONG_ITEM"}:
                    text = "I loaded your recent orders. Tell me which order has the issue and I can help you contact support."
                elif query.oldest:
                    order = orders[0]
                    text = f"Here are the details for your first order, #{order.number}. Current status: {order.status.replace('_', ' ')}."
                elif latest_only:
                    order = orders[0]
                    text = f"Here are the details for your latest order, #{order.number}. Current status: {order.status.replace('_', ' ')}."
                else:
                    text = f"Here are your {len(orders)} most recent orders. You can ask about a specific order for its latest status."
                yield make_event("message.delta", text=text)


async def shipment_events(
    message: str = "",
    *,
    authenticated: bool,
    request: InterpretedRequest,
    commerce_tools: Callable[[], OrderReader],
    metadata: dict[str, object],
    make_event: EventFactory,
    selected_id: UUID | None = None,
) -> AsyncGenerator[AssistantEvent, None]:
    if not authenticated:
        yield make_event(
            "message.delta",
            text="Please sign in to view shipment tracking details.",
            code="login_required",
        )
    else:
        try:
            query = order_read(message, request.entities, selected_id)
            parsed_order_id = shipment_id(request.entities) or query.order_id
        except ValueError:
            yield make_event(
                "message.delta",
                text="I couldn’t identify that order. Please choose it from your order history.",
            )
            return
        if parsed_order_id is None and query.number is None:
            yield make_event(
                "message.delta",
                text="Which order should I check? Please provide its order ID.",
            )
            return
        metadata["route_reason"] = "shipment_tracking_read"
        metadata.update({"tools": ["order_status"], "tool_calls": 1})
        try:
            if query.number:
                order = await commerce_tools().order_by_number(query.number)
            else:
                order = await commerce_tools().call(
                    "order_status", {"order_id": parsed_order_id}
                )
        except ToolUnavailable:
            yield make_event(
                "message.delta",
                text="I couldn’t load tracking for that order. Please try again or open My orders.",
                code="unavailable",
            )
        else:
            yield make_event("card.order", order=order.model_dump(mode="json"))
            if order.shipments:
                tracking = "\n".join(
                    f"{shipment.tracking_reference}: {shipment.status}"
                    for shipment in order.shipments
                )
                text = f"Shipment updates for order #{order.number}:\n{tracking}"
            else:
                text = f"Order #{order.number} has no shipment tracking details yet. Current status: {order.status.replace('_', ' ')}."
            yield make_event("message.delta", text=text)
