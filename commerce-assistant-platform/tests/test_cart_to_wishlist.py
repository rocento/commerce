"""Typed wishlist outcomes preserve authority, partial completion and exact quantities."""

import asyncio
import json
from unittest.mock import AsyncMock, call
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414 -- pytest fixture
from test_cart_actions import ID, NAME, snapshot
from test_interpreted_cart_actions import request_for
from test_shopping import product

from app.commerce_action_engine.actions.customer import cart_to_wishlist as wishlist
from app.commerce_action_engine.application.handlers.cart import cart_events
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable
from app.main import create_app


def tools_for(*, owned=2, remaining=0):
    tools = AsyncMock()
    tools.cart.return_value = snapshot(owned)
    tools.change_cart.return_value = snapshot(remaining)
    tools.search_cart_product.return_value = [{"id": ID, "name": NAME}]
    return tools


def run(tools, *, intent="CART_MOVE_TO_WISHLIST", entities=None, **updates):
    return asyncio.run(
        wishlist.execute(
            request_for(
                intent,
                entities={"productText": NAME, "destination": "wishlist"}
                if entities is None
                else entities,
                **updates,
            ),
            f"{'move' if intent == 'CART_MOVE_TO_WISHLIST' else 'save'} {NAME} to wishlist",
            tools,
        )
    )


@pytest.mark.parametrize(
    "updates",
    [
        {"status": "UNKNOWN"},
        {"status": "NEEDS_CONTEXT"},
        {"status": "AMBIGUOUS"},
        {"status": "DENIED"},
        {"status": "UNSUPPORTED"},
        {"confidence": {"raw": 0.64, "calibrated": 1}},
        {"missing": ["product"]},
        {"request_type": "COMPOUND"},
        {"entities": {"productText": NAME, "price": 2}},
        {"entities": {"productText": NAME, "destination": "cart"}},
        {"entities": {"productText": NAME, "material": "silver"}},
        {"intent": "CLEAR_CART"},
    ],
)
def test_unadmitted_wishlist_requests_cannot_even_read(updates):
    tools = tools_for()
    result = run(tools, **updates)
    assert isinstance(result, wishlist.WishlistNeedsInput)
    assert result.cart is None and tools.mock_calls == []


@pytest.mark.parametrize("quantity", [True, False, 0, -1, 3, 1.5, "1"])
def test_invalid_source_quantity_stops_before_destination_write(quantity):
    tools = tools_for()
    result = run(tools, entities={"productText": NAME, "quantity": quantity})
    assert isinstance(result, wishlist.WishlistNeedsInput)
    assert result.cart is tools.cart.return_value
    assert tools.mock_calls == [call.cart()]


@pytest.mark.parametrize("quantity,remaining", [(None, 0), (1, 1), (2, 0)])
def test_move_completion_requires_exact_quantity_in_authoritative_cart(
    quantity, remaining
):
    tools = tools_for(remaining=remaining)
    result = run(tools, entities={"productText": NAME, "quantity": quantity})
    assert isinstance(result, wishlist.WishlistMoved)
    assert result.product_id == UUID(ID) and result.removed_quantity == 2 - remaining
    assert result.cart is tools.change_cart.return_value
    command = {"action": "remove", "product_id": ID}
    if quantity is not None:
        command["quantity"] = quantity
    assert tools.mock_calls == [
        call.cart(),
        call.add_wishlist_item(UUID(ID)),
        call.change_cart(command),
    ]


@pytest.mark.parametrize("remaining", [0, 2, 3])
def test_mismatched_cart_receipt_never_becomes_completed_move(remaining):
    tools = tools_for(remaining=remaining)
    result = run(tools, entities={"productText": NAME, "quantity": 1})
    assert isinstance(result, wishlist.WishlistRemovalMismatch)
    assert (result.expected_remaining, result.actual_remaining) == (1, remaining)
    assert result.cart is tools.change_cart.return_value
    tools.add_wishlist_item.assert_awaited_once()
    tools.change_cart.assert_awaited_once()


@pytest.mark.parametrize("stage", ["add_wishlist_item", "change_cart"])
def test_uncertain_writes_preserve_completed_destination_and_never_retry(stage):
    tools = tools_for()
    getattr(tools, stage).side_effect = ToolUnavailable()
    result = run(tools)
    if stage == "add_wishlist_item":
        assert isinstance(result, wishlist.WishlistAddUnverified)
        assert result.cart is tools.cart.return_value and result.product_id == UUID(ID)
        tools.change_cart.assert_not_awaited()
    else:
        assert isinstance(result, wishlist.WishlistRemovalUnverified)
        assert result.product_id == UUID(ID) and result.name == NAME
        assert not hasattr(result, "cart")  # Never offer the stale pre-write snapshot.
        tools.change_cart.assert_awaited_once()
    tools.add_wishlist_item.assert_awaited_once()


@pytest.mark.parametrize("stage", ["cart", "add_wishlist_item", "change_cart"])
def test_denial_preserves_completed_wishlist_step_only_after_acknowledgement(stage):
    tools = tools_for()
    denied = ToolDenied()
    getattr(tools, stage).side_effect = denied
    with pytest.raises(ToolDenied) as caught:
        run(tools)
    assert caught.value is denied
    assert denied.completed_action == (
        "wishlist_add" if stage == "change_cart" else None
    )
    names = [entry[0] for entry in tools.mock_calls]
    ordered = ["cart", "add_wishlist_item", "change_cart"]
    assert names == ordered[: ordered.index(stage) + 1]


def test_save_is_distinct_from_move_and_still_checks_current_catalog_identity():
    tools = tools_for()
    result = run(tools, intent="ADD_TO_WISHLIST")
    assert isinstance(result, wishlist.WishlistSaved)
    assert result.cart is tools.cart.return_value and result.product_id == UUID(ID)
    assert tools.mock_calls == [
        call.cart(),
        call.search_cart_product(NAME),
        call.add_wishlist_item(UUID(ID)),
    ]


@pytest.mark.parametrize("selected", [False, True])
def test_missing_owned_source_cannot_be_replaced_by_catalog_selection(selected):
    tools = tools_for(owned=0)
    result = asyncio.run(
        wishlist.execute(
            request_for("CART_MOVE_TO_WISHLIST"),
            f"move {NAME} to wishlist",
            tools,
            selected_product=product(id=ID, name=NAME) if selected else None,
        )
    )
    assert isinstance(result, wishlist.WishlistNeedsInput)
    assert tools.mock_calls == [call.cart()]


@pytest.mark.parametrize("count", [0, 8])
def test_missing_or_ambiguous_catalog_names_return_bounded_choices_without_writes(
    count,
):
    tools = tools_for(owned=0)
    rows = [
        {"id": str(UUID(int=i + 10)), "name": f"Different product {i}"}
        for i in range(count)
    ]
    tools.search_cart_product.return_value = rows + rows[:1]
    result = run(tools, intent="ADD_TO_WISHLIST")
    if count:
        assert isinstance(result, wishlist.WishlistNeedsChoice)
        assert result.choices == tuple(rows[:5])
    else:
        assert isinstance(result, wishlist.WishlistNotFound)
    assert tools.mock_calls == [call.cart(), call.search_cart_product(NAME)]


@pytest.mark.parametrize(
    "stage", ["cart", "search_cart_product", "add_wishlist_item", "change_cart"]
)
def test_cancellation_stops_pending_operation_and_cannot_run_successors(stage):
    async def scenario():
        tools = tools_for()
        entered, closed = asyncio.Event(), asyncio.Event()

        async def wait(*args):
            entered.set()
            try:
                await asyncio.Future()
            finally:
                closed.set()

        getattr(tools, stage).side_effect = wait
        intent = (
            "ADD_TO_WISHLIST"
            if stage == "search_cart_product"
            else "CART_MOVE_TO_WISHLIST"
        )
        task = asyncio.create_task(
            wishlist.execute(request_for(intent), f"save {NAME} to wishlist", tools)
        )
        await asyncio.wait_for(entered.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert closed.is_set()
        ordered = (
            ["cart", "search_cart_product"]
            if stage == "search_cart_product"
            else ["cart", "add_wishlist_item", "change_cart"]
        )
        assert [entry[0] for entry in tools.mock_calls] == ordered[
            : ordered.index(stage) + 1
        ]

    asyncio.run(scenario())


def test_closing_handler_after_message_does_not_repeat_writes_or_emit_blocks():
    tools = tools_for(remaining=1)
    emitted = []

    async def scenario():
        stream = cart_events(
            authenticated=True,
            request=request_for("CART_MOVE_TO_WISHLIST"),
            message=f"move {NAME} to wishlist",
            selection=None,
            commerce_tools=lambda: tools,
            metadata={},
            make_event=lambda kind, **fields: (
                emitted.append({"type": kind, **fields}) or emitted[-1]
            ),
        )
        first = await anext(stream)
        assert first["type"] == "message.delta" and first["text"].startswith("Moved")
        await stream.aclose()
        with pytest.raises(StopAsyncIteration):
            await anext(stream)

    asyncio.run(scenario())
    assert len(emitted) == 1
    tools.add_wishlist_item.assert_awaited_once()
    tools.change_cart.assert_awaited_once()


@pytest.mark.parametrize(
    "failure",
    [None, "save_unavailable", "remove_unavailable", "remove_denied", "mismatch"],
)
def test_partial_move_truth_and_cart_visibility_through_public_sse(
    identity, monkeypatch, failure
):
    config, request_id, headers = identity
    calls = []

    async def resolve(url, text):
        return gate.Resolution(
            status="RESOLVED",
            intent="CART_MOVE_TO_WISHLIST",
            confidence=1,
            message="",
            entities={"productText": NAME, "quantity": 1, "destination": "wishlist"},
        )

    def commerce(request):
        calls.append((request.method, request.url.path))
        if request.method == "GET":
            assert (
                request.url.path.endswith("/cart")
                and request.headers["authorization"] == "Bearer read"
            )
            return httpx.Response(200, json=snapshot(2).model_dump(mode="json"))
        if request.url.path.endswith("/wishlist"):
            assert request.headers["authorization"] == "Bearer save"
            assert json.loads(request.content) == {"product_id": ID}
            return httpx.Response(503 if failure == "save_unavailable" else 204)
        assert (
            request.url.path.endswith("/cart")
            and request.headers["authorization"] == "Bearer remove"
        )
        assert json.loads(request.content) == {
            "action": "remove",
            "product_id": ID,
            "quantity": 1,
        }
        if failure in {"remove_unavailable", "remove_denied"}:
            return httpx.Response(503 if failure == "remove_unavailable" else 403)
        return httpx.Response(
            200,
            json=snapshot(2 if failure == "mismatch" else 1).model_dump(mode="json"),
        )

    monkeypatch.setattr(gate, "resolve", resolve)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={
                **headers(),
                "x-commerce-cart-token": "read",
                "x-commerce-wishlist-write-token": "save",
                "x-commerce-cart-write-token": "remove",
            },
            json={"request_id": request_id, "message": f"move 1 {NAME} to wishlist"},
        )
    assert response.status_code == 200
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert events[-1]["type"] == "done"
    assert [e["sequence"] for e in events] == list(range(len(events)))
    text = "".join(e.get("text", "") for e in events)
    assert ("Moved " in text) == (failure is None)
    if failure == "remove_denied":
        assert "saved to your wishlist, but cart removal was denied" in text
    elif failure in {"remove_unavailable", "mismatch"}:
        assert "saved to your wishlist" in text
    blocks = [b for e in events for b in e.get("blocks", [])]
    assert any(b["kind"] == "cart_summary" for b in blocks) == (
        failure in {None, "save_unavailable", "mismatch"}
    )
    assert calls == [
        ("GET", "/v1/assistant-tools/cart"),
        ("POST", "/v1/assistant-tools/wishlist"),
    ] + (
        [] if failure == "save_unavailable" else [("POST", "/v1/assistant-tools/cart")]
    )
