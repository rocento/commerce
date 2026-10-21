"""Support reads consume admitted standard requests, never model authority."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_customer_support_routes import ID, ticket
from test_language_fallback import install_provider, proposal, unknown

from app.commerce_action_engine.application.handlers import support
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.language import gate
from app.main import create_app


@pytest.mark.parametrize("after_proposal", [False, True])
@pytest.mark.parametrize(
    "intent",
    [
        "SUPPORT_TICKET_STATUS",
        "SUPPORT_TICKET_CLOSE",
        "SUPPORT_TICKET_REOPEN",
        "SUPPORT_ESCALATE",
        "SUPPORT_CALLBACK",
        "SUPPORT_CHAT_HISTORY",
    ],
)
def test_support_receives_standard_request_and_only_reads(
    identity, monkeypatch, after_proposal, intent
):
    config, request_id, headers = identity
    detail = intent == "SUPPORT_CHAT_HISTORY"
    message = f"show support conversation {ID}" if detail else "show my support tickets"
    provider = install_provider(monkeypatch, proposal(intent, message))
    attempts, received, calls = [], [], []
    handler_name = "support_detail_events" if detail else "support_events"
    original = getattr(support, handler_name)
    entities = {"ticket_id": str(ID)} if detail else {}

    async def observe(**kwargs):
        assert "gate" not in kwargs
        request = kwargs["request"]
        assert isinstance(request, InterpretedRequest)
        assert request.request_id == request_id
        assert request.legacy_intent == intent
        assert request.entities == entities
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
            entities=entities,
            primaryIntent="SUPPORT_TICKET_CLOSE"
            if intent == "SUPPORT_TICKET_STATUS"
            else "SUPPORT_TICKET_STATUS",
            confidence=1,
            message="Understood.",
        )

    def commerce(request):
        calls.append(request.url.path)
        assert request.method == "GET"
        assert request.headers["authorization"] == "Bearer support-read"
        payload = ticket().model_dump(mode="json")
        return httpx.Response(
            200,
            json={
                "ticket": payload,
                "messages": [],
                "contact_name": None,
                "contact": None,
            }
            if detail
            else [payload],
        )

    monkeypatch.setattr(gate, "resolve", resolve)
    monkeypatch.setattr(support, handler_name, observe)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**headers(), "x-commerce-support-token": "support-read"},
            json={"request_id": request_id, "message": message},
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert response.status_code == 200
    assert len(received) == 1
    assert calls == [
        "/v1/assistant-tools/support/tickets" + (f"/{ID}" if detail else "")
    ]
    assert len(provider.requests) == int(after_proposal)
    assert len(attempts) == 1 + int(after_proposal)
    assert [event["type"] for event in events] == ["progress", "message.delta", "done"]
    assert [event["sequence"] for event in events] == list(range(len(events)))
    text = events[1]["text"]
    if detail:
        assert text == "Conversation for ticket #7:\nNo messages are available yet."
    else:
        assert "#7 — Order question (open)" in text
        assert ("Open the ticket in Support" in text) == (
            intent != "SUPPORT_TICKET_STATUS"
        )
    assert provider.closed


@pytest.mark.parametrize("intent", ["SUPPORT_TICKET_STATUS", "SUPPORT_CHAT_HISTORY"])
@pytest.mark.parametrize("case", ["guest", "no_capability", "invalid_interpretation"])
def test_support_admission_failures_never_read(identity, monkeypatch, intent, case):
    config, request_id, headers = identity
    provider = install_provider(monkeypatch)

    async def resolve(url, text):
        return gate.Resolution(
            status="RESOLVED",
            intent=intent,
            confidence=1,
            message="",
            entities={"items": "invalid"}
            if case == "invalid_interpretation"
            else {"ticketId": str(ID)},
        )

    monkeypatch.setattr(gate, "resolve", resolve)
    with TestClient(
        create_app(
            config,
            transport=httpx.MockTransport(
                lambda _: pytest.fail("Support admission failure reached commerce")
            ),
        )
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={
                **(headers(sub=None, sid=None) if case == "guest" else headers()),
                **(
                    {"x-commerce-support-token": "support-read"}
                    if case != "no_capability"
                    else {}
                ),
            },
            json={"request_id": request_id, "message": "show my support tickets"},
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert response.status_code == 200
    assert events[-1]["type"] == "done"
    assert any(
        event.get("code") == ("login_required" if case == "guest" else "unavailable")
        for event in events
    )
    assert not provider.requests
    assert provider.closed
