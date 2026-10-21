"""Standard cart inputs preserve admission, selected identity and scoped writes."""

import asyncio
import json
from unittest.mock import AsyncMock
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_cart_actions import ID, NAME, snapshot
from test_language_fallback import install_provider, proposal, unknown
from test_shopping import product

from app.commerce_action_engine.actions.customer import cart_to_wishlist
from app.commerce_action_engine.actions.shopping import cart, cart_removal
from app.commerce_action_engine.adapters.commerce import CommerceTools
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.language import gate
from app.commerce_resolution_engine.admission import require_permit
from app.main import create_app


def request_for(intent="ADD_TO_CART", **updates):
    return InterpretedRequest.model_validate(
        {
            "request_id": str(UUID(int=1)),
            "status": "RESOLVED",
            "legacy_intent": intent,
            "primary_intent": "VIEW_CART",
            "message": "",
            "confidence": {"raw": 0.99},
            "entities": {"productText": NAME, "quantity": 1},
            **updates,
        }
    )


@pytest.mark.parametrize("intent", ["ADD_TO_CART", "REMOVE_FROM_CART"])
@pytest.mark.parametrize(
    "update",
    [
        {"status": "NEEDS_CONTEXT"},
        {"status": "UNKNOWN"},
        {"status": "DENIED"},
        {"status": "AMBIGUOUS"},
        {"status": "UNSUPPORTED"},
        {"confidence": {"raw": 0.64, "calibrated": 1.0}},
        {"missing": ["product"]},
        {"request_type": "COMPOUND"},
        {"entities": {"productText": NAME, "quantity": 1, "price": 2}},
    ],
)
def test_standard_guards_prevent_even_cart_reads(intent, update):
    tools = AsyncMock()
    request = request_for(intent, **update)
    if intent == "REMOVE_FROM_CART":
        asyncio.run(
            cart_removal.remove_from_cart(
                request,
                "remove one",
                tools,
                selected_product_id=UUID(ID),
                confirmed=True,
            )
        )
    else:
        asyncio.run(cart.execute(request, "add one", tools))
    assert not tools.mock_calls


def test_raw_confidence_and_legacy_intent_keep_existing_clear_semantics():
    tools = AsyncMock()
    tools.cart.return_value = snapshot(2)
    tools.change_cart.return_value = snapshot(0)
    request = request_for(
        "CLEAR_CART", confidence={"raw": 0.65, "calibrated": 0.1}, entities={}
    )
    text, updated, _ = asyncio.run(cart.execute(request, "clear cart", tools))
    tools.change_cart.assert_awaited_once_with({"action": "clear"})
    assert text == "Your cart has been cleared." and not updated.items


@pytest.mark.parametrize("after_proposal", [False, True])
@pytest.mark.parametrize(
    "intent",
    [
        "ADD_TO_CART",
        "UPDATE_CART_QUANTITY",
        "CLEAR_CART",
        "REMOVE_FROM_CART",
        "ADD_TO_WISHLIST",
    ],
)
def test_live_cart_dispatch_uses_standard_request_and_exact_scoped_write(
    identity, monkeypatch, after_proposal, intent
):
    config, request_id, headers = identity
    messages = {
        "ADD_TO_CART": f"add 2 {NAME}",
        "UPDATE_CART_QUANTITY": f"set {NAME} quantity to 2",
        "CLEAR_CART": "clear my cart",
        "REMOVE_FROM_CART": "Confirm removal of 1 from my cart",
        "ADD_TO_WISHLIST": f"save {NAME} to my wishlist",
    }
    message = messages[intent]
    entities = (
        {}
        if intent == "CLEAR_CART"
        else {"quantity": 1}
        if intent == "REMOVE_FROM_CART"
        else {"productText": NAME, "quantity": 2}
    )
    provider = install_provider(monkeypatch, proposal(intent, message))
    attempts, received, writes = [], [], []
    owner = (
        cart_removal
        if intent == "REMOVE_FROM_CART"
        else cart_to_wishlist
        if intent == "ADD_TO_WISHLIST"
        else cart
    )
    entry = (
        "remove_from_cart"
        if intent == "REMOVE_FROM_CART"
        else "execute"
        if intent == "ADD_TO_WISHLIST"
        else "execute_cart"
    )
    original = getattr(owner, entry)

    async def observe(request, *args, **kwargs):
        assert isinstance(request, InterpretedRequest)
        assert request.request_id == request_id
        assert request.legacy_intent == intent and request.primary_intent == "VIEW_CART"
        assert request.entities == entities
        with pytest.raises(PermissionError):
            require_permit(UUID(request_id))
        received.append(request)
        return await original(request, *args, **kwargs)

    async def resolve(url, text, *, context=None):
        assert context == (
            {"states": ["PRODUCT_SELECTED"]}
            if intent == "REMOVE_FROM_CART" and not attempts
            else None
        )
        attempts.append(text)
        if after_proposal and len(attempts) == 1:
            return unknown()
        return gate.Resolution(
            status="RESOLVED",
            intent=intent,
            primaryIntent="VIEW_CART",
            confidence=0.99,
            message="",
            entities=entities,
        )

    def commerce(request):
        if request.method == "GET":
            assert request.url.path.endswith("/cart")
            assert request.headers["authorization"] == "Bearer read"
            return httpx.Response(200, json=snapshot(3).model_dump(mode="json"))
        if request.url.path.endswith("/shopper"):
            assert request.headers["authorization"] == "Bearer catalog"
            assert json.loads(request.content) == {
                "name": "search_products",
                "arguments": {"query": NAME},
            }
            return httpx.Response(
                200, json={"products": [product(id=ID, name=NAME)], "category": None}
            )
        assert request.method == "POST"
        assert request.headers["authorization"] == "Bearer write"
        writes.append((request.url.path, json.loads(request.content)))
        if intent == "ADD_TO_WISHLIST":
            assert request.url.path.endswith("/wishlist")
            return httpx.Response(204)
        assert request.url.path.endswith("/cart")
        quantity = {
            "ADD_TO_CART": 5,
            "UPDATE_CART_QUANTITY": 2,
            "CLEAR_CART": 0,
            "REMOVE_FROM_CART": 2,
        }[intent]
        return httpx.Response(200, json=snapshot(quantity).model_dump(mode="json"))

    monkeypatch.setattr(owner, entry, observe)
    monkeypatch.setattr(gate, "resolve", resolve)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={
                **headers(),
                "x-commerce-cart-token": "read",
                "x-commerce-catalog-token": "catalog",
                "x-commerce-cart-write-token": "write",
                "x-commerce-wishlist-write-token": "write",
                "x-delivery-latitude": "30",
                "x-delivery-longitude": "31",
            },
            json={
                "request_id": request_id,
                "message": message,
                **({"product_id": ID} if intent == "REMOVE_FROM_CART" else {}),
            },
        )
    assert response.status_code == 200
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert events[-1]["type"] == "done"
    assert [e["sequence"] for e in events] == list(range(len(events)))
    assert not any(e["type"] == "error" for e in events)
    expected = {
        "ADD_TO_CART": {"action": "add", "product_id": ID, "quantity": 2},
        "UPDATE_CART_QUANTITY": {"action": "set", "product_id": ID, "quantity": 2},
        "CLEAR_CART": {"action": "clear"},
        "REMOVE_FROM_CART": {"action": "remove", "product_id": ID, "quantity": 1},
        "ADD_TO_WISHLIST": {"product_id": ID},
    }[intent]
    assert writes == [
        (
            "/v1/assistant-tools/wishlist"
            if intent == "ADD_TO_WISHLIST"
            else "/v1/assistant-tools/cart",
            expected,
        )
    ]
    assert len(received) == 1 and len(provider.requests) == int(after_proposal)
    assert len(attempts) == 1 + int(after_proposal)
    assert provider.closed and not hasattr(gate, "current")


@pytest.mark.parametrize("malformed", [False, True])
def test_selected_catalog_binding_is_revalidated_before_cart_dispatch(
    identity, monkeypatch, malformed
):
    config, request_id, headers = identity
    provider = install_provider(monkeypatch)
    resolver = AsyncMock(
        return_value=gate.Resolution(
            status="RESOLVED",
            intent="ADD_TO_CART",
            confidence=1,
            message="",
            entities={"productText": "selected product", "quantity": 2},
        )
    )
    selected = {"id": ID, "name": object() if malformed else NAME}
    monkeypatch.setattr(gate, "resolve", resolver)
    monkeypatch.setattr(CommerceTools, "product", AsyncMock(return_value=selected))
    received = []
    original = cart.execute_cart

    async def observe(request, *args, **kwargs):
        assert isinstance(request, InterpretedRequest)
        assert (
            request.request_id == request_id and request.legacy_intent == "ADD_TO_CART"
        )
        assert request.entities == {"productText": NAME, "quantity": 2}
        received.append(request)
        return await original(request, *args, **kwargs)

    monkeypatch.setattr(cart, "execute_cart", observe)
    calls = []

    def commerce(request):
        assert not malformed, "Invalid bound input reached cart transport"
        calls.append(request.method)
        assert request.url.path.endswith("/cart")
        if request.method == "POST":
            assert json.loads(request.content) == {
                "action": "add",
                "product_id": ID,
                "quantity": 2,
            }
        return httpx.Response(
            200,
            json=snapshot(2 if request.method == "POST" else 0).model_dump(mode="json"),
        )

    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={
                **headers(),
                "x-commerce-cart-token": "read",
                "x-commerce-cart-write-token": "write",
                "x-delivery-latitude": "30",
                "x-delivery-longitude": "31",
            },
            json={
                "request_id": request_id,
                "product_id": ID,
                "message": "Add 2 of this to my cart",
            },
        )
    assert response.status_code == 200 and "event: done" in response.text
    assert len(received) == (0 if malformed else 1)
    assert calls == ([] if malformed else ["GET", "POST"])
    assert not provider.requests and provider.closed
