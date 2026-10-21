"""Bestseller dispatch uses standard interpretation and verified sales reads."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_cart_handler import collect
from test_language_fallback import install_provider, proposal, unknown
from test_shopping import product

from app.commerce_action_engine.application.handlers import bestsellers
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable
from app.commerce_resolution_engine.admission import require_permit
from app.main import create_app


def result(period="today"):
    return {
        "products": [
            product(1, name="Sales winner", price="7"),
            product(2, name="Runner up", price="50"),
        ],
        "period": period,
        "start": "2026-01-01T00:00:00Z",
        "end": "2026-02-01T00:00:00Z",
        "timezone": "UTC",
        "metric": "completed_order_units",
        "ranked_limit": 50,
    }


def standard(entities):
    return InterpretedRequest(
        request_id=str(UUID(int=1)),
        status="RESOLVED",
        legacy_intent="PRODUCT_RECOMMEND",
        primary_intent="PRODUCT_BESTSELLERS",
        message="",
        confidence={"raw": 1},
        entities=entities,
    )


def resolved(period="today"):
    return gate.Resolution(
        status="RESOLVED",
        intent="PRODUCT_RECOMMEND",
        primaryIntent="PRODUCT_BESTSELLERS",
        confidence=1,
        message="Choose a sales period.",
        entities={"salesPeriod": period},
    )


def events(response):
    return [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]


@pytest.mark.parametrize("period", ["today", "last_week", "last_month", "last_year"])
@pytest.mark.parametrize("after_proposal", [False, True])
@pytest.mark.parametrize("guest", [False, True])
def test_standard_request_preserves_scoped_sales_and_presentation(
    identity, monkeypatch, period, after_proposal, guest
):
    config, request_id, headers = identity
    message = "recommend best sellers " + period.replace("_", " ")
    provider = install_provider(monkeypatch, proposal("PRODUCT_RECOMMEND", message))
    calls, attempts, received = [], [], []
    original = bestsellers.bestseller_events

    async def resolve(url, text):
        attempts.append(text)
        return unknown() if after_proposal and len(attempts) == 1 else resolved(period)

    async def observe(**kwargs):
        assert set(kwargs) == {"request", "commerce_tools", "metadata", "make_event"}
        request = kwargs["request"]
        assert isinstance(request, InterpretedRequest)
        assert request.request_id == request_id
        assert request.legacy_intent == "PRODUCT_RECOMMEND"
        assert request.primary_intent == "PRODUCT_BESTSELLERS"
        assert request.entities == {"salesPeriod": period}
        with pytest.raises(PermissionError):
            require_permit(UUID(request_id))
        received.append(kwargs["metadata"])
        async for event in original(**kwargs):
            yield event

    def commerce(request):
        calls.append(request)
        assert (
            request.method == "POST"
            and request.url.path == "/v1/assistant-tools/shopper"
        )
        assert request.headers["authorization"] == "Bearer catalog"
        assert request.headers["x-delivery-latitude"] == "30.1"
        assert request.headers["x-delivery-longitude"] == "31.2"
        assert json.loads(request.content) == {
            "name": "get_bestsellers",
            "arguments": {"period": period},
        }
        return httpx.Response(200, json=result(period))

    monkeypatch.setattr(gate, "resolve", resolve)
    monkeypatch.setattr(bestsellers, "bestseller_events", observe)
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
    output = events(response)
    assert response.status_code == 200 and len(calls) == len(received) == 1
    assert output[-1]["type"] == "done"
    assert [e["sequence"] for e in output] == list(range(len(output)))
    assert [e["type"] for e in output if e["type"] != "progress"] == [
        "content.blocks",
        "message.delta",
        "done",
    ]
    block = next(e["blocks"][0] for e in output if e["type"] == "content.blocks")
    assert [p["name"] for p in block["products"]] == ["Sales winner", "Runner up"]
    assert [p["price"] for p in block["products"]] == ["7", "50"]
    label = period.replace("_", " ")
    assert output[-2]["text"] == (
        f"Best sellers {label} across the store (2026-01-01 00:00 to 2026-02-01 00:00 UTC), ranked by units in completed orders placed during that period. "
        "Showing current catalog products from the top 50 ranked products. Prices shown are current."
    )
    assert (
        received[0]["tools"] == ["get_bestsellers"] and received[0]["tool_calls"] == 1
    )
    assert "completion_evidence" not in received[0]
    assert len(provider.requests) == int(after_proposal) and len(attempts) == 1 + int(
        after_proposal
    )
    assert provider.closed and not hasattr(gate, "current")


@pytest.mark.parametrize(
    "failure",
    [
        "missing_capability",
        "denied",
        "wrong_period",
        "reversed_dates",
        "invalid_receipt",
    ],
)
def test_failed_sales_read_never_claims_ranking_or_falls_back(
    identity, monkeypatch, failure
):
    config, request_id, headers = identity
    provider = install_provider(monkeypatch)
    monkeypatch.setattr(gate, "resolve", AsyncMock(return_value=resolved()))
    calls = []

    def commerce(request):
        calls.append(request)
        assert json.loads(request.content)["name"] == "get_bestsellers"
        payload = result()
        if failure == "wrong_period":
            payload["period"] = "last_week"
        if failure == "reversed_dates":
            payload["start"], payload["end"] = payload["end"], payload["start"]
        return httpx.Response(
            403 if failure == "denied" else 200,
            json={} if failure == "invalid_receipt" else payload,
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
            json={"request_id": request_id, "message": "best sellers today"},
        )
    output = events(response)
    assert response.status_code == 200 and output[-1]["type"] == "done"
    assert len(calls) == int(failure != "missing_capability")
    assert not any(e["type"] == "content.blocks" for e in output)
    assert (
        "Sales winner" not in response.text and "ranked by units" not in response.text
    )
    assert output[-2]["code"] == (
        "support_required" if failure == "denied" else "unavailable"
    )
    assert not provider.requests and provider.closed


@pytest.mark.parametrize("period", [None, "tomorrow", ["today"], 1])
def test_invalid_period_keeps_existing_clarification_without_reads(
    identity, monkeypatch, period
):
    config, request_id, headers = identity
    provider = install_provider(monkeypatch)
    monkeypatch.setattr(gate, "resolve", AsyncMock(return_value=resolved(period)))
    commerce = Mock(side_effect=AssertionError("Invalid period reached commerce"))
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**headers(), "x-commerce-catalog-token": "catalog"},
            json={"request_id": request_id, "message": "best sellers"},
        )
    assert "Choose a sales period." in response.text and "event: done" in response.text
    commerce.assert_not_called()
    assert not provider.requests and provider.closed


@pytest.mark.parametrize(
    "entities",
    [
        {},
        {"salesPeriod": None},
        {"salesPeriod": "tomorrow"},
        {"salesPeriod": ["today"]},
        {"salesPeriod": 1},
        {"salesPeriod": "TODAY"},
    ],
)
def test_invalid_domain_period_cannot_construct_a_reader_or_default(entities):
    factory = Mock(side_effect=AssertionError("Invalid period constructed a reader"))
    make_event = Mock(side_effect=AssertionError("Invalid period emitted a result"))
    metadata = {}
    with pytest.raises(ValueError, match="supported sales period"):
        asyncio.run(
            collect(
                bestsellers.bestseller_events(
                    request=standard(entities),
                    commerce_tools=factory,
                    metadata=metadata,
                    make_event=make_event,
                )
            )
        )
    factory.assert_not_called()
    make_event.assert_not_called()
    assert metadata == {}


@pytest.mark.parametrize(
    "error_type", [ToolDenied, ToolUnavailable, asyncio.CancelledError]
)
def test_handler_propagates_read_failure_without_ranking_or_retry(error_type):
    error = error_type()
    reader = SimpleNamespace(bestsellers=AsyncMock(side_effect=error))
    emitted = []

    def event(kind, **fields):
        value = {"type": kind, **fields}
        emitted.append(value)
        return value

    with pytest.raises(error_type) as caught:
        asyncio.run(
            collect(
                bestsellers.bestseller_events(
                    request=standard({"salesPeriod": "today"}),
                    commerce_tools=lambda: reader,
                    metadata={},
                    make_event=event,
                )
            )
        )
    assert caught.value is error
    assert emitted == [{"type": "progress", "stage": "catalog"}]
    reader.bestsellers.assert_awaited_once_with("today")


def test_closing_after_progress_does_not_read_sales():
    reader = SimpleNamespace(
        bestsellers=AsyncMock(side_effect=AssertionError("Closed stream read sales"))
    )
    stream = bestsellers.bestseller_events(
        request=standard({"salesPeriod": "today"}),
        commerce_tools=lambda: reader,
        metadata={},
        make_event=lambda kind, **fields: {"type": kind, **fields},
    )

    async def run():
        assert (await anext(stream))["type"] == "progress"
        await stream.aclose()

    asyncio.run(run())
    reader.bestsellers.assert_not_awaited()


@pytest.mark.parametrize(
    "scope, label",
    [("delivery_area", "in your delivery area"), ("global", "across the store")],
)
def test_bestseller_handler_reports_actual_ranking_scope(scope, label):
    from app.commerce_action_engine.actions.catalog.bestsellers import Bestsellers

    response = Bestsellers.model_validate({**result(), "scope": scope})
    reader = SimpleNamespace(bestsellers=AsyncMock(return_value=response))
    emitted = asyncio.run(
        collect(
            bestsellers.bestseller_events(
                request=standard({"salesPeriod": "today"}),
                commerce_tools=lambda: reader,
                metadata={},
                make_event=lambda kind, **fields: {"type": kind, **fields},
            )
        )
    )
    assert label in emitted[-1]["text"]
    reader.bestsellers.assert_awaited_once_with("today")
