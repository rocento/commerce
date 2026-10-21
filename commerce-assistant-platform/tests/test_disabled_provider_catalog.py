"""Real application admission/runtime wiring with an absent model provider.

Only the external commerce HTTP peer and resolver response are controlled here;
the full current-source Docker journey is exercised by the system QA harness.
"""

import json

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_catalog_schema import catalog_schema
from test_shopping import product

from app.commerce_action_engine.execution.language import gate
from app.commerce_resolution_engine.providers import UnconfiguredModel
from app.main import create_app


@pytest.mark.parametrize("known", [True, False])
def test_catalog_reads_without_a_provider_keep_unknown_requests_closed(
    identity, monkeypatch, known
):
    config, request_id, headers = identity
    calls = []

    async def resolve(url, text):
        return gate.Resolution(
            status="RESOLVED" if known else "UNKNOWN",
            intent="PRODUCT_SEARCH" if known else None,
            confidence=1 if known else 0,
            message="",
            entities={"productText": "shoes"} if known else {},
        )

    async def forbidden_model(*args, **kwargs):
        pytest.fail(
            "An absent provider must not be invoked for deterministic reads or UNKNOWN admission"
        )

    def commerce(request):
        assert request.url.path == "/v1/assistant-tools/shopper"
        assert request.headers["authorization"] == "Bearer catalog-only"
        call = json.loads(request.content)
        calls.append(call)
        if call["name"] == "get_catalog_schema":
            return httpx.Response(
                200,
                json={
                    "products": [],
                    "category": None,
                    "catalog_schema": catalog_schema("general", []),
                },
            )
        assert call["name"] == "search_products"
        assert call["arguments"]["query"] == "shoes"
        return httpx.Response(200, json={"products": [product()], "category": None})

    monkeypatch.setattr(gate, "resolve", resolve)
    monkeypatch.setattr(UnconfiguredModel, "generate", forbidden_model)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**headers(), "X-Commerce-Catalog-Token": "catalog-only"},
            json={
                "request_id": request_id,
                "message": "find shoes" if known else "incomprehensible qzx",
            },
        )
    assert response.status_code == 200
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert events[-1]["type"] == "done"
    assert not any(event["type"] == "error" for event in events), events
    if known:
        assert any(event["type"] == "content.blocks" for event in events), events
        assert [call["name"] for call in calls] == [
            "get_catalog_schema",
            "search_products",
        ]
    else:
        assert calls == []
        assert not any(event["type"] == "content.blocks" for event in events)
