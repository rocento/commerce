"""Reorder review uses standard interpretation and scoped reads, never writes."""

import asyncio
import json
from unittest.mock import AsyncMock, Mock
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_cart_actions import interpreted
from test_cart_handler import collect
from test_language_fallback import install_provider, proposal, unknown
from test_order_read_routes import ORDER_ID, order
from test_reorder import resolved

from app.commerce_action_engine.actions.orders import reorder_read
from app.commerce_action_engine.application.handlers import reorder
from app.commerce_action_engine.contracts import AssistantOrder
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable
from app.commerce_resolution_engine.admission import require_permit
from app.main import create_app


@pytest.mark.parametrize("after_proposal", [False, True])
@pytest.mark.parametrize(
    "entities,selected_id,path,payload,numbers",
    [
        ({"order_reference": "5"}, ORDER_ID, "/orders/by-number/5", order(5), [5]),
        ({}, ORDER_ID, f"/orders/{ORDER_ID}", order(7), [7]),
        ({"orderSelection": "LATEST"}, None, "/orders", [order(9), order(8)], [9]),
        ({"orderSelection": "PREVIOUS"}, None, "/orders", [order(9), order(8)], [8]),
    ],
)
def test_standard_dispatch_performs_only_scoped_order_reads(
    identity, monkeypatch, after_proposal, entities, selected_id, path, payload, numbers
):
    config, request_id, headers = identity
    message = "reorder order 5" if "order_reference" in entities else "reorder my order"
    provider = install_provider(monkeypatch, proposal("REORDER", message))
    attempts, received, calls = [], [], []
    original = reorder.reorder_events

    async def observe(**kwargs):
        request = kwargs["request"]
        assert isinstance(request, InterpretedRequest)
        assert request.request_id == request_id and request.entities == entities
        assert request.legacy_intent == "REORDER"
        assert request.primary_intent == "ORDER_HISTORY"
        with pytest.raises(PermissionError):
            require_permit(UUID(request_id))
        received.append(request)
        async for event in original(**kwargs):
            yield event

    async def resolve(url, text):
        attempts.append(text)
        if after_proposal and len(attempts) == 1:
            return unknown()
        return resolved(entities=entities, primaryIntent="ORDER_HISTORY")

    def commerce(request):
        assert request.method == "GET"
        assert request.url.path == "/v1/assistant-tools" + path
        assert request.headers["authorization"] == "Bearer read"
        calls.append(request.url.path)
        return httpx.Response(200, json=payload)

    monkeypatch.setattr(gate, "resolve", resolve)
    monkeypatch.setattr(reorder, "reorder_events", observe)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**headers(), "x-commerce-tool-token": "read"},
            json={
                "request_id": request_id,
                "message": message,
                **({"order_id": selected_id} if selected_id else {}),
            },
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert response.status_code == 200
    assert len(received) == 1 and len(calls) == 1
    assert [
        e["order"]["number"] for e in events if e["type"] == "card.order"
    ] == numbers
    assert "no new order has been placed" in response.text
    assert events[-1]["type"] == "done"
    assert not any(e["type"] == "error" for e in events)
    assert [e["sequence"] for e in events] == list(range(len(events)))
    assert len(provider.requests) == int(after_proposal)
    assert provider.closed and not hasattr(gate, "current")


@pytest.mark.parametrize(
    "raw", ["0", "-1", "1.5", "abc", "9223372036854775808", "1" * 20]
)
def test_invalid_reference_does_not_fall_back_to_selected_order_or_history(raw):
    entities = {"order_reference": raw}
    assert reorder_read(entities, UUID(ORDER_ID)) is None
    factory = Mock(side_effect=AssertionError("Invalid reference created a reader"))
    events = asyncio.run(
        collect(
            reorder.reorder_events(
                request=interpreted(resolved(entities=entities)),
                commerce_tools=factory,
                selected_id=UUID(ORDER_ID),
                authenticated=True,
                make_event=lambda kind, **fields: {"type": kind, **fields},
            )
        )
    )
    assert len(events) == 1 and "valid order number" in events[0]["text"]
    factory.assert_not_called()


def test_nested_order_reference_precedes_selected_id_and_history_selection():
    reader = AsyncMock()
    reader.order_by_number.return_value = AssistantOrder.model_validate(order(5))
    query = reorder_read(
        {"order": {"resolvedReference": "0005"}, "orderSelection": "PREVIOUS"},
        UUID(ORDER_ID),
    )
    assert query is not None
    assert [o.number for o in asyncio.run(query.execute(reader))] == [5]
    reader.order_by_number.assert_awaited_once_with(5)
    reader.orders.assert_not_awaited()
    reader.call.assert_not_awaited()


@pytest.mark.parametrize(
    "count,selection,expected", [(12, None, 10), (0, None, 0), (1, "PREVIOUS", 0)]
)
def test_review_bounds_cards_and_handles_empty_history(count, selection, expected):
    reader = AsyncMock()
    reader.orders.return_value = [
        AssistantOrder.model_validate(order(n + 1)) for n in range(count)
    ]
    events = asyncio.run(
        collect(
            reorder.reorder_events(
                request=interpreted(
                    resolved(
                        entities={"orderSelection": selection} if selection else {}
                    )
                ),
                commerce_tools=lambda: reader,
                selected_id=None,
                authenticated=True,
                make_event=lambda kind, **fields: {"type": kind, **fields},
            )
        )
    )
    assert sum(e["type"] == "card.order" for e in events) == expected
    reader.orders.assert_awaited_once()
    assert (
        "no new order has been placed" in events[-1]["text"]
        if expected
        else "couldn't find" in events[-1]["text"]
    )


@pytest.mark.parametrize(
    "error_type", [ToolDenied, ToolUnavailable, asyncio.CancelledError]
)
def test_failed_or_cancelled_review_never_retries_or_claims_order_creation(error_type):
    reader = AsyncMock()
    error = error_type()
    reader.orders.side_effect = error
    stream = reorder.reorder_events(
        request=interpreted(resolved(entities={})),
        commerce_tools=lambda: reader,
        selected_id=None,
        authenticated=True,
        make_event=lambda kind, **fields: {"type": kind, **fields},
    )
    if error_type is ToolUnavailable:
        events = asyncio.run(collect(stream))
        assert [e["type"] for e in events] == ["progress", "message.delta"]
        assert "No new order was placed" in events[-1]["text"]
    else:
        with pytest.raises(error_type) as caught:
            asyncio.run(collect(stream))
        assert caught.value is error
    reader.orders.assert_awaited_once()
