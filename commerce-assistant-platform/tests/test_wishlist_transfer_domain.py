"""Evidence, partial completion and cancellation across the transfer boundary."""

import asyncio
from uuid import UUID

import pytest
from test_wishlist_transfer import SelectionTools, Tools

from app.commerce_action_engine.actions.customer import wishlist_transfer as transfer
from app.commerce_action_engine.application.handlers.wishlist_transfer import (
    wishlist_transfer_events,
)
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable


class ObservedTools(Tools):
    def __init__(self, failure=None, error=ToolUnavailable):
        super().__init__()
        self.failure = failure
        self.error = error
        self.calls = []
        self.cart = None
        self.block_at = None
        self.entered = asyncio.Event()
        self.closed = asyncio.Event()

    async def observe(self, name):
        self.calls.append(name)
        if name == self.block_at:
            self.entered.set()
            try:
                await asyncio.Future()
            finally:
                self.closed.set()
        if name == self.failure:
            raise self.error()

    async def wishlist(self):
        await self.observe("wishlist")
        return await super().wishlist()

    async def search_cart_product(self, query):
        await self.observe("search")
        rows = await super().search_cart_product(query)
        if self.failure == "not_owned":
            rows[0]["id"] = str(UUID(int=0))
        elif self.failure == "not_exact":
            rows[0]["name"] = "Banana juice"
        elif self.failure == "ambiguous":
            rows *= 2
        return rows

    async def change_cart(self, change):
        await self.observe("cart")
        self.cart = await super().change_cart(change)
        if self.failure == "missing_cart_item":
            self.cart = self.cart.model_copy(update={"items": []})
        return self.cart

    async def remove_wishlist_item(self, product_id):
        await self.observe("remove")
        await super().remove_wishlist_item(product_id)

    async def transfer_wishlist_to_cart(self, product_ids):
        await self.observe("bulk")
        raise AssertionError("A blocked bulk write must not finish")


def named(tools, *, quantity=1, counts=None):
    return transfer.transfer_named(
        transfer.NamedTransferRequest("banana", quantity),
        tools,
        record_completed_call=(counts if counts is not None else []).append,
    )


@pytest.mark.parametrize(
    "failure,outcome,expected_calls",
    [
        ("wishlist", transfer.TransferLookupFailed, ["wishlist"]),
        ("search", transfer.TransferLookupFailed, ["wishlist", "search"]),
        ("not_owned", transfer.TransferNotMatched, ["wishlist", "search"]),
        ("not_exact", transfer.TransferNotMatched, ["wishlist", "search"]),
        ("ambiguous", transfer.TransferNotMatched, ["wishlist", "search"]),
        ("cart", transfer.TransferCartUnverified, ["wishlist", "search", "cart"]),
        (
            "missing_cart_item",
            transfer.TransferCartUnverified,
            ["wishlist", "search", "cart"],
        ),
        (
            "remove",
            transfer.TransferRemovalUnverified,
            ["wishlist", "search", "cart", "remove"],
        ),
        (None, transfer.TransferCompleted, ["wishlist", "search", "cart", "remove"]),
    ],
)
def test_named_outcomes_require_owned_product_and_distinguish_partial_success(
    failure, outcome, expected_calls
):
    tools = ObservedTools(failure)
    counts = []
    result = asyncio.run(named(tools, counts=counts))
    assert isinstance(result, outcome)
    assert tools.calls == expected_calls
    assert tools.removed == (failure is None)
    completed = len(expected_calls) - int(
        failure in {"wishlist", "search", "cart", "remove"}
    )
    assert counts == list(range(1, completed + 1))
    if isinstance(
        result, (transfer.TransferRemovalUnverified, transfer.TransferCompleted)
    ):
        assert result.cart is tools.cart
        assert result.cart.items[0].product_id == tools.product_id
        assert result.quantity == 1
    else:
        assert not hasattr(result, "cart")


@pytest.mark.parametrize("quantity", [True, False, 0, -1, 1001, 1.5, "2", None])
def test_invalid_quantity_preserves_read_order_but_never_dispatches(quantity):
    tools = ObservedTools()
    result = asyncio.run(named(tools, quantity=quantity))
    assert isinstance(result, transfer.TransferNeedsInput)
    assert result.reason == "invalid_quantity"
    assert tools.calls == ["wishlist", "search"]


@pytest.mark.parametrize("stage", ["wishlist", "search", "cart", "remove"])
def test_denial_propagates_with_completed_cart_evidence_only_after_add(stage):
    tools = ObservedTools(stage, ToolDenied)
    counts = []
    with pytest.raises(ToolDenied) as raised:
        asyncio.run(named(tools, counts=counts))
    assert raised.value.completed_action == ("cart_add" if stage == "remove" else None)
    assert (
        tools.calls
        == ["wishlist", "search", "cart", "remove"][: tools.calls.index(stage) + 1]
    )
    assert counts == list(range(1, len(tools.calls)))
    assert not tools.removed


@pytest.mark.parametrize(
    "count,selection",
    [(200, "ALL_SAVED"), (201, "ALL_SAVED"), (201, "RANDOM_SAVED"), (0, "ALL_SAVED")],
)
def test_selection_preparation_deduplicates_and_bounds_writes(count, selection):
    tools = SelectionTools(count=count)
    prepared = asyncio.run(
        transfer.prepare_selection(
            transfer.SelectionTransferRequest(selection),
            tools,
            choose=lambda ids: ids[-1],
        )
    )
    assert tools.writes == tools.removals == []
    if count == 0 or (count > 200 and selection == "ALL_SAVED"):
        assert isinstance(prepared, transfer.SelectionStopped)
        assert prepared.reason == ("empty" if count == 0 else "limit")
        return
    assert isinstance(prepared, transfer.PreparedSelection)
    expected = tools.ids[-1:] if selection == "RANDOM_SAVED" else tools.ids
    assert prepared.product_ids == tuple(expected)
    result = asyncio.run(transfer.execute_selection(prepared, tools))
    assert isinstance(result, transfer.SelectionCompleted)
    assert tools.writes == tools.removals == expected
    assert [item.product_id for item in result.receipt.items] == [
        str(i) for i in expected
    ]


def test_uncertain_bulk_write_is_an_explicit_outcome_without_retry():
    tools = SelectionTools(count=3, fail="add")
    calls = []
    original = tools.transfer_wishlist_to_cart

    async def write(ids):
        calls.append(ids)
        return await original(ids)

    tools.transfer_wishlist_to_cart = write
    prepared = transfer.PreparedSelection("ALL_SAVED", tuple(tools.ids))
    result = asyncio.run(transfer.execute_selection(prepared, tools))
    assert isinstance(result, transfer.SelectionUnverified)
    assert result.product_ids == prepared.product_ids
    assert calls == [tools.ids] and tools.removals == []


@pytest.mark.parametrize("stage", ["wishlist", "search", "cart", "remove", "bulk"])
def test_cancellation_closes_pending_operation_without_retry_or_successor(stage):
    async def run():
        tools = ObservedTools()
        tools.block_at = stage
        operation = (
            transfer.execute_selection(
                transfer.PreparedSelection("ALL_SAVED", (tools.product_id,)), tools
            )
            if stage == "bulk"
            else named(tools)
        )
        task = asyncio.create_task(operation)
        await asyncio.wait_for(tools.entered.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert tools.closed.is_set()
        expected = (
            ["bulk"] if stage == "bulk" else ["wishlist", "search", "cart", "remove"]
        )
        assert tools.calls == expected[: expected.index(stage) + 1]
        assert not tools.removed

    asyncio.run(run())


@pytest.mark.parametrize("selection", [None, "ALL_SAVED", "RANDOM_SAVED"])
def test_closing_stream_at_preparation_event_never_dispatches_a_write(selection):
    async def run():
        tools = ObservedTools()
        request = InterpretedRequest(
            request_id=str(UUID(int=1)),
            status="RESOLVED",
            legacy_intent="CART_MOVE_FROM_WISHLIST",
            message="Understood.",
            confidence={"raw": 0.99},
            entities={"sourceCollection": "wishlist", "destination": "cart"}
            | ({"selection": selection} if selection else {"productText": "banana"}),
        )
        metadata = {}
        stream = wishlist_transfer_events(
            authenticated=True,
            request=request,
            commerce_tools=lambda: tools,
            metadata=metadata,
            make_event=lambda kind, **fields: {"type": kind, **fields},
        )
        event = await anext(stream)
        assert event["type"] == ("message.delta" if selection else "progress")
        await stream.aclose()
        assert tools.calls == (["wishlist"] if selection else [])
        assert metadata["tool_calls"] == int(selection is not None)

    asyncio.run(run())
