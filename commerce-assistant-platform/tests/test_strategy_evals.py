"""Executable strategy fixtures through the real chat SSE boundary; no paid calls."""

import importlib
import json
from dataclasses import replace
from pathlib import Path
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import (
    identity as identity,  # noqa: PLC0414 -- expose the pytest fixture
)
from test_bestseller_periods import interpret

from app.commerce_action_engine.execution.language import gate
from app.commerce_contracts.language_proposal import LanguageProposal
from app.commerce_resolution_engine.contracts import (
    ModelError,
    ModelResponse,
    ToolCall,
    Usage,
)
from app.main import create_app

CASES = json.loads(
    (Path(__file__).parents[1] / "evals/strategy-core.json").read_text()
)["scenarios"]


@pytest.mark.parametrize("small", [False, True], ids=["baseline", "small-model"])
@pytest.mark.parametrize("case", CASES, ids=lambda c: c["store"] + "-" + c["route"])
def test_strategy_sse(case, small, identity, monkeypatch, tmp_path):
    config, request_id, headers = identity
    policies = tmp_path / "policies.json"
    policies.write_text(
        json.dumps(
            {
                "answers": [
                    {
                        "phrases": ["What is your return policy?"],
                        "answer": "Fixture approved returns answer.",
                    }
                ]
            }
        )
    )
    config = replace(
        config,
        exact_policy_file=str(policies),
        small_model_name="fixture-small",
        feature_flags=frozenset({"small_model"}) if small else frozenset(),
    )
    providers = []
    deterministic = {
        "cart_status": "VIEW_CART",
        "delivery_status": "DELIVERY_STATUS",
        "exact_policy": "RETURN_POLICY",
    }
    canonical = (
        "compare two gold rings"
        if case["store"] == "jewelry"
        else "show oats in stock"
        if case["route"] == "unavailable_stock"
        else "show Breakfast under $20"
    )
    proposed_intent = (
        "PRODUCT_COMPARE" if case["store"] == "jewelry" else "PRODUCT_SEARCH"
    )

    resolutions = []

    async def resolve(url, text):
        resolutions.append(text)
        if case["route"] in deterministic:
            return gate.Resolution(
                status="RESOLVED",
                intent=deterministic[case["route"]],
                confidence=1,
                message="",
            )
        if text == case["prompt"]:
            return gate.Resolution(status="UNKNOWN", confidence=0, message="")
        assert text == canonical
        if case["store"] == "jewelry" and case["route"] == "catalog_model":
            # Exercise UNKNOWN admission, then revalidate the proposal with the
            # real parser so comparison references cannot drift out of the fixture.
            return interpret(text)
        entities = (
            {
                "productText": "Breakfast",
                "price": {"value": 20, "operator": "<", "currency": "USD"},
            }
            if case["route"] == "catalog_model" and case["store"] == "grocery"
            else {"productText": "oats"}
            if case["route"] == "unavailable_stock"
            else {}
        )
        return gate.Resolution(
            status="RESOLVED",
            intent=proposed_intent,
            confidence=1,
            message="",
            entities=entities,
        )

    monkeypatch.setattr(gate, "resolve", resolve)

    class Provider:
        def __init__(self, name):
            self.name, self.calls, self.closed = name, 0, False
            providers.append(self)

        async def generate(self, request):
            self.calls += 1
            assert request.output_schema is LanguageProposal
            if case["route"] == "provider_outage":
                raise ModelError("unavailable")
            if case["route"] == "security":
                return ModelResponse(
                    "",
                    (ToolCall("bad", "delete_orders", {}),),
                    None,
                    Usage(10, 5, 15),
                    self.name,
                    "tool_calls",
                )
            return ModelResponse(
                "PRIVATE MODEL PROSE",
                (),
                LanguageProposal(
                    status="INTERPRETED",
                    intent=proposed_intent,
                    canonical_text=canonical,
                ),
                Usage(10, 5, 15),
                self.name,
                "stop",
            )

        async def stream(self, request):
            pytest.fail("UNKNOWN must not start a free-text model/tool loop")
            yield  # pragma: no cover

        async def aclose(self):
            self.closed = True

    module = importlib.import_module("app.commerce_action_engine.application.bootstrap")
    monkeypatch.setattr(module, "build_provider", lambda _: Provider("fixture-default"))
    monkeypatch.setattr(module, "OpenAIProvider", lambda **_: Provider("fixture-small"))
    product_id = str(UUID(int=11))
    commerce_requests = []

    def commerce(request):
        commerce_requests.append(request)
        if request.url.path.endswith("/cart"):
            return httpx.Response(
                200,
                json={
                    "items": [],
                    "subtotal": "0",
                    "discount_amount": "0",
                    "currency": "USD",
                    "fully_reserved": False,
                },
            )
        if request.url.path.endswith("/delivery"):
            return httpx.Response(
                200, json={"configured": True, "deliverable": False, "area_id": None}
            )
        call = json.loads(request.content)
        if call["name"] == "get_catalog_schema":
            return httpx.Response(
                200,
                json={
                    "products": [],
                    "category": None,
                    "catalog_schema": {
                        "industry": case["store"],
                        "version": "v1",
                        "attributes": [],
                    },
                },
            )
        return httpx.Response(
            200,
            json={
                "category": None,
                "products": [
                    {
                        "id": product_id,
                        "name": "Fixture oats"
                        if case["store"] == "grocery"
                        else "Fixture ring",
                        "price": "12",
                        "currency": "USD",
                        "category_id": str(UUID(int=20)),
                        "product_type": "simple",
                        "attributes": [],
                        "in_stock": case.get("stock", True),
                        "route": f"/products/{product_id}",
                    }
                ],
            },
        )

    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={
                **headers(),
                "x-commerce-catalog-token": "catalog",
                "x-commerce-cart-token": "cart",
            },
            json={"request_id": request_id, "message": case["prompt"]},
        )
    assert response.status_code == 200
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert events[-1]["type"] == "done"
    assert [event["sequence"] for event in events] == list(range(len(events)))
    calls = sum(p.calls for p in providers)
    if "provider_calls" in case:
        assert calls == case["provider_calls"]
    else:
        assert calls <= case["provider_calls_max"]
    if case["route"] == "provider_outage":
        assert any(e["type"] == "error" for e in events)
    else:
        assert not any(e["type"] == "error" for e in events)
    if case["route"] == "security":
        assert "Please restate the full request" in response.text
    for text in case.get("must_contain", []):
        assert text in response.text
    for text in case.get("must_not_contain", []):
        assert text not in response.text
    assert "PRIVATE MODEL PROSE" not in response.text
    if "expected_blocks" in case:
        assert resolutions == [case["prompt"], canonical]
        assert [block for event in events for block in event.get("blocks", [])] == case[
            "expected_blocks"
        ]
    if "commerce_calls" in case:
        assert len(commerce_requests) == case["commerce_calls"]
    if small and calls:
        assert next(p for p in providers if p.name == "fixture-small").calls == 1
        if case["route"] not in {"security"}:
            assert next(p for p in providers if p.name == "fixture-default").calls == 0
    assert all(p.closed for p in providers)
