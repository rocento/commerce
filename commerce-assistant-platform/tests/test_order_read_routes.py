"""Characterize deterministic order reads through the public SSE endpoint."""

import json
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity  # noqa: F401

from app.commerce_action_engine.execution.language import gate as language_gate
from app.main import create_app

ORDER_ID = str(UUID(int=42))


def order(number=305, shipments=None):
    return {
        "id": ORDER_ID,
        "number": number,
        "status": "in_transit",
        "subtotal": "40.00",
        "discount_amount": "2.00",
        "tax_amount": "0.00",
        "delivery_fee": "5.00",
        "total": "43.00",
        "currency": "USD",
        "cancellation_available": False,
        "shipments": shipments or [],
    }


@pytest.mark.parametrize(
    "intent,message,entities,payload,status,path,cards,expected",
    [
        (
            "ORDER_HISTORY",
            "list orders",
            {},
            [],
            200,
            "/orders",
            0,
            "You don't have any orders yet.",
        ),
        (
            "ORDER_HISTORY",
            "list orders",
            {},
            [order(n) for n in range(1, 8)],
            200,
            "/orders",
            5,
            "Here are your 5 most recent orders.",
        ),
        (
            "ORDER_HISTORY",
            "show my latest order",
            {},
            [order(n) for n in range(1, 8)],
            200,
            "/orders",
            1,
            "Here are the details for your latest order, #1.",
        ),
        (
            "ORDER_DAMAGED",
            "damaged order",
            {},
            [order()],
            200,
            "/orders",
            1,
            "Tell me which order has the issue",
        ),
        (
            "ORDER_STATUS",
            "order #305",
            {"orderNumber": "305"},
            order(),
            200,
            "/orders/by-number/305",
            1,
            "Current status: in transit.",
        ),
        (
            "ORDER_STATUS",
            "order #305",
            {"orderNumber": "999"},
            [],
            200,
            "/orders",
            0,
            "You don't have any orders yet.",
        ),
        (
            "ORDER_STATUS",
            "check it",
            {"orderNumber": "305"},
            [],
            200,
            "/orders",
            0,
            "You don't have any orders yet.",
        ),
        (
            "ORDER_STATUS",
            "order #305",
            {},
            {},
            404,
            "/orders/by-number/305",
            0,
            "I couldn’t find order #305 in your account.",
        ),
        (
            "SHIPMENT_TRACKING",
            "track shipment",
            {"orderId": ORDER_ID},
            order(shipments=[{"tracking_reference": "TRACK-1", "status": "shipped"}]),
            200,
            f"/orders/{ORDER_ID}",
            1,
            "TRACK-1: shipped",
        ),
        (
            "SHIPMENT_TRACKING",
            "track shipment",
            {"order_id": ORDER_ID},
            order(),
            200,
            f"/orders/{ORDER_ID}",
            1,
            "has no shipment tracking details yet. Current status: in transit.",
        ),
        (
            "SHIPMENT_TRACKING",
            "track shipment",
            {"orderId": ORDER_ID},
            {},
            503,
            f"/orders/{ORDER_ID}",
            0,
            "I couldn’t load tracking for that order.",
        ),
        (
            "SHIPMENT_TRACKING",
            "track shipment",
            {},
            None,
            200,
            None,
            0,
            "Please provide its order ID.",
        ),
        (
            "SHIPMENT_TRACKING",
            "track shipment",
            {"orderId": "invalid"},
            None,
            200,
            None,
            0,
            "Please choose it from your order history.",
        ),
    ],
)
def test_order_read_wire_behavior(
    identity,  # noqa: F811
    monkeypatch,
    intent,
    message,
    entities,
    payload,
    status,
    path,
    cards,
    expected,
):
    config, request_id, headers = identity
    calls = []

    async def resolve(url, text):
        return language_gate.Resolution(
            status="RESOLVED",
            intent=intent,
            message="Understood.",
            confidence=0.99,
            entities=entities,
        )

    def commerce(request):
        calls.append(request.url.path)
        assert request.method == "GET"
        assert request.headers["authorization"] == "Bearer read-capability"
        return httpx.Response(status, json=payload)

    monkeypatch.setattr(language_gate, "resolve", resolve)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**headers(), "x-commerce-tool-token": "read-capability"},
            json={"request_id": request_id, "message": message},
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert response.status_code == 200
    assert calls == (["/v1/assistant-tools" + path] if path else [])
    assert expected in "".join(event.get("text", "") for event in events)
    assert sum(event["type"] == "card.order" for event in events) == cards
    assert [event["sequence"] for event in events] == list(range(len(events)))
    assert events[-1]["type"] == "done"
    assert all(event.get("response_source", "R") == "R" for event in events)
    expected_types = ["progress"]
    if intent != "SHIPMENT_TRACKING":
        expected_types += ["message.delta", "progress"]
    expected_types += ["card.order"] * cards + ["message.delta", "done"]
    assert [event["type"] for event in events] == expected_types


@pytest.mark.parametrize("intent", ["ORDER_HISTORY", "SHIPMENT_TRACKING"])
def test_anonymous_order_reads_do_not_call_commerce(identity, monkeypatch, intent):  # noqa: F811
    config, request_id, headers = identity

    async def resolve(url, text):
        return language_gate.Resolution(
            status="RESOLVED",
            intent=intent,
            message="Understood.",
            confidence=0.99,
            entities={"orderId": ORDER_ID},
        )

    def commerce(request):
        pytest.fail("An anonymous order read reached commerce")

    monkeypatch.setattr(language_gate, "resolve", resolve)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers=headers(sub=None, sid=None),
            json={"request_id": request_id, "message": "check my orders"},
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert response.status_code == 200
    assert any(event.get("code") == "login_required" for event in events)
    assert not any(event["type"] == "card.order" for event in events)
    assert events[-1]["type"] == "done"
