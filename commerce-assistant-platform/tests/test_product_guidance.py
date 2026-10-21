"""Guided requests through real language interpretation, SSE and commerce transport."""

import importlib
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_bestseller_periods import interpret
from test_cart_actions import ID, NAME, snapshot
from test_shopping import product

from app.commerce_action_engine.application.responses import validate_blocks
from app.commerce_action_engine.contracts import AssistantBlock
from app.commerce_action_engine.execution.language import gate as language_gate
from app.main import create_app


@pytest.fixture(autouse=True)
def no_model(monkeypatch):
    class NoModel:
        async def generate(self, request):
            pytest.fail("Guidance must not call a model")

        async def stream(self, request):
            pytest.fail("Guidance must not stream a model")
            yield

        async def aclose(self):
            pass

    monkeypatch.setattr(
        importlib.import_module("app.commerce_action_engine.application.bootstrap"),
        "build_provider",
        lambda _: NoModel(),
    )


def frames(response):
    assert response.status_code == 200, response.text
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert events[-1]["type"] == "done", response.text
    assert not any(event["type"] == "error" for event in events), response.text
    return events


def real_engine(monkeypatch):
    async def resolve(url, text, *, context=None):
        return interpret(text, context=context)

    monkeypatch.setattr(language_gate, "resolve", resolve)


@pytest.mark.parametrize(
    "message,query,quantity,action",
    [
        ("pls add banans", "banans", 1, "choose"),
        ("Could you add two green tea please?", "green tea", 2, "choose"),
        ("save SKU-GRN-007", "SKU-GRN-007", 1, "choose"),
        ("compare coffee", "coffee", 1, "compare"),
        ("Compare two gold rings", "gold rings", 1, "compare"),
    ],
)
def test_incomplete_request_is_guided_without_commerce_calls(
    identity, monkeypatch, message, query, quantity, action
):
    real_engine(monkeypatch)

    def no_commerce(request):
        pytest.fail(f"Premature commerce call: {request.method} {request.url.path}")

    config, request_id, headers = identity
    with TestClient(
        create_app(config, transport=httpx.MockTransport(no_commerce))
    ) as client:
        result = frames(
            client.post(
                "/v1/chat",
                headers=headers(),
                json={"request_id": request_id, "message": message},
            )
        )
    blocks = next(e["blocks"] for e in result if e["type"] == "content.blocks")
    assert blocks == [
        {
            "kind": "product_prompt",
            "product_prompt": {"query": query, "quantity": quantity, "action": action},
        }
    ]
    assert all(e.get("response_source") != "L" for e in result)


@pytest.mark.parametrize(
    "action,failed",
    [("cart", False), ("wishlist", False), ("cart", True), ("wishlist", True)],
)
def test_product_selection_calls_exact_authorized_action_once(
    identity, monkeypatch, action, failed
):
    real_engine(monkeypatch)
    config, request_id, headers = identity
    calls = []
    selected = product(1, id=ID, name=NAME, route=f"/products/{ID}")

    def commerce(request):
        calls.append((request.method, request.url.path))
        if request.url.path.endswith("/shopper"):
            assert json.loads(request.content) == {
                "name": "get_product",
                "arguments": {"product_id": ID},
            }
            assert request.headers["authorization"] == "Bearer catalog-token"
            return httpx.Response(200, json={"products": [selected], "category": None})
        if request.method == "GET":
            assert request.url.path.endswith("/cart")
            return httpx.Response(200, json=snapshot(0).model_dump(mode="json"))
        assert request.method == "POST"
        if action == "cart":
            assert request.url.path.endswith("/cart")
            assert request.headers["authorization"] == "Bearer cart-write-token"
            assert json.loads(request.content) == {
                "action": "add",
                "product_id": ID,
                "quantity": 2,
            }
            return httpx.Response(
                503 if failed else 200, json=snapshot(2).model_dump(mode="json")
            )
        assert request.url.path.endswith("/wishlist")
        assert request.headers["authorization"] == "Bearer wishlist-write-token"
        assert json.loads(request.content) == {"product_id": ID}
        return httpx.Response(503 if failed else 204)

    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        result = frames(
            client.post(
                "/v1/chat",
                headers={
                    **headers(),
                    "x-commerce-catalog-token": "catalog-token",
                    "x-commerce-cart-token": "cart-token",
                    "x-commerce-cart-write-token": "cart-write-token",
                    "x-commerce-wishlist-write-token": "wishlist-write-token",
                    "x-delivery-latitude": "30",
                    "x-delivery-longitude": "31",
                },
                json={
                    "request_id": request_id,
                    "product_id": ID,
                    "message": "Add 2 of this to my cart"
                    if action == "cart"
                    else "Save this to my wishlist",
                },
            )
        )
    assert calls.count(("POST", f"/v1/assistant-tools/{action}")) == 1
    answer = "".join(e.get("text", "") for e in result if e["type"] == "message.delta")
    assert ("couldn't confirm" in answer) == failed
    if not failed:
        assert ("Added 2" if action == "cart" else "Saved") in answer


@pytest.mark.parametrize("mixed", [False, True])
def test_prompt_contract_rejects_unrelated_content(mixed):
    block = AssistantBlock(
        kind="product_prompt",
        product_prompt={"query": "banans", "quantity": 2, "action": "choose"},
        **({"text": "extra"} if mixed else {}),
    )
    if mixed:
        with pytest.raises(ValueError):
            validate_blocks([block])
    else:
        validate_blocks([block])


@pytest.mark.parametrize(
    "action,message",
    [
        ("cart", "pls add tea on cart"),
        ("wishlist", "save tea to my wishlist"),
    ],
)
def test_explicit_action_goes_directly_to_product_selection(
    identity, monkeypatch, action, message
):
    from unittest.mock import AsyncMock

    from app.commerce_action_engine.adapters.commerce import CommerceTools

    real_engine(monkeypatch)
    monkeypatch.setattr(CommerceTools, "cart", AsyncMock(return_value=snapshot(0)))
    monkeypatch.setattr(
        CommerceTools,
        "search_cart_product",
        AsyncMock(return_value=[product(1, name="Green Tea 100g")]),
    )
    change = AsyncMock()
    wishlist = AsyncMock()
    monkeypatch.setattr(CommerceTools, "change_cart", change)
    monkeypatch.setattr(CommerceTools, "add_wishlist_item", wishlist)
    config, request_id, headers = identity
    with TestClient(create_app(config)) as client:
        result = frames(
            client.post(
                "/v1/chat",
                headers={
                    **headers(),
                    "x-delivery-latitude": "30",
                    "x-delivery-longitude": "31",
                },
                json={"request_id": request_id, "message": message},
            )
        )
    blocks = next(e["blocks"] for e in result if e["type"] == "content.blocks")
    prompt = next(b["product_prompt"] for b in blocks if b["kind"] == "product_prompt")
    assert prompt == {"query": "tea", "quantity": 1, "action": action}
    assert not any(b["kind"] == "cart_summary" for b in blocks)
    change.assert_not_awaited()
    wishlist.assert_not_awaited()


@pytest.mark.parametrize(
    "message,queries",
    [
        ("create order : chesse and milk", ["chesse", "milk"]),
        (
            "Please create an order for low-fat cheese and organic milk",
            ["low-fat cheese", "organic milk"],
        ),
    ],
)
def test_order_with_products_recommends_before_checkout(
    identity, monkeypatch, message, queries
):
    real_engine(monkeypatch)

    def no_commerce(request):
        pytest.fail(
            f"No cart reads or writes before product selection: {request.url.path}"
        )

    config, request_id, headers = identity
    with TestClient(
        create_app(config, transport=httpx.MockTransport(no_commerce))
    ) as client:
        result = frames(
            client.post(
                "/v1/chat",
                headers=headers(),
                json={"request_id": request_id, "message": message},
            )
        )
    blocks = next(e["blocks"] for e in result if e["type"] == "content.blocks")
    assert blocks == [
        {
            "kind": "product_prompt",
            "product_prompt": {"query": query, "quantity": 1, "action": "cart"},
        }
        for query in queries
    ]
    assert not any("checkout" in e.get("text", "").lower() for e in result)


@pytest.mark.parametrize(
    "message,query",
    [
        ("create order 2 bananas", "bananas"),
        ("buy 2 bananas", "bananas"),
        ("can I get two bananas", "bananas"),
        ("I want to order 2 bananas", "bananas"),
        ("order 2 bananas", "bananas"),
        ("pls create order 2 banana", "banana"),
        ("pls create order 2 baladi", "baladi"),
        ("could you please create order two rings", "rings"),
    ],
)
def test_unpunctuated_order_keeps_quantity_without_commerce_writes(
    identity, monkeypatch, message, query
):
    real_engine(monkeypatch)

    def no_commerce(request):
        pytest.fail(
            f"Product selection must precede commerce calls: {request.url.path}"
        )

    config, request_id, headers = identity
    with TestClient(
        create_app(config, transport=httpx.MockTransport(no_commerce))
    ) as client:
        result = frames(
            client.post(
                "/v1/chat",
                headers=headers(),
                json={
                    "request_id": request_id,
                    "message": message,
                },
            )
        )
    blocks = next(e["blocks"] for e in result if e["type"] == "content.blocks")
    assert blocks == [
        {
            "kind": "product_prompt",
            "product_prompt": {
                "query": query,
                "quantity": 2,
                "action": "cart",
            },
        }
    ]
    text = " ".join(e.get("text", "") for e in result)
    assert "products for your order" in text
    assert "compare" not in text


@pytest.mark.parametrize("message", ["order number 2", "order id 2", "order #2"])
def test_numbered_order_request_only_reads_the_requested_order(
    identity, monkeypatch, message
):
    from test_order_read_routes import order

    real_engine(monkeypatch)
    calls = []

    def commerce(request):
        calls.append((request.method, request.url.path))
        assert request.method == "GET"
        assert request.url.path == "/v1/assistant-tools/orders/by-number/2"
        return httpx.Response(200, json=order(2))

    config, request_id, headers = identity
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        result = frames(
            client.post(
                "/v1/chat",
                headers={**headers(), "x-commerce-tool-token": "read-capability"},
                json={"request_id": request_id, "message": message},
            )
        )
    assert calls == [("GET", "/v1/assistant-tools/orders/by-number/2")]
    assert any(
        event["type"] == "card.order" and event["order"]["number"] == 2
        for event in result
    )


@pytest.mark.parametrize(
    "message",
    [
        "please create order 2 banans 3 apples 2 baladi",
        "I need 2 banans 3 apples 2 baladi",
        "please 2 banans 3 apples 2 baladi",
        "Hi, could u please order banans x2, apples x3, baladi x2?",
        "I'd like to purchase two banans, three apples, two baladi",
    ],
)
def test_unpunctuated_order_emits_three_separate_choices(
    identity, monkeypatch, message
):
    real_engine(monkeypatch)

    def no_commerce(request):
        pytest.fail(f"Premature commerce call: {request.method} {request.url.path}")

    config, request_id, headers = identity
    with TestClient(
        create_app(config, transport=httpx.MockTransport(no_commerce))
    ) as client:
        result = frames(
            client.post(
                "/v1/chat",
                headers=headers(),
                json={
                    "request_id": request_id,
                    "message": message,
                },
            )
        )
    blocks = next(
        event["blocks"] for event in result if event["type"] == "content.blocks"
    )
    assert blocks == [
        {
            "kind": "product_prompt",
            "product_prompt": {"query": query, "quantity": quantity, "action": "cart"},
        }
        for query, quantity in [("banans", 2), ("apples", 3), ("baladi", 2)]
    ]


@pytest.mark.parametrize(
    "message",
    [
        "please order 2 bananas with a total budget of 200 EGP",
        "order 2 bananas and keep my current cart",
        "clear my cart then order 2 apples",
        "order 2 bananas and deliver tomorrow morning",
        "order 2 bananas and pay with my saved card",
        "order 2 bananas only if it is in stock",
        "order 2 bananas without sugar",
        "create order 0 bananas",
        "order 2 bananas, actually make that five",
        "order 2 bananas and the other one",
    ],
)
def test_complex_order_clarifies_without_commerce_or_product_prompts(
    identity, monkeypatch, message
):
    real_engine(monkeypatch)

    def no_commerce(request):
        pytest.fail(f"Premature commerce call: {request.method} {request.url.path}")

    config, request_id, headers = identity
    with TestClient(
        create_app(config, transport=httpx.MockTransport(no_commerce))
    ) as client:
        result = frames(
            client.post(
                "/v1/chat",
                headers=headers(),
                json={
                    "request_id": request_id,
                    "message": message,
                },
            )
        )
    assert any(
        event.get("text") for event in result if event["type"] == "message.delta"
    )
    assert not any(
        block["kind"] == "product_prompt"
        for event in result
        for block in event.get("blocks", [])
    )


@pytest.mark.parametrize("count", [6, 9, 50])
def test_large_order_streams_every_product_prompt(identity, monkeypatch, count):
    real_engine(monkeypatch)

    def no_commerce(request):
        pytest.fail(f"Premature commerce call: {request.url.path}")

    config, request_id, headers = identity
    message = "I need " + ", ".join(f"{i + 1} apples" for i in range(count))
    with TestClient(
        create_app(config, transport=httpx.MockTransport(no_commerce))
    ) as client:
        result = frames(
            client.post(
                "/v1/chat",
                headers=headers(),
                json={"request_id": request_id, "message": message},
            )
        )
    batches = [e["blocks"] for e in result if e["type"] == "content.blocks"]
    assert all(len(batch) <= 8 for batch in batches)
    prompts = [b["product_prompt"] for batch in batches for b in batch]
    assert prompts == [
        {"query": "apples", "quantity": i + 1, "action": "cart"} for i in range(count)
    ]
