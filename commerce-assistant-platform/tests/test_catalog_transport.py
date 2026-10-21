"""Adapter extraction preserves scoped reads, bounded responses and cancellation."""

import asyncio
import json
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import UUID

import httpx
import pytest
from test_catalog_tools import DATA, PRODUCT, WHO

from app.commerce_action_engine.actions.catalog import (
    CatalogCache,
    CatalogResult,
    ProductArgs,
    SchemaArgs,
    SearchToolArgs,
)
from app.commerce_action_engine.adapters.catalog import CatalogTransport
from app.commerce_action_engine.application.catalog import catalog_tools
from app.commerce_action_engine.platform.singleflight import SingleFlight
from app.commerce_action_engine.shared.errors import ToolDenied


def transport(
    client,
    *,
    token="token",
    principal=WHO,
    cache=None,
    flight=None,
    counters=None,
    reports=None,
):
    return CatalogTransport(
        client,
        token,
        principal,
        {},
        flight,
        cache,
        record_counter=(counters if counters is not None else []).append,
        record_discovery=(reports if reports is not None else []).append,
    )


@pytest.mark.parametrize("invalid", ["token", "principal", "persona", "operation"])
def test_invalid_execution_never_reaches_transport(invalid):
    async def run():
        backend = Mock(side_effect=AssertionError("Unauthorized catalog read"))
        counters, reports = [], []
        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            principal = (
                WHO.model_copy(update={"persona": "merchant", "subject": UUID(int=4)})
                if invalid == "persona"
                else WHO
            )
            reader = transport(
                client,
                token="" if invalid == "token" else "token",
                principal=principal,
                counters=counters,
                reports=reports,
            )
            caller = (
                WHO.model_copy(update={"tenant": UUID(int=99)})
                if invalid == "principal"
                else principal
            )
            with pytest.raises(ValueError):
                await reader.read(
                    "delete_product" if invalid == "operation" else "get_product",
                    ProductArgs(product_id=PRODUCT),
                    caller,
                )
        backend.assert_not_called()
        assert counters == reports == []

    asyncio.run(run())


@pytest.mark.parametrize(
    "name,limit",
    [
        ("get_product", 32768),
        ("search_products", 131072),
        ("get_catalog_schema", 131072),
    ],
)
@pytest.mark.parametrize("extra", [0, 1])
def test_response_limit_applies_before_caching(name, limit, extra):
    async def run():
        data = json.dumps(DATA).encode()
        body = data + b" " * (limit + extra - len(data))
        calls, counters, reports = [], [], []
        cache = CatalogCache()

        def backend(request):
            calls.append(request)
            return httpx.Response(200, content=body, headers={"etag": '"revision"'})

        args = (
            SearchToolArgs(query="fruit")
            if name == "search_products"
            else SchemaArgs()
            if name == "get_catalog_schema"
            else ProductArgs(product_id=PRODUCT)
        )
        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            reader = transport(client, cache=cache, counters=counters, reports=reports)
            if extra:
                with pytest.raises(ValueError, match="Tool response too large"):
                    await reader.read(name, args, WHO)
                assert not cache.entries and not reports
            else:
                result = await reader.read(name, args, WHO)
                assert result.products[0].price == "12.50"
                assert len(cache.entries) == 1 and reports == [None]
        assert len(calls) == 1 and counters == ["catalog_network_calls"]

    asyncio.run(run())


@pytest.mark.parametrize(
    "failure",
    [
        "no_cache",
        "wrong_revision",
        "missing_revision",
        "revoked",
        "timeout",
        "invalid_json",
    ],
)
def test_cached_reads_require_fresh_authorization_and_matching_revision(failure):
    async def run():
        calls, counters, reports = [], [], []
        cache = CatalogCache()

        def backend(request):
            calls.append(request)
            if len(calls) == 1 and failure != "no_cache":
                return httpx.Response(200, json=DATA, headers={"etag": '"one"'})
            if failure == "timeout":
                raise httpx.ReadTimeout("unavailable")
            if failure == "invalid_json":
                return httpx.Response(200, text="bad json", headers={"etag": '"two"'})
            if failure == "revoked":
                return httpx.Response(403, text="SECRET internal denial")
            return httpx.Response(
                304,
                headers={} if failure == "missing_revision" else {"etag": '"wrong"'},
            )

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            reader = transport(client, cache=cache, counters=counters, reports=reports)
            args = ProductArgs(product_id=PRODUCT)
            if failure != "no_cache":
                await reader.read("get_product", args, WHO)
            error = (
                ToolDenied
                if failure == "revoked"
                else httpx.ReadTimeout
                if failure == "timeout"
                else ValueError
            )
            with pytest.raises(error):
                await reader.read("get_product", args, WHO)
        assert len(calls) == (1 if failure == "no_cache" else 2)
        assert counters == ["catalog_network_calls"] * len(calls)
        assert len(reports) == int(failure != "no_cache")
        if failure != "no_cache":
            assert calls[-1].headers["if-none-match"] == '"one"'
            assert next(iter(cache.entries.values())).revision == '"one"'

    asyncio.run(run())


@pytest.mark.parametrize("cancel_all", [False, True])
def test_coalescing_cancellation_preserves_remaining_waiter_and_cleans_up(cancel_all):
    async def run():
        entered, release, closed = asyncio.Event(), asyncio.Event(), asyncio.Event()
        counters, reports, calls = [], [], []
        flight = SingleFlight()

        async def backend(request):
            calls.append(request)
            entered.set()
            try:
                await release.wait()
                return httpx.Response(200, json=DATA)
            finally:
                closed.set()

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            reader = transport(
                client, flight=flight, counters=counters, reports=reports
            )
            args = ProductArgs(product_id=PRODUCT)
            first = asyncio.create_task(reader.read("get_product", args, WHO))
            await asyncio.wait_for(entered.wait(), 1)
            second = asyncio.create_task(reader.read("get_product", args, WHO))
            await asyncio.sleep(0)
            assert list(flight.waiters.values()) == [2]
            first.cancel()
            with pytest.raises(asyncio.CancelledError):
                await first
            assert not closed.is_set() and list(flight.waiters.values()) == [1]
            if cancel_all:
                second.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await second
            else:
                release.set()
                result = await asyncio.wait_for(second, 1)
                assert result.products[0].price == "12.50"
            await asyncio.wait_for(closed.wait(), 1)
        assert not flight.tasks and not flight.waiters
        assert len(calls) == 1 and len(reports) == int(not cancel_all)
        assert counters == ["catalog_network_calls", "catalog_coalesced"]

    asyncio.run(run())


def test_runtime_composition_only_delegates_fixed_read_operations():
    result = CatalogResult.model_validate(DATA)
    reader = SimpleNamespace(read=AsyncMock(return_value=result))
    tools = catalog_tools(reader)
    assert len(tools) == 8

    async def run():
        for tool in tools:
            assert tool.classification == "read" and tool.output is CatalogResult
            assert tool.personas == frozenset({"shopper"})
            assert tool.permissions == frozenset() and not tool.authenticated
            assert tool.timeout_seconds == 5
            # Runtime owns argument validation; composition forwards admitted values.
            args = SchemaArgs()
            assert await tool.handler(args, WHO) is result
            reader.read.assert_awaited_with(tool.definition.name, args, WHO)

    asyncio.run(run())
    assert reader.read.await_count == 8


@pytest.mark.parametrize(
    "module", ["actions.catalog.tools", "actions.catalog.ports", "adapters.catalog"]
)
def test_catalog_layers_import_without_application_platform_or_runtime(module):
    blocked = [
        "app.commerce_action_engine.application",
        "app.commerce_action_engine.platform",
        "app.commerce_resolution_engine.runtime",
        "app.commerce_resolution_engine.providers",
    ]
    if module.startswith("actions"):
        blocked.extend(["httpx", "app.commerce_action_engine.adapters"])
    subprocess.run(
        [
            sys.executable,
            "-c",
            f"""
import importlib.abc
import sys
class Guard(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        assert not any(fullname == p or fullname.startswith(p + '.') for p in {blocked!r}), fullname
sys.meta_path.insert(0, Guard())
import app.commerce_action_engine.{module}
""",
        ],
        check=True,
    )


def test_legacy_registry_exports_are_retired():
    from app.commerce_action_engine.actions import catalog
    from app.commerce_action_engine.actions.catalog import tools

    for module in (catalog, tools):
        assert not hasattr(module, "registry")
        assert "registry" not in module.__all__
