"""Cart reads use a read-only port and leave admission/lifecycle to the turn."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import UUID

import pytest
from test_cart_actions import snapshot
from test_cart_handler import collect

from app.commerce_action_engine.application.handlers.cart_read import cart_read_events
from app.commerce_action_engine.contracts import AssistantEvent
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable


def stream_for(factory, *, authenticated=True):
    emitted, metadata = [], {}

    def event(kind, **fields):
        result = AssistantEvent.model_validate(
            {
                "version": "1",
                "request_id": UUID(int=1),
                "sequence": 5 + len(emitted),
                "type": kind,
                **fields,
            }
        )
        emitted.append(result)
        return result

    return (
        cart_read_events(
            authenticated=authenticated,
            commerce_tools=factory,
            metadata=metadata,
            make_event=event,
        ),
        emitted,
        metadata,
    )


@pytest.mark.parametrize("quantity", [0, 3])
def test_empty_and_populated_reads_preserve_counts_and_completion(quantity):
    # This port deliberately has no mutation, catalog or delivery methods.
    reader = SimpleNamespace(cart=AsyncMock(return_value=snapshot(quantity)))
    stream, _, metadata = stream_for(lambda: reader)
    events = asyncio.run(collect(stream))
    assert [event.type for event in events] == [
        "progress",
        "message.delta",
        "content.blocks",
    ]
    assert [event.sequence for event in events] == [5, 6, 7]
    assert events[0].stage == "catalog"
    assert events[1].text and ("empty" in events[1].text) == (quantity == 0)
    blocks = events[2].blocks
    assert len(blocks) == 1 and blocks[0].kind == "cart_summary"
    assert blocks[0].cart.total_quantity == quantity
    assert blocks[0].cart.total_lines == int(quantity > 0)
    assert metadata == {
        "route_reason": "cart_status",
        "tools": ["cart_read"],
        "tool_calls": 1,
        "completion_evidence": "read_result",
    }
    reader.cart.assert_awaited_once_with()


def test_verified_snapshot_preserves_exact_text_and_cart_block():
    cart = snapshot(3).model_copy(
        update={
            "subtotal": "7.50",
            "discount_amount": "1.25",
            "fully_reserved": False,
        }
    )
    reader = SimpleNamespace(cart=AsyncMock(return_value=cart))
    stream, _, _ = stream_for(lambda: reader)
    events = asyncio.run(collect(stream))
    assert events[1].text == (
        "Your cart has 3 items. Subtotal: 7.50 USD. Total discount: 1.25 USD. "
        "Cart total after discount: 6.25 USD (before tax and delivery). "
        "Tax, delivery fees, and the final payable total are calculated at checkout. "
        "Some items are not currently reserved; review your cart before checkout."
    )
    assert events[2].blocks[0].model_dump(mode="json", exclude_unset=True) == {
        "kind": "cart_summary",
        "cart": {
            **cart.model_dump(mode="json"),
            "total_lines": 1,
            "total_quantity": 3,
        },
    }


def test_guest_does_not_construct_reader_or_mark_read_complete():
    factory = Mock(side_effect=AssertionError("Guest constructed commerce reader"))
    stream, _, metadata = stream_for(factory, authenticated=False)
    events = asyncio.run(collect(stream))
    assert [(event.type, event.code, event.text) for event in events] == [
        ("message.delta", "login_required", "Please sign in to view your cart.")
    ]
    assert metadata == {"route_reason": "login_required"}
    factory.assert_not_called()


@pytest.mark.parametrize("error_type", [ToolDenied, ToolUnavailable])
def test_failed_read_propagates_without_retry_or_completion(error_type):
    error = error_type()
    reader = SimpleNamespace(cart=AsyncMock(side_effect=error))
    stream, emitted, metadata = stream_for(lambda: reader)
    with pytest.raises(error_type) as caught:
        asyncio.run(collect(stream))
    assert caught.value is error
    assert [event.type for event in emitted] == ["progress"]
    assert "completion_evidence" not in metadata
    reader.cart.assert_awaited_once_with()


def test_close_after_progress_never_starts_read():
    factory = Mock(side_effect=AssertionError("Closed stream constructed reader"))
    stream, emitted, metadata = stream_for(factory)

    async def scenario():
        assert (await anext(stream)).type == "progress"
        await stream.aclose()
        with pytest.raises(StopAsyncIteration):
            await anext(stream)

    asyncio.run(scenario())
    assert len(emitted) == 1
    assert metadata == {"route_reason": "cart_status"}
    factory.assert_not_called()


def test_constructing_stream_leaves_metadata_and_reader_untouched():
    factory = Mock(side_effect=AssertionError("Unconsumed stream constructed reader"))
    stream, emitted, metadata = stream_for(factory)
    assert emitted == []
    assert metadata == {}
    factory.assert_not_called()
    asyncio.run(stream.aclose())


def test_cancelled_read_propagates_without_result_or_completion():
    async def scenario():
        entered, stopped = asyncio.Event(), asyncio.Event()

        async def read():
            entered.set()
            try:
                await asyncio.Future()
            finally:
                stopped.set()

        reader = SimpleNamespace(cart=AsyncMock(side_effect=read))
        stream, emitted, metadata = stream_for(lambda: reader)
        pending = asyncio.create_task(collect(stream))
        await asyncio.wait_for(entered.wait(), timeout=1)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        assert stopped.is_set()
        assert [event.type for event in emitted] == ["progress"]
        assert "completion_evidence" not in metadata
        reader.cart.assert_awaited_once_with()

    asyncio.run(scenario())
