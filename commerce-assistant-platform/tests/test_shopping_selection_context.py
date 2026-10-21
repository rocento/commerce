"""UI selections ground follow-ups without hijacking explicit instructions."""

import asyncio
import json
from unittest.mock import AsyncMock
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414 -- pytest fixture
from test_cart_actions import ID, NAME, interpreted, snapshot

from app.commerce_action_engine.actions.shopping.cart import execute
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.execution.language.selection import shopping_followup
from app.main import create_app

PRODUCT = {
    "id": ID,
    "name": NAME,
    "price": "2.50",
    "currency": "USD",
    "category_id": str(UUID(int=8)),
    "product_type": "simple",
    "attributes": [],
    "in_stock": True,
    "route": f"/products/{ID}",
}


@pytest.mark.parametrize(
    "message,product,cart,expected",
    [
        ("How much is it?", True, False, "CHECK_PRICE"),
        ("Is it in stock?", True, False, "CHECK_STOCK"),
        ("Tell me about it", True, False, "PRODUCT_DETAILS"),
        ("Add two", True, False, "ADD_TO_CART"),
        ("add 2 of it to my cart", True, False, "ADD_TO_CART"),
        ("remove it", True, False, "REMOVE_FROM_CART"),
        ("What's in it?", False, True, "VIEW_CART"),
        ("How much is it?", False, True, "VIEW_CART"),
        ("how many items", False, True, "VIEW_CART"),
        ("add bread to my cart", True, False, None),
        ("remove milk from cart", True, False, None),
        ("show order #2", True, False, None),
        ("yes", True, False, None),
        ("empty it", False, True, None),
        ("How much is it?", False, False, None),
        ("add -2 of it", True, False, None),
        ("add it and checkout", True, False, None),
    ],
)
def test_followup_scope(message, product, cart, expected):
    result = shopping_followup(message, product=product, cart=cart)
    assert (result.intent if result else None) == expected


@pytest.mark.parametrize(
    "message,product,confirmed",
    [
        ("Confirm removal of 3 from my cart", True, True),
        ("Confirm removal of 1000000 from my cart", True, True),
        ("Confirm removal of 3 from my cart", False, False),
        ("Remove this from my cart", True, False),
        ("Don't confirm removal of 3 from my cart", True, False),
        ("Confirm removal of 0 from my cart", True, False),
        ("Confirm removal of 1.5 from my cart", True, False),
        ("Confirm removal of 1000001 from my cart", True, False),
        ("Confirm removal of 3 from my cart and add tea", True, False),
    ],
)
def test_confirmation_requires_exact_selected_product_followup(
    message, product, confirmed
):
    result = shopping_followup(message, product=product, cart=False)
    assert bool(result and result.confirmed) is confirmed


@pytest.mark.parametrize(
    "message,intent,normalized,answer",
    [
        ("How much is it?", "CHECK_PRICE", "check price", "2.50 USD"),
        ("Is it in stock?", "CHECK_STOCK", "check stock", "in stock"),
        (
            "Tell me about it",
            "PRODUCT_DETAILS",
            "selected product details",
            "current catalog details",
        ),
    ],
)
def test_selected_product_is_read_from_catalog(
    identity, monkeypatch, message, intent, normalized, answer
):
    config, request_id, headers = identity
    calls = []

    async def resolve(url, text, *, context=None):
        assert context == {"states": ["PRODUCT_SELECTED"]}
        assert text == normalized
        return gate.Resolution(
            status="RESOLVED", intent=intent, confidence=0.99, message="Understood"
        )

    def commerce(request):
        calls.append(json.loads(request.content))
        assert calls[-1] == {"name": "get_product", "arguments": {"product_id": ID}}
        return httpx.Response(200, json={"products": [PRODUCT], "category": None})

    monkeypatch.setattr(gate, "resolve", resolve)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**headers(), "x-commerce-catalog-token": "read"},
            json={"request_id": request_id, "message": message, "product_id": ID},
        )
    assert response.status_code == 200
    assert answer in response.text
    assert '"kind":"product_card"' in response.text
    assert len(calls) == 1


@pytest.mark.parametrize("status", ["DENIED", "UNSUPPORTED", "NEEDS_CONTEXT", None])
def test_selected_product_does_not_override_guards(identity, monkeypatch, status):
    config, request_id, headers = identity

    async def resolve(url, text, *, context=None):
        assert context == {"states": ["PRODUCT_SELECTED"]}
        return (
            gate.Resolution(status=status, confidence=0.99, message="Needs attention")
            if status
            else None
        )

    def commerce(request):
        pytest.fail("Guarded request must not fetch or mutate a product")

    monkeypatch.setattr(gate, "resolve", resolve)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers=headers(),
            json={
                "request_id": request_id,
                "message": "How much is it?",
                "product_id": ID,
            },
        )
    assert response.status_code == 200
    assert '"kind":"product_card"' not in response.text


def test_duplicate_names_use_selected_product_id():
    tools = AsyncMock()
    other = snapshot().items[0].model_copy(update={"product_id": UUID(int=7)})
    cart = snapshot()
    cart.items.append(other)
    tools.cart.return_value = cart
    tools.change_cart.return_value = cart
    resolution = gate.Resolution(
        status="RESOLVED",
        intent="ADD_TO_CART",
        confidence=0.99,
        message="",
        entities={"productText": NAME, "quantity": 2},
    )
    asyncio.run(
        execute(interpreted(resolution), "add two", tools, selected_product=PRODUCT)
    )
    tools.change_cart.assert_awaited_once_with(
        {"action": "add", "product_id": ID, "quantity": 2}
    )
    tools.search_cart_product.assert_not_awaited()


def test_cart_followup_reads_current_cart(identity, monkeypatch):
    config, request_id, headers = identity

    async def resolve(url, text):
        assert text == "show my cart"
        return gate.Resolution(
            status="RESOLVED", intent="VIEW_CART", confidence=0.99, message="Cart"
        )

    def commerce(request):
        assert request.url.path.endswith("/cart")
        return httpx.Response(200, json=snapshot(3).model_dump(mode="json"))

    monkeypatch.setattr(gate, "resolve", resolve)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**headers(), "x-commerce-cart-token": "read"},
            json={
                "request_id": request_id,
                "message": "How many items?",
                "cart_context": True,
            },
        )
    assert response.status_code == 200
    assert "Your cart has 3 items" in response.text


def test_rejects_conflicting_selections(identity):
    config, request_id, headers = identity
    with TestClient(create_app(config)) as client:
        response = client.post(
            "/v1/chat",
            headers=headers(),
            json={
                "request_id": request_id,
                "message": "How much is it?",
                "product_id": ID,
                "cart_context": True,
            },
        )
    assert response.status_code == 400


def test_selected_product_add_uses_verified_id_and_quantity(identity, monkeypatch):
    config, request_id, headers = identity
    writes = []

    async def resolve(url, text, *, context=None):
        assert context == {"states": ["PRODUCT_SELECTED"]}
        assert text == "add two selected product to cart"
        return gate.Resolution(
            status="RESOLVED",
            intent="ADD_TO_CART",
            confidence=0.99,
            message="Add two",
            entities={"productText": "selected product", "quantity": 2},
        )

    def commerce(request):
        if request.url.path.endswith("/cart"):
            if request.method == "POST":
                writes.append(json.loads(request.content))
            return httpx.Response(
                200, json=snapshot(3 if writes else 1).model_dump(mode="json")
            )
        payload = json.loads(request.content)
        assert payload == {"name": "get_product", "arguments": {"product_id": ID}}
        return httpx.Response(200, json={"products": [PRODUCT], "category": None})

    monkeypatch.setattr(gate, "resolve", resolve)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={
                **headers(),
                "x-commerce-catalog-token": "read",
                "x-commerce-cart-token": "read",
                "x-commerce-cart-write-token": "write",
                "x-delivery-latitude": "30.1",
                "x-delivery-longitude": "31.2",
            },
            json={"request_id": request_id, "message": "Add two", "product_id": ID},
        )
    assert response.status_code == 200
    assert writes == [{"action": "add", "product_id": ID, "quantity": 2}]
    assert "Added 2" in response.text
    assert '"kind":"cart_summary"' in response.text


@pytest.mark.parametrize(
    "text,intent,product,cart",
    [
        ("price /", "CHECK_PRICE", True, False),
        ("availability /", "CHECK_STOCK", True, False),
        ("details /", "PRODUCT_DETAILS", True, False),
        ("total /", "VIEW_CART", False, True),
    ],
)
def test_read_followup_trailing_slash_requires_selection(text, intent, product, cart):
    result = shopping_followup(text, product=product, cart=cart)
    assert result and result.intent == intent
    assert shopping_followup(text, product=False, cart=False) is None
    assert shopping_followup(text + " delete it", product=product, cart=cart) is None
