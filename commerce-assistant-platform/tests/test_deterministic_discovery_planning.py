"""Resolved language plans must satisfy planning dependencies without an LLM."""

import asyncio
import json

import httpx
import pytest
from test_catalog_schema import catalog_schema
from test_shopping import TENANT, WHO, interpreted, product

from app.commerce_action_engine.application.catalog import registry
from app.commerce_action_engine.application.shopping import shopping_answer
from app.commerce_action_engine.execution.agents import default_agents
from app.commerce_action_engine.execution.language.gate import Resolution
from app.commerce_action_engine.platform import TurnTrace, trace_turn


@pytest.mark.parametrize(
    "intent,message",
    [
        ("PRODUCT_RECOMMEND", "pls recommend best fish"),
        ("PRODUCT_SEARCH", "find fish"),
    ],
)
def test_resolved_discovery_completes_planning_without_model(intent, message):

    async def run():
        calls = []

        class NoModel:
            async def generate(self, request):
                raise AssertionError("resolved language must not call a model")

        def handler(request):
            body = json.loads(request.content)
            calls.append(body["name"])
            if body["name"] == "get_catalog_schema":
                return httpx.Response(
                    200,
                    json={
                        "products": [],
                        "category": None,
                        "catalog_schema": catalog_schema("grocery", []),
                    },
                )
            assert body["name"] == "search_products"
            assert body["arguments"]["query"] == "fish"
            return httpx.Response(
                200,
                json={
                    "products": [product(name="Fresh fish", category="Fish")],
                    "category": None,
                },
            )

        interpretation = interpreted(
            Resolution(
                status="RESOLVED",
                intent=intent,
                confidence=0.99,
                message="Understood.",
                entities={"productText": "fish"},
            )
        )
        trace = TurnTrace()
        async with httpx.AsyncClient(
            base_url="http://assistant-tools:8081",
            transport=httpx.MockTransport(handler),
        ) as client:
            tools = {
                tool.definition.name: tool
                for tool in registry(client, "catalog-token", WHO, {})
            }
            with trace_turn(trace):
                answer = await shopping_answer(
                    message,
                    NoModel(),
                    default_agents(TENANT).load(TENANT, "shopper"),
                    WHO,
                    tools,
                    grounded_intent=True,
                    commerce_meaning=True,
                    commerce_planning=True,
                    interpretation=interpretation,
                )
        assert answer is not None and "Fresh fish" in answer.text
        assert calls == ["get_catalog_schema", "search_products"]
        steps = {step["step"]: step for step in trace.planning["skills"]}
        assert steps["interpret"]["completed"] == 1
        assert steps["search"]["completed"] == 1
        assert steps["rank"]["completed"] == 1
        assert trace.planning["reserved_model_cost_micros"] == 0
        assert trace.planning["reserved_tokens"] == 0

    asyncio.run(run())
