"""Direct shopper reads preserve their distinct budgets and wire contracts."""

import asyncio
import json
import subprocess
import sys
from unittest.mock import Mock
from uuid import UUID

import httpx
import pytest
from test_shopping import product

from app.commerce_action_engine.adapters.commerce import CommerceTools
from app.commerce_action_engine.adapters.shopper_catalog import ShopperCatalogTransport
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable

KINDS = ["discounts", "bestsellers", "product", "search"]
PRODUCT = product(1)
PAYLOADS = {
    "discounts": {
        "offers": [],
        "candidate_limit": 50,
        "metric": "catalog_discount_percent",
        "quantity": 1,
    },
    "bestsellers": {
        "products": [],
        "period": "last_month",
        "start": "2026-01-01T00:00:00Z",
        "end": "2026-02-01T00:00:00Z",
        "timezone": "UTC",
        "metric": "completed_order_units",
        "ranked_limit": 50,
    },
    "product": {"products": [PRODUCT], "category": None},
    "search": {"products": [PRODUCT], "category": None},
}
NAMES = {
    "discounts": "get_discount_recommendations",
    "bestsellers": "get_bestsellers",
    "product": "get_product",
    "search": "search_products",
}


async def invoke(tools, kind):
    if kind == "product":
        return await tools.product(UUID(PRODUCT["id"]))
    if kind == "search":
        return await tools.search_cart_product("tea")
    if kind == "bestsellers":
        return await tools.bestsellers("last_month")
    return await tools.discounts()


@pytest.mark.parametrize("kind", KINDS)
def test_fixed_wire_and_accounting(kind):
    async def run():
        requests = []

        def backend(request):
            requests.append(request)
            return httpx.Response(200, json=PAYLOADS[kind])

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            tools = CommerceTools(
                client,
                "other",
                catalog_capability="catalog",
                delivery_headers={"X-Commerce-Area": "area"},
            )
            result = await invoke(tools, kind)
            assert result is not None and tools.calls == (0 if kind == "search" else 1)
        request = requests[0]
        assert len(requests) == 1 and request.method == "POST"
        assert request.url.path == "/v1/assistant-tools/shopper"
        assert request.headers["Authorization"] == "Bearer catalog"
        assert (
            request.headers["X-Commerce-Request"] == "1"
            and request.headers["X-Commerce-Area"] == "area"
        )
        assert json.loads(request.content) == {
            "name": NAMES[kind],
            "arguments": {"period": "last_month"}
            if kind == "bestsellers"
            else {"product_id": PRODUCT["id"]}
            if kind == "product"
            else {"query": "tea"}
            if kind == "search"
            else {},
        }

    asyncio.run(run())


@pytest.mark.parametrize("kind", KINDS)
def test_missing_capability_prevents_reservation_and_http(kind):
    async def run():
        reserve = Mock()

        def backend(_):
            pytest.fail("Unauthorized catalog read")

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            with pytest.raises(ToolUnavailable):
                await invoke(
                    ShopperCatalogTransport(client, "", {}, reserve_read=reserve), kind
                )
        reserve.assert_not_called()

    asyncio.run(run())


def test_shared_counter_keeps_four_and_eight_limits_and_uncounted_search():
    async def run():
        requests = []

        def backend(request):
            requests.append(request)
            name = json.loads(request.content)["name"]
            kind = next(k for k, v in NAMES.items() if v == name)
            return httpx.Response(200, json=PAYLOADS[kind])

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            tools = CommerceTools(client, "", catalog_capability="catalog")
            for _ in range(4):
                await tools.discounts()
            with pytest.raises(ToolUnavailable):
                await tools.bestsellers("last_month")
            assert tools.calls == 5
            for _ in range(3):
                await invoke(tools, "product")
            with pytest.raises(ToolUnavailable):
                await invoke(tools, "product")
            assert tools.calls == 9
            await invoke(tools, "search")
            assert tools.calls == 9
        assert len(requests) == 8

    asyncio.run(run())


@pytest.mark.parametrize(
    "kind,limit", [("discounts", 131072), ("bestsellers", 131072), ("product", 32768)]
)
@pytest.mark.parametrize("extra", [0, 1])
def test_streamed_size_limits(kind, limit, extra):
    async def run():
        body = json.dumps(PAYLOADS[kind]).encode()
        body += b" " * (limit + extra - len(body))
        async with httpx.AsyncClient(
            base_url="http://commerce",
            transport=httpx.MockTransport(lambda _: httpx.Response(200, content=body)),
        ) as client:
            tools = CommerceTools(client, "", catalog_capability="catalog")
            if extra:
                with pytest.raises(ToolUnavailable):
                    await invoke(tools, kind)
            else:
                assert await invoke(tools, kind) is not None

    asyncio.run(run())


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("failure", [403, "timeout", "invalid"])
def test_failures_are_not_retried(kind, failure):
    async def run():
        requests = []

        def backend(request):
            requests.append(request)
            if failure == "timeout":
                raise httpx.ReadTimeout("private detail")
            return httpx.Response(
                failure if isinstance(failure, int) else 200, content=b"private detail"
            )

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            with pytest.raises(ToolDenied if failure == 403 else ToolUnavailable):
                await invoke(
                    CommerceTools(client, "", catalog_capability="catalog"), kind
                )
        assert len(requests) == 1

    asyncio.run(run())


@pytest.mark.parametrize(
    "change", [{"period": "today"}, {"end": "2025-01-01T00:00:00Z"}]
)
def test_bestseller_period_and_time_evidence_are_checked(change):
    async def run():
        async with httpx.AsyncClient(
            base_url="http://commerce",
            transport=httpx.MockTransport(
                lambda _: httpx.Response(200, json=PAYLOADS["bestsellers"] | change)
            ),
        ) as client:
            with pytest.raises(ToolUnavailable):
                await invoke(
                    CommerceTools(client, "", catalog_capability="catalog"),
                    "bestsellers",
                )

    asyncio.run(run())


@pytest.mark.parametrize("kind", KINDS)
def test_cancellation_propagates(kind):
    async def run():
        entered = asyncio.Event()
        requests = []

        async def backend(request):
            requests.append(request)
            entered.set()
            await asyncio.Event().wait()

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            task = asyncio.create_task(
                invoke(CommerceTools(client, "", catalog_capability="catalog"), kind)
            )
            await entered.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert len(requests) == 1

    asyncio.run(run())


def test_transport_import_is_independent():
    subprocess.run(
        [
            sys.executable,
            "-c",
            """
import sys
import app.commerce_action_engine.adapters.shopper_catalog
for name in sys.modules:
    assert not name.startswith(('app.commerce_action_engine.adapters.commerce','app.commerce_action_engine.application','app.commerce_action_engine.platform','app.commerce_resolution_engine.runtime')), name
""",
        ],
        check=True,
    )
