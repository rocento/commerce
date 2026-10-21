import asyncio
import json
from uuid import UUID

import httpx
import pytest
from pydantic import ValidationError

from app.commerce_action_engine.actions.catalog import (
    SHOPPER_TOOLS,
    CatalogResult,
    ProductArgs,
)
from app.commerce_action_engine.application.catalog import registry
from app.commerce_action_engine.execution.agents import (
    DEFAULT_SHOPPER_TOOLS,
    Principal,
    default_agents,
)


def test_default_agent_policy_matches_catalog_registry():
    assert DEFAULT_SHOPPER_TOOLS == SHOPPER_TOOLS


from app.commerce_action_engine.shared.errors import ToolDenied
from app.commerce_resolution_engine.contracts import (
    ModelEvent,
    ModelResponse,
    ToolCall,
    Usage,
)
from app.commerce_resolution_engine.runtime import AgentRuntime, RuntimeErrorCode

TENANT = UUID(int=1)
PRODUCT = str(UUID(int=2))
WHO = Principal(tenant=TENANT, persona="shopper")
DATA = {
    "products": [
        {
            "id": PRODUCT,
            "name": "Fruit",
            "price": "12.50",
            "currency": "USD",
            "category_id": str(UUID(int=3)),
            "product_type": "simple",
            "attributes": [],
            "in_stock": None,
            "route": f"/products/{PRODUCT}",
        }
    ],
    "category": None,
}


def test_search_filters_preserve_facade_types_and_reject_duplicate_names():
    from app.commerce_action_engine.actions.catalog import (
        SearchAttribute,
        SearchToolArgs,
    )

    async def scenario():
        calls = []

        def handle(request):
            calls.append(json.loads(request.content))
            return httpx.Response(200, json=DATA)

        async with httpx.AsyncClient(
            base_url="http://assistant-tools:8081",
            transport=httpx.MockTransport(handle),
        ) as client:
            tool = next(
                t
                for t in registry(client, "token", WHO, {})
                if t.definition.name == "search_products"
            )
            values = {"brand": "Acme", "organic": False, "count": 2, "weight": 1.5}
            args = SearchToolArgs(
                query="fruit",
                attributes=[
                    SearchAttribute(name=k, value=v) for k, v in values.items()
                ],
            )
            await tool.handler(args, WHO)
            assert calls[0]["arguments"]["attributes"] == values
            assert type(calls[0]["arguments"]["attributes"]["organic"]) is bool
            assert type(calls[0]["arguments"]["attributes"]["count"]) is int
            args.attributes.append(SearchAttribute(name="brand", value="Different"))
            with pytest.raises(ValueError, match="Duplicate attribute"):
                await tool.handler(args, WHO)
            assert len(calls) == 1

    asyncio.run(scenario())


def test_registry_metadata_and_fixed_transport():
    async def scenario():
        def handler(request):
            assert request.url.path == "/v1/assistant-tools/shopper"
            assert request.method == "POST"
            assert request.headers["authorization"] == "Bearer scoped-catalog-token"
            assert "evil-header" not in request.headers
            assert request.headers["x-delivery-latitude"] == "30"
            assert json.loads(request.content)["name"] in SHOPPER_TOOLS
            return httpx.Response(200, json=DATA)

        async with httpx.AsyncClient(
            base_url="http://assistant-tools:8081",
            transport=httpx.MockTransport(handler),
        ) as client:
            tools = registry(
                client,
                "scoped-catalog-token",
                WHO,
                {"x-delivery-latitude": "30", "evil-header": "secret"},
            )
            assert len(tools) == 8
            for t in tools:
                assert t.classification == "read" and t.personas == frozenset(
                    {"shopper"}
                )
                assert t.output is CatalogResult and t.timeout_seconds == 5
            t = next(t for t in tools if t.definition.name == "get_product")
            result = await t.handler(ProductArgs(product_id=PRODUCT), WHO)
            assert result.products[0].in_stock is None
            with pytest.raises(ValueError):
                await t.handler(
                    ProductArgs(product_id=PRODUCT),
                    Principal(tenant=TENANT, persona="merchant", subject=UUID(int=4)),
                )

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "data",
    [
        {},
        {**DATA, "unexpected": "private"},
        {
            "products": [{**DATA["products"][0], "route": "javascript:alert(1)"}],
            "category": None,
        },
        {"products": DATA["products"] * 9, "category": None},
    ],
)
def test_invalid_contract_rejected(data):
    with pytest.raises(ValidationError):
        CatalogResult.model_validate(data)


@pytest.mark.parametrize("status", [401, 403, 429, 503])
def test_tool_failures_are_safe_runtime_errors(status):
    class Provider:
        async def stream(self, request):
            yield ModelEvent(
                "completed",
                response=ModelResponse(
                    "",
                    (ToolCall("c1", "get_product", {"product_id": PRODUCT}),),
                    None,
                    Usage(1, 1, 2),
                    "test",
                    "tool_calls",
                ),
            )

    async def scenario():
        async with httpx.AsyncClient(
            base_url="http://assistant-tools:8081",
            transport=httpx.MockTransport(
                lambda _: httpx.Response(status, text="secret-canary")
            ),
        ) as client:
            runtime = AgentRuntime(
                default_agents(TENANT),
                {"default": Provider()},
                registry(client, "token", WHO, {}),
            )
            with pytest.raises(ToolDenied if status == 403 else RuntimeErrorCode) as e:
                _ = [
                    event
                    async for event in runtime.stream(
                        agent_id="shopper", principal=WHO, message="Find fruit"
                    )
                ]
            assert "secret-canary" not in str(e.value)

    asyncio.run(scenario())


def test_runtime_roundtrip_with_live_fact_projection():
    class Provider:
        def __init__(self):
            self.count = 0

        async def stream(self, request):
            self.count += 1
            assert {tool.name for tool in request.tools} == SHOPPER_TOOLS
            if self.count == 1:
                yield ModelEvent(
                    "completed",
                    response=ModelResponse(
                        "",
                        (ToolCall("c1", "get_product_price", {"product_id": PRODUCT}),),
                        None,
                        Usage(1, 1, 2),
                        "test",
                        "tool_calls",
                    ),
                )
            else:
                result = json.loads(request.tool_results[0].output)
                assert result["products"][0]["price"] == "12.50"
                assert result["products"][0]["in_stock"] is None
                text = "Catalog price is 12.50 USD; delivery availability is unknown."
                yield ModelEvent("text_delta", text)
                yield ModelEvent(
                    "completed",
                    response=ModelResponse(
                        text, (), None, Usage(1, 1, 2), "test", "stop"
                    ),
                )

    async def scenario():
        async with httpx.AsyncClient(
            base_url="http://assistant-tools:8081",
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json=DATA)),
        ) as client:
            runtime = AgentRuntime(
                default_agents(TENANT),
                {"default": Provider()},
                registry(client, "token", WHO, {}),
            )
            events = [
                event
                async for event in runtime.stream(
                    agent_id="shopper", principal=WHO, message="Price?"
                )
            ]
            assert events[-1].answer.tool_calls == 1
            assert "12.50 USD" in events[-1].answer.text

    asyncio.run(scenario())


def test_catalog_accepts_eight_results():
    assert (
        len(
            CatalogResult.model_validate(
                {"products": DATA["products"] * 8, "category": None}
            ).products
        )
        == 8
    )
