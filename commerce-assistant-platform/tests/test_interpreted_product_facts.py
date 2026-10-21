"""Product facts use the standard request and authoritative catalog reads."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_language_fallback import install_provider, proposal, unknown
from test_product_facts import ring

from app.commerce_action_engine.application.handlers import product_facts
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.language import gate
from app.main import create_app


@pytest.mark.parametrize("after_proposal", [False, True])
@pytest.mark.parametrize("selected", [False, True])
@pytest.mark.parametrize(
    "intent,expected",
    [
        ("CHECK_PRICE", "120 USD"),
        ("CHECK_STOCK", "Availability for Classic Gold Ring is not confirmed."),
        ("PRODUCT_DETAILS", "current catalog details published"),
        ("PRODUCT_MATERIAL", "Material: gold"),
    ],
)
def test_standard_product_facts_preserve_reads_and_answers(
    identity, monkeypatch, after_proposal, selected, intent, expected
):
    config, request_id, headers = identity
    message = "Tell me about Classic Gold Ring"
    provider = install_provider(monkeypatch, proposal(intent, message))
    attempts, received, calls = [], [], []
    original = product_facts.product_fact_events
    current = ring(in_stock=None)

    async def observe(reader, request, make_event, metadata, **kwargs):
        assert isinstance(request, InterpretedRequest)
        assert request.request_id == request_id
        assert request.legacy_intent == intent
        assert request.primary_intent != intent
        received.append(request)
        async for event in original(reader, request, make_event, metadata, **kwargs):
            yield event

    async def resolve(url, text, *, context=None):
        assert context == (
            {"states": ["PRODUCT_SELECTED"]} if selected and not attempts else None
        )
        attempts.append(text)
        if after_proposal and len(attempts) == 1:
            return unknown()
        return gate.Resolution(
            status="RESOLVED",
            intent=intent,
            confidence=1,
            message="Understood.",
            primaryIntent="CHECK_PRICE"
            if intent != "CHECK_PRICE"
            else "PRODUCT_DETAILS",
            entities={"productText": "Classic Gold Ring"},
        )

    def commerce(request):
        assert request.url.path == "/v1/assistant-tools/shopper"
        assert request.headers["authorization"] == "Bearer catalog-read"
        body = json.loads(request.content)
        calls.append(body)
        assert body["name"] in {"search_products", "get_product"}
        return httpx.Response(200, json={"products": [current], "category": None})

    monkeypatch.setattr(gate, "resolve", resolve)
    monkeypatch.setattr(product_facts, "product_fact_events", observe)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**headers(), "x-commerce-catalog-token": "catalog-read"},
            json={
                "request_id": request_id,
                "message": message,
                **({"product_id": current["id"]} if selected else {}),
            },
        )
    assert response.status_code == 200
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert [event["type"] for event in events] == [
        "progress",
        "progress",
        "message.delta",
        "content.blocks",
        "done",
    ]
    assert [event["sequence"] for event in events] == list(range(len(events)))
    assert expected in events[2]["text"]
    assert events[3]["blocks"][0]["sources"][0]["product_id"] == current["id"]
    assert calls == (
        []
        if selected
        else [{"name": "search_products", "arguments": {"query": "Classic Gold Ring"}}]
    ) + [{"name": "get_product", "arguments": {"product_id": current["id"]}}]
    assert len(received) == 1
    assert len(provider.requests) == int(after_proposal)
    assert len(attempts) == 1 + int(after_proposal)
    assert provider.closed


@pytest.mark.parametrize("after_proposal", [False, True])
@pytest.mark.parametrize("case", ["invalid_interpretation", "no_capability", "denied"])
def test_product_facts_cannot_bypass_failure_or_catalog_authority(
    identity, monkeypatch, after_proposal, case
):
    config, request_id, headers = identity
    message = "Tell me the material of Classic Gold Ring"
    provider = install_provider(monkeypatch, proposal("PRODUCT_MATERIAL", message))
    attempts, calls = [], []

    async def resolve(url, text):
        attempts.append(text)
        if after_proposal and len(attempts) == 1:
            return unknown()
        return gate.Resolution(
            status="RESOLVED",
            intent="PRODUCT_MATERIAL",
            confidence=1,
            message="",
            entities={"items": "invalid"}
            if case == "invalid_interpretation"
            else {"productText": "Classic Gold Ring"},
        )

    def commerce(request):
        assert case == "denied", (
            "Invalid admission or absent capability reached commerce"
        )
        assert request.headers["authorization"] == "Bearer catalog-read"
        calls.append(json.loads(request.content)["name"])
        return httpx.Response(403, json={})

    monkeypatch.setattr(gate, "resolve", resolve)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={
                **headers(),
                **(
                    {"x-commerce-catalog-token": "catalog-read"}
                    if case != "no_capability"
                    else {}
                ),
            },
            json={"request_id": request_id, "message": message},
        )
    assert response.status_code == 200
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert events[-1]["type"] == "done"
    assert not any(event["type"] == "content.blocks" for event in events)
    assert "Material: gold" not in response.text
    assert calls == (["search_products"] if case == "denied" else [])
    assert len(provider.requests) == int(after_proposal)
    assert len(attempts) == 1 + int(after_proposal)
    assert provider.closed
