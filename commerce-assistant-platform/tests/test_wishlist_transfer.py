import asyncio
import json
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414 -- pytest fixture

from app.commerce_action_engine.actions.customer.transfers import (
    WishlistTransferItem,
    WishlistTransferReceipt,
)
from app.commerce_action_engine.application.handlers.wishlist_transfer import (
    wishlist_transfer_events,
)
from app.commerce_action_engine.contracts import AssistantCart, AssistantCartItem
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.language import gate as language_gate
from app.commerce_action_engine.execution.language.gate import Resolution
from app.main import create_app


class Tools:
    def __init__(self, *, removal_fails=False):
        self.product_id = uuid4()
        self.removal_fails = removal_fails
        self.removed = False

    async def wishlist(self):
        return [self.product_id]

    async def search_cart_product(self, query):
        assert query == "banana"
        return [{"id": str(self.product_id), "name": "Banana"}]

    async def change_cart(self, change):
        assert change["product_id"] == str(self.product_id)
        return AssistantCart(
            items=[
                AssistantCartItem(
                    product_id=self.product_id,
                    name="Banana",
                    price="1",
                    currency="EGP",
                    quantity=1,
                    line_total="1",
                )
            ],
            subtotal="1",
            discount_amount="0",
            currency="EGP",
            fully_reserved=True,
        )

    async def remove_wishlist_item(self, product_id):
        if self.removal_fails:
            from app.commerce_action_engine.shared.errors import ToolUnavailable

            raise ToolUnavailable()
        self.removed = product_id == self.product_id


def run_transfer(
    tools, *, authenticated=True, status="RESOLVED", entities=None, **changes
):
    result = InterpretedRequest(
        status=status,
        request_id=str(UUID(int=1)),
        legacy_intent="CART_MOVE_FROM_WISHLIST",
        message="Which item?",
        confidence={"raw": 0.99},
        entities=entities if entities is not None else {"category": "banana"},
    )
    result = InterpretedRequest.model_validate(result.model_dump() | changes)
    events = []

    async def run():
        async for event in wishlist_transfer_events(
            authenticated=authenticated,
            request=result,
            commerce_tools=lambda: tools,
            metadata={},
            make_event=lambda kind, **fields: (
                events.append({"type": kind, **fields}) or events[-1]
            ),
        ):
            pass

    asyncio.run(run())
    return events


def test_verified_add_and_wishlist_removal_reports_transferred():
    tools = Tools()
    events = run_transfer(tools)
    item = next(
        block["transfer_items"][0]
        for event in events
        if event["type"] == "content.blocks"
        for block in event["blocks"]
        if block["kind"] == "wishlist_transfer"
    )
    assert item["status"] == "transferred"
    assert tools.removed


def test_named_transfer_uses_product_name_before_broad_category():
    tools = Tools()
    events = run_transfer(
        tools,
        entities={
            "productText": "banana",
            "category": "fruit",
            "sourceCollection": "wishlist",
            "destination": "cart",
        },
    )
    assert tools.removed
    assert any("Transferred" in event.get("text", "") for event in events)


def test_wishlist_removal_failure_does_not_claim_transfer():
    tools = Tools(removal_fails=True)
    events = run_transfer(tools)
    item = next(
        block["transfer_items"][0]
        for event in events
        if event["type"] == "content.blocks"
        for block in event["blocks"]
        if block["kind"] == "wishlist_transfer"
    )
    assert item["status"] == "not_confirmed"
    assert "Added to cart" in item["detail"]


@pytest.mark.parametrize(
    "changes",
    [
        {"status": "NEEDS_CONTEXT"},
        {"status": "AMBIGUOUS"},
        {"status": "UNKNOWN"},
        {"status": "UNSUPPORTED"},
        {"status": "DENIED"},
        {"confidence": {"raw": 0.64, "calibrated": 1.0}},
        {"missing": ["productReference"]},
        {"request_type": "COMPOUND"},
        {"authenticated": False},
    ],
)
def test_incomplete_or_unauthenticated_request_never_calls_commerce_tools(changes):
    events = run_transfer(None, **changes)
    assert not any(event["type"] == "content.blocks" for event in events)
    assert len(events) == 1


def test_named_transfer_uses_raw_confidence_at_the_existing_threshold():
    tools = Tools()
    events = run_transfer(tools, confidence={"raw": 0.65, "calibrated": 0.1})
    assert tools.removed
    assert any("Transferred" in event.get("text", "") for event in events)


class SelectionTools:
    def __init__(self, count=9, fail=None):
        self.ids = [uuid4() for _ in range(count)]
        self.writes = []
        self.removals = []
        self.fail = fail

    async def wishlist(self):
        return self.ids + self.ids[:1]  # A duplicate must not become a second write.

    async def change_cart(self, change):
        from uuid import UUID

        from app.commerce_action_engine.shared.errors import ToolUnavailable

        product_id = UUID(change["product_id"])
        assert product_id in self.ids
        assert change["quantity"] == 1
        self.writes.append(product_id)
        if self.fail == "add":
            raise ToolUnavailable()
        items = (
            []
            if self.fail == "missing"
            else [
                AssistantCartItem(
                    product_id=product_id,
                    name="Selected product",
                    price="1",
                    currency="EGP",
                    quantity=1,
                    line_total="1",
                )
            ]
        )
        return AssistantCart(
            items=items,
            subtotal="1",
            discount_amount="0",
            currency="EGP",
            fully_reserved=True,
        )

    async def transfer_wishlist_to_cart(self, product_ids):
        from app.commerce_action_engine.shared.errors import ToolUnavailable

        assert product_ids and all(product_id in self.ids for product_id in product_ids)
        assert len(product_ids) == len(set(product_ids))
        self.writes = list(product_ids)
        if self.fail in {"add", "remove", "missing"}:
            raise ToolUnavailable()
        self.removals = list(product_ids)
        items = [
            AssistantCartItem(
                product_id=product_id,
                name="Selected product",
                price="1",
                currency="EGP",
                quantity=1,
                line_total="1",
            )
            for product_id in product_ids
        ]
        cart = AssistantCart(
            items=items,
            subtotal=str(len(items)),
            discount_amount="0",
            currency="EGP",
            fully_reserved=True,
        )
        return WishlistTransferReceipt(
            items=[
                WishlistTransferItem(
                    product_id=str(product_id),
                    name="Selected product",
                    status="transferred",
                    detail="Quantity 1 added to cart and removed from your wishlist.",
                )
                for product_id in product_ids
            ],
            cart=cart,
        )

    async def remove_wishlist_item(self, product_id):
        from app.commerce_action_engine.shared.errors import ToolUnavailable

        assert product_id in self.writes
        if self.fail == "remove":
            raise ToolUnavailable()
        self.removals.append(product_id)


def select_transfer(tools, selection, **updates):
    request = InterpretedRequest(
        request_id=str(UUID(int=1)),
        status="RESOLVED",
        legacy_intent="CART_MOVE_FROM_WISHLIST",
        message="Understood.",
        confidence={"raw": 0.99},
        entities={
            "selection": selection,
            "sourceCollection": "wishlist",
            "destination": "cart",
            **updates,
        },
    )

    async def run():
        return [
            event
            async for event in wishlist_transfer_events(
                authenticated=True,
                request=request,
                commerce_tools=lambda: tools,
                metadata={},
                make_event=lambda kind, **fields: {"type": kind, **fields},
            )
        ]

    return asyncio.run(run())


def transfer_outcomes(events):
    return [
        item
        for event in events
        if event["type"] == "content.blocks"
        for block in event["blocks"]
        if isinstance(block, dict) and block["kind"] == "wishlist_transfer"
        for item in block["transfer_items"]
    ]


def test_all_moves_each_saved_id_once_and_streams_verified_results():
    tools = SelectionTools()
    outcomes = transfer_outcomes(select_transfer(tools, "ALL_SAVED"))
    assert tools.writes == tools.ids == tools.removals
    assert len(outcomes) == len(tools.ids)
    assert all(item["status"] == "transferred" for item in outcomes)


def test_any_uses_random_choice_of_saved_ids_only(monkeypatch):
    tools = SelectionTools()

    def choose(candidates):
        assert candidates == tools.ids
        return candidates[-1]

    monkeypatch.setattr(
        "app.commerce_action_engine.application.handlers.wishlist_transfer.choice",
        choose,
    )
    outcomes = transfer_outcomes(select_transfer(tools, "RANDOM_SAVED"))
    assert tools.writes == tools.removals == [tools.ids[-1]]
    assert len(outcomes) == 1 and outcomes[0]["status"] == "transferred"


def test_empty_wishlist_never_attempts_a_write():
    tools = SelectionTools(count=0)
    events = select_transfer(tools, "RANDOM_SAVED")
    assert tools.writes == tools.removals == []
    assert "empty" in events[0]["text"]


def test_uncertain_bulk_write_stops_without_retry_or_removal():
    for failure in ("add", "remove"):
        tools = SelectionTools(fail=failure)
        outcomes = transfer_outcomes(select_transfer(tools, "ALL_SAVED"))
        assert tools.writes == tools.ids
        assert tools.removals == []
        assert len(outcomes) == len(tools.ids)
        assert all(item["status"] == "not_confirmed" for item in outcomes)


def test_missing_cart_confirmation_never_removes_saved_items():
    tools = SelectionTools(fail="missing")
    outcomes = transfer_outcomes(select_transfer(tools, "ALL_SAVED"))
    assert tools.removals == []
    assert len(outcomes) == len(tools.ids)
    assert all(item["status"] == "not_confirmed" for item in outcomes)


def test_bulk_selection_rejects_extra_conditions_before_accessing_tools():
    events = select_transfer(None, "ALL_SAVED", quantity=2)
    assert "conditions" in events[0]["text"]


@pytest.mark.parametrize(
    "answer,selection,count",
    [("all", "ALL_SAVED", 3), ("all", "ALL_SAVED", 9), ("any", "RANDOM_SAVED", 1)],
)
def test_clarification_reply_transfers_through_public_sse(
    identity,
    monkeypatch,
    answer,
    selection,
    count,
):
    import importlib
    from dataclasses import replace
    from unittest.mock import AsyncMock

    config, request_id, headers = identity
    store = AsyncMock()
    store.context.return_value = []
    store.completion_context.return_value = None
    store.get_compound_plan.return_value = None
    monkeypatch.setattr(
        importlib.import_module("app.commerce_action_engine.application.bootstrap"),
        "Store",
        lambda _: store,
    )
    config = replace(config, store_password_file="test-store")
    tools = SelectionTools(count=max(3, count))
    resolved_texts = []

    async def resolve(url, text):
        resolved_texts.append(text)
        if text == "pls move wishlist to cart":
            return Resolution(
                status="NEEDS_CONTEXT",
                intent="CART_MOVE_FROM_WISHLIST",
                confidence=0.99,
                message="Which wishlist item?",
                missing=["productReference"],
                entities={"sourceCollection": "wishlist", "destination": "cart"},
            )
        assert text == f"move {answer} from wishlist to cart"
        return Resolution(
            status="RESOLVED",
            intent="CART_MOVE_FROM_WISHLIST",
            confidence=0.99,
            message="Understood.",
            entities={
                "sourceCollection": "wishlist",
                "destination": "cart",
                "selection": selection,
            },
        )

    monkeypatch.setattr(language_gate, "resolve", resolve)

    async def commerce(request):
        assert request.headers["Authorization"].startswith("Bearer ")
        if request.method == "GET" and request.url.path.endswith("/wishlist"):
            return httpx.Response(200, json=[str(value) for value in tools.ids])
        if request.method == "POST" and request.url.path.endswith(
            "/cart/wishlist-transfer"
        ):
            receipt = await tools.transfer_wishlist_to_cart(
                [UUID(value) for value in json.loads(request.content)["product_ids"]]
            )
            return httpx.Response(200, json=receipt.model_dump(mode="json"))
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={
                **headers(),
                "x-commerce-wishlist-token": "read",
                "x-commerce-cart-write-token": "add",
                "x-commerce-wishlist-write-token": "remove",
                "x-commerce-wishlist-cart-transfer-token": "transfer",
            },
            json={
                "request_id": request_id,
                "conversation_id": request_id,
                "message": answer,
                "clarification": {
                    "original_message": "pls move wishlist to cart",
                    "question": "Which wishlist item?",
                },
            },
        )
    assert response.status_code == 200
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert events[-1]["type"] == "done"
    assert not any(event["type"] == "error" for event in events)
    store.save.assert_awaited_once()
    saved_blocks = store.save.await_args.args[6]
    assert saved_blocks and all(isinstance(block, dict) for block in saved_blocks)
    json.dumps(saved_blocks)
    assert len(tools.writes) == len(tools.removals) == count
    assert len(transfer_outcomes(events)) == count
    assert resolved_texts == [
        "pls move wishlist to cart",
        f"move {answer} from wishlist to cart",
    ]
