"""The cart handler presents outcomes without taking over turn lifecycle policy."""

import asyncio
from contextlib import aclosing
from unittest.mock import AsyncMock
from uuid import UUID

import pytest
from test_cart_actions import ID, NAME, snapshot
from test_interpreted_cart_actions import request_for

from app.commerce_action_engine.application.handlers.cart import (
    CartSelection,
    cart_events,
)
from app.commerce_action_engine.contracts import AssistantEvent
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable


def stream_for(
    tools, *, authenticated=True, intent="CLEAR_CART", updates=None, selection=None
):
    emitted = []
    metadata = {"route_reason": "existing_route"}

    def event(kind, **fields):
        value = AssistantEvent.model_validate(
            {
                "version": "1",
                "request_id": UUID(int=1),
                "sequence": 10 + len(emitted),
                "type": kind,
                **fields,
            }
        )
        emitted.append(value)
        return value

    return (
        cart_events(
            authenticated=authenticated,
            request=request_for(intent, **({"entities": {}} | (updates or {}))),
            message="clear my cart",
            selection=selection,
            commerce_tools=lambda: tools,
            metadata=metadata,
            make_event=event,
        ),
        emitted,
        metadata,
    )


async def collect(stream):
    async with aclosing(stream):
        return [event async for event in stream]


def test_guest_prompt_does_not_touch_commerce_or_replace_turn_metadata():
    tools = AsyncMock()
    stream, _, metadata = stream_for(tools, authenticated=False)
    events = asyncio.run(collect(stream))
    assert [(event.type, event.code) for event in events] == [
        ("message.delta", "login_required")
    ]
    assert metadata == {"route_reason": "existing_route"}
    assert tools.mock_calls == []


def test_cart_unavailable_is_presented_once_without_a_write_or_done_event():
    tools = AsyncMock()
    tools.cart.side_effect = ToolUnavailable()
    stream, _, metadata = stream_for(tools)
    events = asyncio.run(collect(stream))
    assert [event.type for event in events] == ["message.delta", "content.blocks"]
    assert [event.sequence for event in events] == [10, 11]
    assert (
        events[0].text
        == "I couldn't load your cart. Please try again or open your cart."
    )
    assert [(block.kind, block.text) for block in events[1].blocks] == [
        ("text", events[0].text)
    ]
    assert metadata["route_reason"] == "cart_action"
    tools.cart.assert_awaited_once()
    tools.change_cart.assert_not_awaited()


@pytest.mark.parametrize("result", ["completed", "unavailable", "mismatch"])
def test_removal_receipts_are_presented_only_after_verified_completion(result):
    tools = AsyncMock()
    tools.cart.return_value = snapshot(3)
    tools.change_cart.return_value = snapshot(0 if result == "completed" else 3)
    if result == "unavailable":
        tools.change_cart.side_effect = ToolUnavailable()
    stream, _, _ = stream_for(
        tools,
        intent="REMOVE_FROM_CART",
        updates={"entities": {"productText": NAME, "quantity": 3}},
        selection=CartSelection(UUID(ID), "REMOVE_FROM_CART", confirmed=True),
    )
    events = asyncio.run(collect(stream))
    assert [event.type for event in events] == ["message.delta", "content.blocks"]
    assert [block.kind for block in events[1].blocks] == {
        "completed": ["cart_removal"],
        "unavailable": ["text"],
        "mismatch": ["text", "cart_summary"],
    }[result]
    if result == "completed":
        assert events[0].text == f"Removed 3 × {NAME} from your cart."
        assert events[1].blocks[0].cart_removal.quantity == 3
    else:
        assert "confirm" in events[0].text
        assert events[1].blocks[0].text == events[0].text
    tools.change_cart.assert_awaited_once_with(
        {"action": "remove", "product_id": ID, "quantity": 3}
    )


def test_removal_confirmation_keeps_choice_block_without_writing():
    tools = AsyncMock()
    tools.cart.return_value = snapshot(3)
    stream, _, _ = stream_for(
        tools,
        intent="REMOVE_FROM_CART",
        updates={"entities": {"productText": NAME}},
    )
    events = asyncio.run(collect(stream))
    assert [block.kind for block in events[1].blocks] == ["cart_removal_choice"]
    choice = events[1].blocks[0].cart_removal_choice
    assert choice.quantity is None and choice.items == tools.cart.return_value.items
    assert events[0].text == f"Please confirm removal of 3 × {NAME} from your cart."
    tools.change_cart.assert_not_awaited()


@pytest.mark.parametrize("stage", ["delivery", "cart"])
def test_denial_propagates_to_turn_with_original_partial_completion(stage):
    tools = AsyncMock()
    tools.delivery_headers = {}
    denial = ToolDenied()
    denial.completed_action = "wishlist_add"
    getattr(tools, stage).side_effect = denial
    stream, emitted, _ = stream_for(
        tools, intent="ADD_TO_CART" if stage == "delivery" else "CLEAR_CART"
    )
    with pytest.raises(ToolDenied) as caught:
        asyncio.run(collect(stream))
    assert caught.value is denial
    assert caught.value.completed_action == "wishlist_add"
    assert emitted == []
    tools.change_cart.assert_not_awaited()


def test_delivery_failure_still_belongs_to_outer_turn_error_mapping():
    tools = AsyncMock()
    tools.delivery_headers = {}
    failure = ToolUnavailable()
    tools.delivery.side_effect = failure
    stream, emitted, _ = stream_for(tools, intent="ADD_TO_CART")
    with pytest.raises(ToolUnavailable) as caught:
        asyncio.run(collect(stream))
    assert caught.value is failure and emitted == []
    tools.cart.assert_not_awaited()
    tools.change_cart.assert_not_awaited()


def test_cancelled_cart_read_stops_before_mutation_and_propagates():
    async def scenario():
        entered, stopped = asyncio.Event(), asyncio.Event()
        tools = AsyncMock()

        async def read():
            entered.set()
            try:
                await asyncio.Future()
            finally:
                stopped.set()

        tools.cart.side_effect = read
        stream, emitted, _ = stream_for(tools)
        pending = asyncio.create_task(collect(stream))
        await asyncio.wait_for(entered.wait(), timeout=1)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        assert stopped.is_set() and emitted == []
        tools.cart.assert_awaited_once()
        tools.change_cart.assert_not_awaited()

    asyncio.run(scenario())


def test_closing_after_message_does_not_emit_blocks_or_repeat_mutation():
    tools = AsyncMock()
    tools.cart.return_value = snapshot(2)
    tools.change_cart.return_value = snapshot(0)
    stream, emitted, _ = stream_for(tools)

    async def scenario():
        async with aclosing(stream):
            event = await anext(stream)
            assert event.type == "message.delta" and "cleared" in event.text.lower()
        with pytest.raises(StopAsyncIteration):
            await anext(stream)

    asyncio.run(scenario())
    assert len(emitted) == 1
    tools.change_cart.assert_awaited_once_with({"action": "clear"})


@pytest.mark.parametrize(
    "intent", ["START_CHECKOUT", "CONTINUE_CHECKOUT", "CREATE_ORDER"]
)
@pytest.mark.parametrize("quantity", [0, 2])
def test_checkout_handoff_requires_nonempty_owned_cart(intent, quantity):
    tools = AsyncMock()
    tools.cart.return_value = snapshot(quantity)
    stream, _, _ = stream_for(tools, intent=intent)
    events = asyncio.run(collect(stream))
    assert events[0].code == ("open_checkout" if quantity else None)
    assert events[1].blocks[-1].kind == "cart_summary"
    tools.cart.assert_awaited_once()
    tools.change_cart.assert_not_awaited()


@pytest.mark.parametrize(
    "updates",
    [
        {"status": "NEEDS_CONTEXT"},
        {"confidence": {"raw": 0.64}},
        {"request_type": "COMPOUND"},
        {"missing": ["product"]},
        {"entities": {"requestConstraints": {"conditional": True}}},
        {"entities": {"productText": "bananas", "quantity": 2}},
    ],
)
def test_held_or_product_bearing_checkout_never_opens_ui(updates):
    tools = AsyncMock()
    tools.cart.return_value = snapshot(2)
    stream, _, _ = stream_for(tools, intent="START_CHECKOUT", updates=updates)
    assert all(event.code != "open_checkout" for event in asyncio.run(collect(stream)))
    tools.change_cart.assert_not_awaited()


@pytest.mark.parametrize("authenticated", [False, True])
def test_guest_or_unavailable_cart_never_opens_checkout(authenticated):
    tools = AsyncMock()
    tools.cart.side_effect = ToolUnavailable()
    stream, _, _ = stream_for(
        tools, intent="START_CHECKOUT", authenticated=authenticated
    )
    assert all(event.code != "open_checkout" for event in asyncio.run(collect(stream)))
    tools.change_cart.assert_not_awaited()


def test_unverified_mutation_emits_only_uncertainty_without_stale_cart_or_retry():
    tools = AsyncMock()
    tools.cart.return_value = snapshot(2)
    tools.change_cart.side_effect = ToolUnavailable()
    stream, _, metadata = stream_for(tools)
    events = asyncio.run(collect(stream))
    text = "I couldn't confirm the cart update. [Open your cart](/cart) to check its current contents before trying again."
    assert [(event.type, event.sequence, event.code) for event in events] == [
        ("message.delta", 10, None),
        ("content.blocks", 11, None),
    ]
    assert events[0].text == text
    assert [(block.kind, block.text) for block in events[1].blocks] == [("text", text)]
    assert metadata["route_reason"] == "cart_action"
    tools.cart.assert_awaited_once()
    tools.change_cart.assert_awaited_once_with({"action": "clear"})
