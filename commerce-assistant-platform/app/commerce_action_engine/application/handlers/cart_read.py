"""Present an admitted cart read using its authoritative domain result."""

from collections.abc import AsyncGenerator, Callable

from app.commerce_action_engine.actions.shopping.cart_read import CartReader, read_cart
from app.commerce_action_engine.application.ports import EventFactory
from app.commerce_action_engine.application.responses import (
    cart_block,
    cart_summary_text,
)
from app.commerce_action_engine.contracts import AssistantEvent
from app.commerce_action_engine.platform import phase


async def cart_read_events(
    *,
    authenticated: bool,
    commerce_tools: Callable[[], CartReader],
    metadata: dict[str, object],
    make_event: EventFactory,
) -> AsyncGenerator[AssistantEvent, None]:
    """Route policy, error mapping and reader lifetime remain with the turn."""
    if not authenticated:
        metadata["route_reason"] = "login_required"
        yield make_event(
            "message.delta",
            text="Please sign in to view your cart.",
            code="login_required",
        )
    else:
        metadata["route_reason"] = "cart_status"
        yield make_event("progress", stage="catalog")
        metadata.update({"tools": ["cart_read"], "tool_calls": 1})
        with phase("tool"):
            result = await read_cart(commerce_tools())
        text = cart_summary_text(result.cart)
        metadata["completion_evidence"] = "read_result"
        yield make_event("message.delta", text=text)
        yield make_event(
            "content.blocks",
            blocks=[
                cart_block(result.cart).model_dump(mode="json", exclude_unset=True)
            ],
        )
