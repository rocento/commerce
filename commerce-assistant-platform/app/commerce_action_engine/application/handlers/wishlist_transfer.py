"""Present typed wishlist transfer outcomes and preserve stream ordering."""

from collections.abc import AsyncGenerator, Callable, Iterator
from secrets import choice
from typing import assert_never

from app.commerce_action_engine.actions.customer import WishlistJourneyPort
from app.commerce_action_engine.actions.customer import wishlist_transfer as transfer
from app.commerce_action_engine.application.ports import EventFactory
from app.commerce_action_engine.application.responses import cart_block
from app.commerce_action_engine.contracts import AssistantEvent
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest


def _input_text(outcome: transfer.TransferNeedsInput) -> str:
    match outcome.reason:
        case "login_required":
            return "Please sign in to move wishlist items to your cart."
        case "incomplete_request":
            return (
                outcome.message
                or "Which wishlist item would you like to move to your cart?"
            )
        case "unsupported_selection":
            return "Please specify a complete wishlist transfer without additional conditions."
        case "missing_product":
            return "Which wishlist item would you like to move to your cart?"
        case "invalid_quantity":
            return "Please provide a quantity from 1 to 1000 before moving this wishlist item."
        case _:
            assert_never(outcome.reason)


def _transfer_block(items: list[dict[str, str]]) -> dict[str, object]:
    return {
        "kind": "wishlist_transfer",
        "title": "Wishlist transfer",
        "transfer_items": items,
    }


def _named_events(
    outcome: transfer.NamedTransferResult, make_event: EventFactory
) -> Iterator[AssistantEvent]:
    if isinstance(outcome, transfer.TransferNeedsInput):
        yield make_event("message.delta", text=_input_text(outcome))
        return
    if isinstance(outcome, transfer.TransferLookupFailed):
        text = "I couldn't confirm whether this wishlist item could be moved."
        status = "not_confirmed"
        detail = "Wishlist or catalog lookup failed; no cart or wishlist change was confirmed."
    elif isinstance(outcome, transfer.TransferNotMatched):
        text = "I couldn't move that wishlist item to your cart."
        status = "not_transferred"
        detail = (
            "No exact matching wishlist item was found."
            if outcome.reason == "not_found"
            else "More than one matching item was found; please use its full product name."
        )
    elif isinstance(outcome, transfer.TransferCartUnverified):
        if outcome.reason == "write_unavailable":
            text = "I couldn't confirm whether the item reached your cart. Please check your cart before trying again."
            status = "not_confirmed"
            detail = (
                "Cart update could not be confirmed. Check your cart before retrying."
            )
        else:
            text = "The cart did not confirm the item, so it remains in your wishlist."
            status = "not_transferred"
            detail = "The item was not present in the confirmed cart."
    elif isinstance(outcome, transfer.TransferRemovalUnverified):
        text = "The item was added to your cart, but I couldn't remove it from your wishlist."
        status = "not_confirmed"
        detail = "Added to cart; wishlist removal could not be confirmed."
    elif isinstance(outcome, transfer.TransferCompleted):
        text = f"Transferred {outcome.quantity} {outcome.name} to your cart."
        status = "transferred"
        detail = (
            f"Quantity {outcome.quantity} added to cart and removed from your wishlist."
        )
    else:
        assert_never(outcome)
    yield make_event("message.delta", text=text)
    yield make_event(
        "content.blocks",
        blocks=[
            _transfer_block(
                [{"name": outcome.name, "status": status, "detail": detail}]
            )
        ],
    )
    if isinstance(outcome, transfer.TransferCompleted):
        cart = outcome.cart
        yield make_event(
            "content.blocks",
            blocks=[
                {
                    "kind": "cart_summary",
                    "cart": {
                        "items": [item.model_dump(mode="json") for item in cart.items],
                        "total_lines": len(cart.items),
                        "total_quantity": sum(item.quantity for item in cart.items),
                        "subtotal": cart.subtotal,
                        "discount_amount": cart.discount_amount,
                        "currency": cart.currency,
                        "fully_reserved": cart.fully_reserved,
                    },
                }
            ],
        )


async def wishlist_transfer_events(
    *,
    authenticated: bool,
    request: InterpretedRequest,
    commerce_tools: Callable[[], WishlistJourneyPort],
    metadata: dict[str, object],
    make_event: EventFactory,
) -> AsyncGenerator[AssistantEvent, None]:
    metadata["route_reason"] = "wishlist_to_cart"
    admitted = transfer.admit_transfer(request, authenticated=authenticated)
    if isinstance(admitted, transfer.TransferNeedsInput):
        yield make_event(
            "message.delta",
            text=_input_text(admitted),
            **(
                {"code": "login_required"}
                if admitted.reason == "login_required"
                else {}
            ),
        )
        return
    tools = commerce_tools()
    if isinstance(admitted, transfer.SelectionTransferRequest):
        prepared = await transfer.prepare_selection(admitted, tools, choose=choice)
        if isinstance(prepared, transfer.SelectionStopped):
            texts = {
                "read_unavailable": "I couldn't load your wishlist. No items were moved.",
                "empty": "Your wishlist is empty. No items were moved.",
                "limit": "I can move at most 200 wishlist items in one request. No items were changed.",
            }
            yield make_event("message.delta", text=texts[prepared.reason])
            return
        metadata.update(
            {"tools": ["wishlist_read", "wishlist_cart_transfer"], "tool_calls": 1}
        )
        yield make_event(
            "message.delta",
            text=(
                "I picked one wishlist item at random."
                if prepared.selection == "RANDOM_SAVED"
                else f"I'll move all {len(prepared.product_ids)} wishlist items, one of each."
            ),
        )
        # This await must remain after the announcement yield. Closing the stream
        # at that yield cannot dispatch a write.
        outcome = await transfer.execute_selection(prepared, tools)
        metadata["tool_calls"] = 2
        if isinstance(outcome, transfer.SelectionUnverified):
            detail = "The transfer could not be confirmed. Check both your cart and wishlist before sending a new request."
            for start in range(0, len(outcome.product_ids), 5):
                yield make_event(
                    "content.blocks",
                    blocks=[
                        _transfer_block(
                            [
                                {
                                    "name": f"Wishlist item {product_id}",
                                    "status": "not_confirmed",
                                    "detail": detail,
                                }
                                for product_id in outcome.product_ids[start : start + 5]
                            ]
                        )
                    ],
                )
            yield make_event("message.delta", text=detail)
        elif isinstance(outcome, transfer.SelectionCompleted):
            for start in range(0, len(outcome.receipt.items), 5):
                yield make_event(
                    "content.blocks",
                    blocks=[
                        _transfer_block(
                            [
                                {
                                    "name": item.name,
                                    "status": item.status,
                                    "detail": item.detail,
                                }
                                for item in outcome.receipt.items[start : start + 5]
                            ]
                        )
                    ],
                )
            yield make_event(
                "content.blocks", blocks=[cart_block(outcome.receipt.cart)]
            )
        else:
            assert_never(outcome)
        return
    if not isinstance(admitted, transfer.NamedTransferRequest):
        assert_never(admitted)
    metadata.update(
        {
            "tools": ["wishlist_read", "shopper_read", "cart_write", "wishlist_write"],
            "tool_calls": 0,
        }
    )
    yield make_event("progress", stage="catalog")

    def record_completed_call(count: int) -> None:
        metadata["tool_calls"] = count

    result = await transfer.transfer_named(
        admitted, tools, record_completed_call=record_completed_call
    )
    for event in _named_events(result, make_event):
        yield event
