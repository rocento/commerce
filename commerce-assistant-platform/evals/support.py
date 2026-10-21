"""Synthetic transport only; production runtime, schema validation and ranking execute unchanged."""

import json
from uuid import UUID

import httpx

from app.commerce_action_engine.actions.shopping import ShoppingIntent
from app.commerce_action_engine.application.catalog import registry
from app.commerce_action_engine.application.shopping import shopping_answer
from app.commerce_action_engine.execution.agents import (
    AgentCatalog,
    Principal,
    default_agents,
)
from app.commerce_resolution_engine.contracts import ModelResponse, Usage
from app.commerce_resolution_engine.runtime import AgentRuntime

TENANT = UUID(int=1)
PRINCIPAL = Principal(tenant=TENANT, persona="shopper")
SCHEMA = {
    "industry": None,
    "version": "gold-1",
    "attributes": [
        {
            "code": code,
            "label": code,
            "data_type": kind,
            "options": [{"code": "black", "label": "Black", "labels": {}}]
            if code == "color"
            else [],
            "filterable": True,
            "searchable": True,
            "facetable": False,
            "sortable": False,
            "comparable": True,
            "variant_axis": True,
            "source_policy": "factual",
            "unit": None,
            "min": None,
            "max": None,
        }
        for code, kind in [
            ("color", "select"),
            ("size", "integer"),
            ("material", "text"),
        ]
    ],
}


async def run_shopping(message, plan, products, reference=None, history=()):
    requests = []
    model_requests = []

    class Provider:
        async def generate(self, request):
            model_requests.append(request)
            return ModelResponse(
                "DO NOT DISPLAY MODEL PROSE",
                (),
                ShoppingIntent(**{"shopping": True, "query": "shoes", **plan}),
                Usage(1, 1, 2),
                "gold-fixture",
                "stop",
            )

    def transport(request):
        assert request.url.path == "/v1/assistant-tools/shopper"
        assert request.headers["authorization"] == "Bearer gold-token"
        body = json.loads(request.content)
        requests.append(body)
        return httpx.Response(
            200,
            json={
                "products": []
                if body["name"] == "get_catalog_schema"
                else [reference]
                if body["name"] == "get_product"
                else products,
                "category": None,
                "catalog_schema": SCHEMA
                if body["name"] == "get_catalog_schema"
                else None,
            },
        )

    async with httpx.AsyncClient(
        base_url="http://assistant-tools:8081", transport=httpx.MockTransport(transport)
    ) as client:
        runtime = AgentRuntime(
            AgentCatalog((default_agents(TENANT).load(TENANT, "shopper"),)),
            {"default": Provider()},
            registry(client, "gold-token", PRINCIPAL, {}),
            shopping=True,
            shopping_handler=shopping_answer,
        )
        events = [
            event
            async for event in runtime.stream(
                agent_id="shopper",
                principal=PRINCIPAL,
                message=message,
                history=history,
            )
        ]
    return events[-1].answer, requests, model_requests
