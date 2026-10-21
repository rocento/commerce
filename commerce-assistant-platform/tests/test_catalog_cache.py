import asyncio
from copy import deepcopy
from uuid import UUID

import httpx
import pytest
from test_catalog_tools import DATA, PRODUCT, WHO

from app.commerce_action_engine.actions.catalog import ProductArgs
from app.commerce_action_engine.actions.catalog.cache import CatalogCache
from app.commerce_action_engine.application.catalog import registry
from app.commerce_action_engine.platform.singleflight import SingleFlight
from app.commerce_action_engine.shared.errors import ToolDenied


def test_revision_change_authorization_failure_and_expiry():
    async def run():
        cache = CatalogCache()
        revision, status = '"one"', 200
        data = deepcopy(DATA)
        requests = []

        def backend(request):
            requests.append(request)
            if status == 403:
                return httpx.Response(403)
            if request.headers.get("if-none-match") == revision:
                return httpx.Response(304, headers={"etag": revision})
            return httpx.Response(200, json=data, headers={"etag": revision})

        async with httpx.AsyncClient(
            base_url="http://assistant-tools:8081",
            transport=httpx.MockTransport(backend),
        ) as client:

            def tool(who=WHO, location=None):
                return next(
                    t
                    for t in registry(
                        client, "capability", who, location or {}, cache=cache
                    )
                    if t.definition.name == "get_product"
                )

            async def read(who=WHO, location=None):
                return await tool(who, location).handler(
                    ProductArgs(product_id=PRODUCT), who
                )

            first = await read()
            first.products[0].price = "999"
            assert (await read()).products[0].price == "12.50"
            assert len(requests) == 2  # Even a hit reauthorizes at the backend.
            assert requests[-1].headers["if-none-match"] == revision
            revision = '"two"'
            data["products"][0]["price"] = "14"
            data["products"][0]["in_stock"] = False
            fresh = await read()
            assert (
                fresh.products[0].price == "14" and fresh.products[0].in_stock is False
            )
            status = 403
            with pytest.raises(ToolDenied):
                await read()
            status = 200
            await read(WHO.model_copy(update={"tenant": UUID(int=90)}))
            assert "if-none-match" not in requests[-1].headers
            await read(
                location={"x-delivery-latitude": "30", "x-delivery-longitude": "31"}
            )
            assert "if-none-match" not in requests[-1].headers
            cache.entries.clear()
            cache.ttl = 0
            await read()
            await read()
            assert "if-none-match" not in requests[-1].headers

    asyncio.run(run())


def test_coalescing_never_borrows_another_capability():
    async def run():
        tokens = []

        async def backend(request):
            tokens.append(request.headers["authorization"])
            await asyncio.sleep(0.01)
            if request.headers["authorization"] == "Bearer revoked":
                return httpx.Response(403)
            return httpx.Response(200, json=DATA)

        flight = SingleFlight()
        async with httpx.AsyncClient(
            base_url="http://assistant-tools:8081",
            transport=httpx.MockTransport(backend),
        ) as client:

            async def read(token):
                t = next(
                    t
                    for t in registry(client, token, WHO, {}, flight)
                    if t.definition.name == "get_product"
                )
                return await t.handler(ProductArgs(product_id=PRODUCT), WHO)

            results = await asyncio.gather(
                read("valid"), read("valid"), read("revoked"), return_exceptions=True
            )
            assert len(tokens) == 2
            assert isinstance(results[-1], ToolDenied)
            assert results[0] is not results[1]

    asyncio.run(run())


def test_cache_has_bounded_memory():
    cache = CatalogCache(limit=2)
    for key in ("a", "b", "c"):
        cache.put(key, '"revision"', b"{}")
    assert cache.get("a") is None and len(cache.entries) == 2
