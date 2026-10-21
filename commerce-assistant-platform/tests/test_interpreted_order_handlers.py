"""Migrated order handlers receive the standard result after each admission path."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_language_fallback import install_provider, proposal, unknown
from test_order_read_routes import order

from app.commerce_action_engine.application.handlers import orders
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.language import gate
from app.main import create_app


@pytest.mark.parametrize("after_proposal", [False, True])
@pytest.mark.parametrize(
    "intent,handler_name,message,path",
    [
        ("ORDER_HISTORY", "order_events", "show my orders", "/orders"),
        (
            "ORDER_CANCEL_ELIGIBILITY",
            "order_events",
            "can I cancel order #305",
            "/orders/by-number/305",
        ),
        (
            "SHIPMENT_TRACKING",
            "shipment_events",
            "track order #305",
            "/orders/by-number/305",
        ),
    ],
)
def test_order_handlers_receive_validated_standard_request(
    identity, monkeypatch, after_proposal, intent, handler_name, message, path
):
    config, request_id, headers = identity
    provider = install_provider(monkeypatch, proposal(intent, message))
    attempts, received, calls = [], [], []
    original = getattr(orders, handler_name)

    async def observe(**kwargs):
        assert "gate" not in kwargs
        request = kwargs["request"]
        assert isinstance(request, InterpretedRequest)
        assert request.request_id == request_id
        assert request.legacy_intent == intent
        received.append(request)
        async for event in original(**kwargs):
            yield event

    async def resolve(url, text):
        attempts.append(text)
        if after_proposal and len(attempts) == 1:
            return unknown()
        return gate.Resolution(
            status="RESOLVED",
            intent=intent,
            primaryIntent="ORDER_HISTORY",
            confidence=1,
            message="Understood.",
        )

    def commerce(request):
        calls.append(request.url.path)
        assert request.method == "GET"
        assert request.headers["authorization"] == "Bearer read-capability"
        return httpx.Response(
            200, json=[order()] if intent == "ORDER_HISTORY" else order()
        )

    monkeypatch.setattr(gate, "resolve", resolve)
    monkeypatch.setattr(orders, handler_name, observe)
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
    assert len(received) == 1
    assert calls == ["/v1/assistant-tools" + path]
    assert len(provider.requests) == int(after_proposal)
    assert len(attempts) == 1 + int(after_proposal)
    assert sum(event["type"] == "card.order" for event in events) == 1
    assert events[-1]["type"] == "done"
    assert [event["sequence"] for event in events] == list(range(len(events)))
    if intent == "ORDER_CANCEL_ELIGIBILITY":
        assert any(
            "Cancellation is not currently available." in event.get("text", "")
            for event in events
        )
    assert provider.closed
