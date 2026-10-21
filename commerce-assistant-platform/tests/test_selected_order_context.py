"""Selected orders are read context, never an override of the user's next intent."""

import json
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414 -- pytest fixture
from test_order_read_routes import order

from app.commerce_action_engine.actions.orders import order_read
from app.commerce_action_engine.execution.language import gate
from app.main import create_app

SELECTED = UUID(int=999)


@pytest.mark.parametrize(
    "message,normalized,intent,path,is_list",
    [
        (
            "Where is it?",
            "Where is my order?",
            "TRACK_ORDER",
            f"/orders/{SELECTED}",
            False,
        ),
        (
            "What about order #2?",
            "Show order #2 details",
            "ORDER_DETAILS",
            "/orders/by-number/2",
            False,
        ),
        ("show my orders", "show my orders", "ORDER_HISTORY", "/orders", True),
        (
            "show my latest order",
            "show my latest order",
            "ORDER_DETAILS",
            "/orders",
            True,
        ),
        (
            "what items did I buy?",
            "Show my order details",
            "ORDER_DETAILS",
            f"/orders/{SELECTED}",
            False,
        ),
        (
            "track shipment for order #2",
            "track shipment for order #2",
            "SHIPMENT_TRACKING",
            "/orders/by-number/2",
            False,
        ),
        (
            "track shipment",
            "track shipment",
            "SHIPMENT_TRACKING",
            f"/orders/{SELECTED}",
            False,
        ),
    ],
)
def test_selected_order_reads(
    identity,
    monkeypatch,
    message,
    normalized,
    intent,
    path,
    is_list,
):
    config, request_id, headers = identity
    calls = []

    async def resolve(url, text):
        assert text == normalized
        return gate.Resolution(
            status="RESOLVED", intent=intent, message="Understood", confidence=0.99
        )

    def commerce(request):
        calls.append(request.url.path)
        payload = order(number=2 if "#2" in message else 305)
        return httpx.Response(200, json=[payload] if is_list else payload)

    monkeypatch.setattr(gate, "resolve", resolve)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**headers(), "x-commerce-tool-token": "read"},
            json={
                "request_id": request_id,
                "message": message,
                "order_id": str(SELECTED),
            },
        )
    assert response.status_code == 200
    assert calls == ["/v1/assistant-tools" + path]
    assert "event: card.order" in response.text
    if "items" in message:
        assert "does not include purchased items" in response.text


def test_cart_request_is_not_intercepted_by_selected_order(identity, monkeypatch):
    config, request_id, headers = identity
    calls = []

    async def resolve(url, text):
        assert text == "show my cart"
        return gate.Resolution(
            status="RESOLVED", intent="VIEW_CART", message="Cart", confidence=0.99
        )

    def commerce(request):
        calls.append(request.url.path)
        return httpx.Response(
            200,
            json={
                "items": [],
                "subtotal": "0",
                "discount_amount": "0",
                "currency": "USD",
                "fully_reserved": True,
            },
        )

    monkeypatch.setattr(gate, "resolve", resolve)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**headers(), "x-commerce-cart-token": "read"},
            json={
                "request_id": request_id,
                "message": "show my cart",
                "order_id": str(SELECTED),
            },
        )
    assert response.status_code == 200
    assert "Your cart is empty" in response.text
    assert len(calls) == 1 and "/orders" not in calls[0]
    assert "event: card.order" not in response.text


@pytest.mark.parametrize("status", ["DENIED", "UNSUPPORTED", "NEEDS_CONTEXT", None])
def test_selection_does_not_override_language_guards(identity, monkeypatch, status):
    config, request_id, headers = identity

    async def resolve(url, text):
        return (
            gate.Resolution(status=status, message="Needs attention", confidence=0.99)
            if status
            else None
        )

    def commerce(request):
        pytest.fail("Guarded selected-order request must not call commerce")

    monkeypatch.setattr(gate, "resolve", resolve)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers=headers(),
            json={
                "request_id": request_id,
                "message": "Where is it?",
                "order_id": str(SELECTED),
            },
        )
    assert response.status_code == 200
    assert "event: card.order" not in response.text


def test_explicit_order_disagreement_never_falls_back_to_selection():
    read = order_read("show order #2", {"order_reference": "3"}, SELECTED)
    assert read.order_id is None


def test_clarification_keeps_order_context(identity, monkeypatch):
    config, request_id, headers = identity

    from app.commerce_action_engine.application import followups
    from app.commerce_action_engine.application.interpretation import (
        interpret_resolution,
    )

    async def reply(url, original, message, *, context):
        return interpret_resolution(
            gate.Resolution(
                status="RESOLVED",
                intent="ORDER_DETAILS",
                message="Details",
                confidence=0.99,
            ),
            context,
        ), "show my order details"

    def commerce(request):
        assert request.url.path.endswith(str(SELECTED))
        return httpx.Response(200, json=order())

    monkeypatch.setattr(followups, "resolve_reply", reply)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**headers(), "x-commerce-tool-token": "read"},
            json={
                "request_id": request_id,
                "message": "details",
                "order_id": str(SELECTED),
                "clarification": {
                    "original_message": "my order",
                    "question": "Which information?",
                },
            },
        )
    assert response.status_code == 200
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert any(event["type"] == "card.order" for event in events)


def test_hash_order_reference_overrides_selection():
    read = order_read("What about #2?", {}, SELECTED)
    assert read.number == 2
    assert read.order_id is None
