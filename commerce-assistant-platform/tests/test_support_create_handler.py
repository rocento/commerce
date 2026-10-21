"""Explicit ticket submission retains admission, transport and SSE behavior."""

import asyncio
import json
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_cart_handler import collect
from test_language_fallback import install_provider

from app.commerce_action_engine.application import handle_turn
from app.commerce_action_engine.application.handlers.support import (
    support_create_events,
)
from app.commerce_action_engine.contracts import (
    AssistantTicketDetail,
    AssistantTicketInput,
)
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable
from app.main import create_app


def submission(request_id, *, optional=False):
    return {
        "request_id": request_id,
        "subject": "Help with my order",
        "category": "order_issue",
        "body": "Please check the missing item.\nThank you.",
        "order_id": str(UUID(int=2)) if optional else None,
        "contact_name": "Customer" if optional else None,
        "contact": "customer@example.test" if optional else None,
    }


def receipt():
    return {
        "ticket": {
            "id": str(UUID(int=3)),
            "number": 42,
            "subject": "Help with my order",
            "category": "order_issue",
            "status": "open",
            "priority": "normal",
            "order_id": None,
            "created_at": "2026-09-14T00:00:00Z",
        },
        "messages": [],
        "contact_name": None,
        "contact": None,
    }


def events(response):
    return [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]


@pytest.mark.parametrize("optional", [False, True])
@pytest.mark.parametrize("planning", [False, True])
def test_explicit_submission_preserves_payload_receipt_and_sequence(
    identity, monkeypatch, optional, planning
):
    config, request_id, headers = identity
    if planning:
        config = replace(
            config, feature_flags=(*config.feature_flags, "commerce_planning")
        )
    provider = install_provider(monkeypatch)
    resolver = AsyncMock(
        side_effect=AssertionError("Ticket form reached interpretation")
    )
    monkeypatch.setattr(gate, "resolve", resolver)
    calls, received = [], []
    original = handle_turn.support_create_events
    form = submission(request_id, optional=optional)

    async def observe(**kwargs):
        assert set(kwargs) == {"submission", "commerce_tools", "metadata", "make_event"}
        assert isinstance(kwargs["submission"], AssistantTicketInput)
        assert kwargs["submission"].model_dump(mode="json") == form
        received.append(kwargs["metadata"])
        async for event in original(**kwargs):
            yield event

    def commerce(request):
        calls.append(request)
        assert request.method == "POST"
        assert request.url.path == "/v1/assistant-tools/support/tickets"
        assert request.headers["authorization"] == "Bearer create-token"
        assert request.headers["x-commerce-request"] == "1"
        assert json.loads(request.content) == {
            k: v for k, v in form.items() if v is not None
        }
        return httpx.Response(201, json=receipt())

    monkeypatch.setattr(handle_turn, "support_create_events", observe)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={
                **headers(),
                "x-commerce-tool-token": "create-token",
                "x-commerce-support-token": "read-token",
            },
            json={"request_id": request_id, "message": "Open ticket", "ticket": form},
        )
    result = events(response)
    assert response.status_code == 200 and len(calls) == len(received) == 1
    assert [e["type"] for e in result] == [
        "progress",
        "progress",
        "ticket.created",
        "message.delta",
        "done",
    ]
    assert [e["sequence"] for e in result] == list(range(len(result)))
    assert [e["stage"] for e in result[:2]] == ["preparing", "support"]
    assert result[2]["ticket"] == AssistantTicketDetail.model_validate(
        receipt()
    ).model_dump(mode="json")
    assert (
        result[3]["text"] == "Ticket #42 is open. Our support team can now follow up."
    )
    assert all(e["request_id"] == request_id for e in result)
    assert all(e["response_source"] == "R" for e in result[2:])
    assert received[0]["route_reason"] == "support_ticket"
    assert received[0]["tools"] == ["support_create"] and received[0]["tool_calls"] == 1
    # Extraction preserves the existing conservative completion classification.
    assert "completion_evidence" not in received[0]
    assert received[0]["completion"]["status"] == "unverified"
    resolver.assert_not_awaited()
    assert not provider.requests and provider.closed and not hasattr(gate, "current")


@pytest.mark.parametrize(
    "failure",
    ["denied", "unavailable", "timeout", "invalid_json", "invalid_receipt", "oversize"],
)
def test_failed_submission_has_no_success_event_and_is_not_retried(
    identity, monkeypatch, failure
):
    config, request_id, headers = identity
    provider = install_provider(monkeypatch)
    calls = []

    def commerce(request):
        calls.append(request)
        if failure == "timeout":
            raise httpx.ReadTimeout("SECRET gateway details", request=request)
        if failure == "invalid_json":
            return httpx.Response(201, text="SECRET invalid JSON")
        if failure == "invalid_receipt":
            return httpx.Response(201, json={"ticket": {"number": 42}})
        if failure == "oversize":
            return httpx.Response(201, text=" " * 32769 + json.dumps(receipt()))
        return httpx.Response(
            403 if failure == "denied" else 503, text="SECRET gateway details"
        )

    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**headers(), "x-commerce-tool-token": "create-token"},
            json={
                "request_id": request_id,
                "message": "Open ticket",
                "ticket": submission(request_id),
            },
        )
    result = events(response)
    assert response.status_code == 200 and len(calls) == 1
    assert result[-1]["type"] == "done"
    assert [e["sequence"] for e in result] == list(range(len(result)))
    assert not any(e["type"] == "ticket.created" for e in result)
    assert "is open" not in response.text and "SECRET" not in response.text
    assert result[-2]["code"] == (
        "support_required" if failure == "denied" else "unavailable"
    )
    assert not provider.requests and provider.closed


@pytest.mark.parametrize(
    "invalid,status",
    [
        ("guest", 403),
        ("ticket_request", 403),
        ("context_request", 403),
        ("clarification", 400),
        ("empty_body", 422),
        ("extra_field", 422),
    ],
)
def test_ticket_admission_rejects_invalid_context_before_dispatch(
    identity, monkeypatch, invalid, status
):
    config, request_id, headers = identity
    provider = install_provider(monkeypatch)
    resolver = AsyncMock(
        side_effect=AssertionError("Rejected form reached interpretation")
    )
    monkeypatch.setattr(gate, "resolve", resolver)
    form = submission(request_id)
    body = {"request_id": request_id, "message": "Open ticket", "ticket": form}
    auth = headers()
    if invalid == "guest":
        auth = headers(sub=None, sid=None)
    elif invalid == "ticket_request":
        form["request_id"] = str(UUID(int=4))
    elif invalid == "context_request":
        auth = headers(request_id=str(UUID(int=4)))
    elif invalid == "clarification":
        body["clarification"] = {"original_message": "Help", "question": "Which order?"}
    elif invalid == "empty_body":
        form["body"] = ""
    else:
        form["authorized"] = True
    commerce = Mock(side_effect=AssertionError("Rejected form reached commerce"))
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post("/v1/chat", headers=auth, json=body)
    assert response.status_code == status
    commerce.assert_not_called()
    resolver.assert_not_awaited()
    assert not provider.requests and provider.closed


@pytest.mark.parametrize(
    "error_type", [ToolDenied, ToolUnavailable, asyncio.CancelledError]
)
def test_handler_propagates_write_failure_without_success_or_retry(error_type):
    error = error_type()
    writer = SimpleNamespace(create_ticket=AsyncMock(side_effect=error))
    emitted, metadata = [], {}

    def event(kind, **fields):
        value = {"type": kind, **fields}
        emitted.append(value)
        return value

    stream = support_create_events(
        submission=AssistantTicketInput.model_validate(submission(str(UUID(int=1)))),
        commerce_tools=lambda: writer,
        metadata=metadata,
        make_event=event,
    )
    with pytest.raises(error_type) as caught:
        asyncio.run(collect(stream))
    assert caught.value is error
    assert emitted == [{"type": "progress", "stage": "support"}]
    assert "completion_evidence" not in metadata
    assert writer.create_ticket.await_count == 1


@pytest.mark.parametrize("after_receipt", [False, True])
def test_closing_handler_never_starts_or_repeats_a_write(after_receipt):
    writer = SimpleNamespace(
        create_ticket=AsyncMock(
            return_value=AssistantTicketDetail.model_validate(receipt())
        )
    )
    metadata = {}
    stream = support_create_events(
        submission=AssistantTicketInput.model_validate(submission(str(UUID(int=1)))),
        commerce_tools=lambda: writer,
        metadata=metadata,
        make_event=lambda kind, **fields: {"type": kind, **fields},
    )

    async def run():
        assert (await anext(stream))["type"] == "progress"
        if after_receipt:
            assert (await anext(stream))["type"] == "ticket.created"
        await stream.aclose()
        with pytest.raises(StopAsyncIteration):
            await anext(stream)

    asyncio.run(run())
    assert writer.create_ticket.await_count == int(after_receipt)
    assert "completion_evidence" not in metadata
