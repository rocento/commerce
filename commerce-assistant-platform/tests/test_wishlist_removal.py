"""Owned wishlist selection, serial deletion and truthful partial outcomes."""

import asyncio
import json
from unittest.mock import AsyncMock, call
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414 -- pytest fixture
from test_shopping import product

from app.commerce_action_engine.actions.customer import wishlist_removal as removal
from app.commerce_action_engine.application.handlers.customer import wishlist_events
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.platform.telemetry import TurnTrace, phase, trace_turn
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable
from app.main import create_app

IDS = (UUID(int=101), UUID(int=102), UUID(int=103))


@pytest.mark.parametrize("count", [0, 100, 101])
def test_clear_uses_unique_owned_ids_and_stops_at_limit_without_writing(count):
    ids = tuple(UUID(int=i + 1) for i in range(count))
    tools = AsyncMock()
    tools.wishlist.return_value = []
    outcome = asyncio.run(removal.clear_wishlist(ids + ids, tools))
    if count == 0:
        assert isinstance(outcome, removal.WishlistEmpty) and tools.mock_calls == []
    elif count > 100:
        assert isinstance(outcome, removal.WishlistClearLimit)
        assert (outcome.count, outcome.limit) == (101, 100)
        assert tools.mock_calls == []
    else:
        assert isinstance(outcome, removal.WishlistClearCompleted)
        assert outcome.requested_ids == ids and outcome.remaining_ids == ()
        assert outcome.attempted_calls == 102  # Includes caller's initial read.
        assert tools.mock_calls == [call.remove_wishlist_item(id) for id in ids] + [
            call.wishlist()
        ]


@pytest.mark.parametrize(
    "remaining", [(), (UUID(int=999),), (IDS[1],), (IDS[1], UUID(int=999))]
)
def test_clear_verification_distinguishes_requested_items_from_concurrent_additions(
    remaining,
):
    tools = AsyncMock()
    tools.wishlist.return_value = list(remaining)
    outcome = asyncio.run(removal.clear_wishlist(IDS, tools))
    expected = (
        removal.WishlistClearRemaining
        if IDS[1] in remaining
        else removal.WishlistClearCompleted
    )
    assert isinstance(outcome, expected)
    assert outcome.requested_ids == IDS and outcome.remaining_ids == remaining
    assert outcome.attempted_calls == 5
    assert tools.mock_calls == [call.remove_wishlist_item(id) for id in IDS] + [
        call.wishlist()
    ]


@pytest.mark.parametrize("failed_index", [0, 1, 2])
def test_uncertain_clear_records_acknowledged_prefix_and_stops_all_successors(
    failed_index,
):
    tools = AsyncMock()
    tools.remove_wishlist_item.side_effect = [None] * failed_index + [ToolUnavailable()]
    outcome = asyncio.run(removal.clear_wishlist(IDS, tools))
    assert isinstance(outcome, removal.WishlistClearRemovalUnverified)
    assert outcome.requested_ids == IDS
    assert outcome.acknowledged_ids == IDS[:failed_index]
    assert outcome.uncertain_id == IDS[failed_index]
    assert outcome.attempted_calls == failed_index + 2
    assert tools.mock_calls == [
        call.remove_wishlist_item(id) for id in IDS[: failed_index + 1]
    ]


def test_final_read_failure_does_not_erase_acknowledgements_or_claim_empty():
    tools = AsyncMock()
    tools.wishlist.side_effect = ToolUnavailable()
    outcome = asyncio.run(removal.clear_wishlist(IDS, tools))
    assert isinstance(outcome, removal.WishlistClearVerificationUnavailable)
    assert outcome.acknowledged_ids == IDS and outcome.attempted_calls == 5
    assert not hasattr(outcome, "remaining_ids")
    assert tools.mock_calls == [call.remove_wishlist_item(id) for id in IDS] + [
        call.wishlist()
    ]


@pytest.mark.parametrize("stage", ["first", "second", "verify"])
def test_bulk_denial_propagates_original_error_without_retry_or_success_claim(stage):
    tools = AsyncMock()
    denied = ToolDenied()
    if stage == "verify":
        tools.wishlist.side_effect = denied
    else:
        tools.remove_wishlist_item.side_effect = [None] * (stage == "second") + [denied]
    with pytest.raises(ToolDenied) as caught:
        asyncio.run(removal.clear_wishlist(IDS, tools))
    assert caught.value is denied and denied.completed_action is None
    expected = [call.remove_wishlist_item(id) for id in IDS]
    expected = (
        expected + [call.wishlist()]
        if stage == "verify"
        else expected[: 2 if stage == "second" else 1]
    )
    assert tools.mock_calls == expected


@pytest.mark.parametrize(
    "reference,variant,expected",
    [
        ("Tea", "normal", removal.WishlistRemovalReady),
        ("sku-1", "normal", removal.WishlistRemovalReady),
        ("Tea", "duplicate", removal.WishlistRemovalReady),
        ("Te", "normal", removal.WishlistRemovalChoice),
        ("Tea", "ambiguous", removal.WishlistRemovalChoice),
        ("Tea", "foreign", removal.WishlistRemovalNotFound),
        ("Tea", "empty", removal.WishlistRemovalNotFound),
    ],
)
def test_selection_uses_exact_name_or_sku_within_owned_ids(
    reference, variant, expected
):
    first = {"id": str(IDS[0]), "name": "Tea", "sku": "SKU-1"}
    second = {"id": str(IDS[1]), "name": "Tea", "sku": "SKU-2"}
    foreign = {"id": str(UUID(int=999)), "name": "Tea", "sku": "SKU-1"}
    found = [foreign, first]
    if variant == "duplicate":
        found.append(first)
    if variant == "ambiguous":
        found.append(second)
    if variant == "foreign":
        found = [foreign]
    if variant == "empty":
        found = []
    selected = removal.match_removal(IDS, found, reference)
    assert isinstance(selected, expected)
    if isinstance(selected, removal.WishlistRemovalReady):
        assert selected.product_id == IDS[0] and selected.name == "Tea"
    elif isinstance(selected, removal.WishlistRemovalChoice):
        assert foreign not in selected.items
        assert selected.items == tuple(p for p in found if p is not foreign)


@pytest.mark.parametrize("fault", [None, ToolUnavailable, ToolDenied])
def test_single_result_and_tool_measurement_preserve_failure_truth(fault):
    tools = AsyncMock()
    tools.remove_wishlist_item.side_effect = fault() if fault else None
    trace = TurnTrace()

    async def scenario():
        with trace_turn(trace):
            return await removal.remove_selected(
                removal.WishlistRemovalReady(IDS[0], "Tea"),
                tools,
                measure_write=lambda: phase("tool"),
            )

    if fault == ToolDenied:
        with pytest.raises(ToolDenied):
            asyncio.run(scenario())
    else:
        outcome = asyncio.run(scenario())
        assert isinstance(
            outcome,
            removal.WishlistRemovalUnverified if fault else removal.WishlistRemoved,
        )
        assert outcome.product_id == IDS[0] and outcome.name == "Tea"
    assert tools.mock_calls == [call.remove_wishlist_item(IDS[0])]
    assert trace.totals["tool_count"] == 1
    assert trace.totals.get("tool_errors", 0) == int(fault is not None)
    assert trace.spans[0]["outcome"] == ("failed" if fault else "completed")


@pytest.mark.parametrize("stage", ["single", "first", "second", "verify"])
def test_cancellation_closes_pending_deletion_or_read_without_successor(stage):
    async def scenario():
        entered, closed = asyncio.Event(), asyncio.Event()
        tools = AsyncMock()
        count = 0

        async def wait(*args):
            entered.set()
            try:
                await asyncio.Future()
            finally:
                closed.set()

        async def delete(id):
            nonlocal count
            count += 1
            if (
                stage == "single"
                or stage == "first"
                or (stage == "second" and count == 2)
            ):
                await wait()

        tools.remove_wishlist_item.side_effect = delete
        if stage == "verify":
            tools.wishlist.side_effect = wait
        operation = (
            removal.remove_selected(removal.WishlistRemovalReady(IDS[0], "Tea"), tools)
            if stage == "single"
            else removal.clear_wishlist(IDS, tools)
        )
        task = asyncio.create_task(operation)
        await asyncio.wait_for(entered.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert closed.is_set()
        expected = [call.remove_wishlist_item(id) for id in IDS]
        expected = (
            expected + [call.wishlist()]
            if stage == "verify"
            else expected[: 2 if stage == "second" else 1]
        )
        assert tools.mock_calls == expected

    asyncio.run(scenario())


@pytest.mark.parametrize("reference", ["all", "Tea"])
def test_closing_after_progress_cannot_read_or_delete(reference):
    tools = AsyncMock()
    metadata = {}

    async def scenario():
        stream = wishlist_events(
            authenticated=True,
            managing=True,
            reference=reference,
            commerce_tools=lambda: tools,
            metadata=metadata,
            make_event=lambda kind, **fields: {"type": kind, **fields},
        )
        assert (await anext(stream))["type"] == "progress"
        await stream.aclose()

    asyncio.run(scenario())
    assert tools.mock_calls == [] and metadata == {"route_reason": "wishlist_read"}


@pytest.mark.parametrize(
    "mode",
    [
        "single",
        "single_unavailable",
        "single_denied",
        "clear",
        "clear_partial",
        "verify_unavailable",
        "retained",
        "concurrent_add",
        "clear_denied",
    ],
)
def test_removal_outcomes_through_public_sse(identity, monkeypatch, mode):
    config, request_id, headers = identity
    calls = []
    reads = 0
    deletions = 0
    reference = "Tea" if mode.startswith("single") else "all"

    async def resolve(url, text):
        return gate.Resolution(
            status="RESOLVED",
            intent="REMOVE_FROM_WISHLIST",
            confidence=1,
            message="",
            entities={"productText": reference},
        )

    def commerce(request):
        nonlocal reads, deletions
        calls.append((request.method, request.url.path))
        if request.method == "GET":
            assert (
                request.url.path.endswith("/wishlist")
                and request.headers["authorization"] == "Bearer read"
            )
            reads += 1
            if reads == 1:
                return httpx.Response(200, json=[str(id) for id in IDS])
            if mode == "verify_unavailable":
                return httpx.Response(503)
            remaining = (
                [IDS[1]]
                if mode == "retained"
                else [UUID(int=999)]
                if mode == "concurrent_add"
                else []
            )
            return httpx.Response(200, json=[str(id) for id in remaining])
        if request.method == "POST":
            assert (
                request.url.path.endswith("/shopper")
                and request.headers["authorization"] == "Bearer catalog"
            )
            return httpx.Response(
                200,
                json={
                    "products": [product(id=str(IDS[0]), name="Tea")],
                    "category": None,
                },
            )
        assert request.method == "DELETE" and request.url.path.endswith("/wishlist")
        assert request.headers["authorization"] == "Bearer remove"
        deletions += 1
        assert json.loads(request.content) == {"product_id": str(IDS[deletions - 1])}
        if mode == "single_unavailable" or (mode == "clear_partial" and deletions == 2):
            return httpx.Response(503)
        if mode == "single_denied" or (mode == "clear_denied" and deletions == 2):
            return httpx.Response(403)
        return httpx.Response(204)

    monkeypatch.setattr(gate, "resolve", resolve)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={
                **headers(),
                "x-commerce-wishlist-token": "read",
                "x-commerce-catalog-token": "catalog",
                "x-commerce-wishlist-write-token": "remove",
            },
            json={
                "request_id": request_id,
                "message": f"remove {reference} from wishlist",
            },
        )
    assert response.status_code == 200
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert events[-1]["type"] == "done" and [e["sequence"] for e in events] == list(
        range(len(events))
    )
    text = "".join(e.get("text", "") for e in events)
    assert ("now empty" in text) == (mode == "clear")
    assert ("Removed Tea" in text) == (mode == "single")
    if "denied" in mode:
        assert "current access does not allow" in text
    if mode in {"clear_partial", "verify_unavailable"}:
        assert "Some items may have been removed" in text
    if mode == "retained":
        assert "still saved" in text
    if mode == "concurrent_add":
        assert "wishlist still contains items" in text
    assert reads == (
        2
        if mode in {"clear", "verify_unavailable", "retained", "concurrent_add"}
        else 1
    )
    assert deletions == (
        1
        if mode.startswith("single")
        else 2
        if mode in {"clear_partial", "clear_denied"}
        else 3
    )
    assert all("/cart" not in path for _, path in calls)
