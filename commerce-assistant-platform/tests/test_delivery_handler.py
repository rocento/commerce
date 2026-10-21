"""Delivery reads preserve location scoping, wording and turn lifecycle ownership."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_cart_handler import collect
from test_language_fallback import install_provider, proposal, unknown

from app.commerce_action_engine.application import handle_turn
from app.commerce_action_engine.application.handlers.delivery import delivery_events
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable
from app.main import create_app


@pytest.mark.parametrize("after_proposal", [False, True])
@pytest.mark.parametrize("guest", [False, True])
@pytest.mark.parametrize(
    "configured,deliverable,expected",
    [
        (
            False,
            False,
            "Delivery is available. Choose a delivery location at checkout for the final quote.",
        ),
        (
            True,
            True,
            "Delivery is available for this location. Choose a delivery location at checkout for the final quote.",
        ),
        (
            True,
            False,
            "Delivery is not available for this location. Choose another delivery location or contact support.",
        ),
    ],
)
def test_delivery_flow_preserves_scoped_coordinates_and_completion(
    identity, monkeypatch, after_proposal, guest, configured, deliverable, expected
):
    config, request_id, headers = identity
    message = "Can you deliver here?"
    provider = install_provider(monkeypatch, proposal("DELIVERY_STATUS", message))
    attempts, calls, received = [], [], []
    original = handle_turn.delivery_events

    async def observe(**kwargs):
        assert set(kwargs) == {"commerce_tools", "metadata", "make_event"}
        received.append(kwargs["metadata"])
        async for event in original(**kwargs):
            yield event

    async def resolve(url, text):
        attempts.append(text)
        if after_proposal and len(attempts) == 1:
            return unknown()
        return gate.Resolution(
            status="RESOLVED", intent="DELIVERY_STATUS", confidence=1, message=""
        )

    def commerce(request):
        assert request.method == "GET"
        assert request.url.path == "/v1/assistant-tools/delivery"
        assert request.headers["authorization"] == "Bearer catalog"
        assert request.headers["x-delivery-latitude"] == "30.1"
        assert request.headers["x-delivery-longitude"] == "31.2"
        calls.append(request)
        return httpx.Response(
            200,
            json={
                "configured": configured,
                "deliverable": deliverable,
                "area_id": None,
            },
        )

    monkeypatch.setattr(gate, "resolve", resolve)
    monkeypatch.setattr(handle_turn, "delivery_events", observe)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={
                **(headers(sub=None, sid=None) if guest else headers()),
                "x-commerce-catalog-token": "catalog",
                "x-delivery-latitude": "30.1",
                "x-delivery-longitude": "31.2",
            },
            json={"request_id": request_id, "message": message},
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert response.status_code == 200 and len(calls) == 1 and len(received) == 1
    assert events[-1]["type"] == "done"
    assert [e["sequence"] for e in events] == list(range(len(events)))
    assert [e["text"] for e in events if e["type"] == "message.delta"] == [expected]
    assert not any(e["type"] in {"error", "content.blocks"} for e in events)
    assert received[0]["route_reason"] == "delivery_status"
    assert received[0]["tools"] == ["delivery_status"]
    assert (
        received[0]["tool_calls"] == 1
        and received[0]["completion_evidence"] == "read_result"
    )
    assert len(provider.requests) == int(after_proposal)
    assert provider.closed and not hasattr(gate, "current")


@pytest.mark.parametrize(
    "failure", ["missing_capability", "denied", "unavailable", "invalid_receipt"]
)
def test_live_failed_delivery_never_reports_availability(
    identity, monkeypatch, failure
):
    config, request_id, headers = identity
    provider = install_provider(monkeypatch)
    monkeypatch.setattr(
        gate,
        "resolve",
        AsyncMock(
            return_value=gate.Resolution(
                status="RESOLVED",
                intent="DELIVERY_STATUS",
                confidence=1,
                message="",
            )
        ),
    )
    calls = []

    def commerce(request):
        assert failure != "missing_capability"
        assert request.method == "GET" and request.url.path.endswith("/delivery")
        calls.append(request)
        return httpx.Response(
            403 if failure == "denied" else 503 if failure == "unavailable" else 200,
            json={},
        )

    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={
                **headers(),
                **(
                    {}
                    if failure == "missing_capability"
                    else {"x-commerce-catalog-token": "catalog"}
                ),
            },
            json={"request_id": request_id, "message": "Can you deliver here?"},
        )
    assert response.status_code == 200 and "event: done" in response.text
    assert (
        "Delivery is available" not in response.text
        and "Delivery is not available" not in response.text
    )
    assert (
        '"code":"support_required"' if failure == "denied" else '"code":"unavailable"'
    ) in response.text
    assert len(calls) == (0 if failure == "missing_capability" else 1)
    assert not provider.requests and provider.closed


@pytest.mark.parametrize(
    "error_type", [ToolDenied, ToolUnavailable, asyncio.CancelledError]
)
def test_handler_propagates_failure_without_completion_or_retry(error_type):
    error = error_type()
    reader = SimpleNamespace(delivery=AsyncMock(side_effect=error))
    emitted, metadata = [], {}

    def event(kind, **fields):
        value = {"type": kind, **fields}
        emitted.append(value)
        return value

    stream = delivery_events(
        commerce_tools=lambda: reader, metadata=metadata, make_event=event
    )
    with pytest.raises(error_type) as caught:
        asyncio.run(collect(stream))
    assert caught.value is error
    assert emitted == [{"type": "progress", "stage": "catalog"}]
    assert "completion_evidence" not in metadata
    reader.delivery.assert_awaited_once_with()


def test_closing_after_progress_does_not_construct_delivery_reader():
    factory = Mock(side_effect=AssertionError("Closed delivery stream read commerce"))
    metadata = {}
    stream = delivery_events(
        commerce_tools=factory,
        metadata=metadata,
        make_event=lambda kind, **fields: {"type": kind, **fields},
    )

    async def run():
        assert (await anext(stream)) == {"type": "progress", "stage": "catalog"}
        await stream.aclose()
        with pytest.raises(StopAsyncIteration):
            await anext(stream)

    asyncio.run(run())
    factory.assert_not_called()
    assert metadata == {"route_reason": "delivery_status"}
