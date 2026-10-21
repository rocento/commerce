"""Order extraction retains fixed routing, bounds and shared request budgets."""

import asyncio
import json
import subprocess
import sys
from unittest.mock import Mock

import httpx
import pytest
from test_planned_commerce_adapter import DATA

from app.commerce_action_engine.adapters.commerce import CommerceTools
from app.commerce_action_engine.adapters.orders import OrderTransport
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable


async def read(tools, kind):
    if kind == "id":
        return await tools.call("order_status", {"order_id": DATA["order"]["id"]})
    if kind == "number":
        return await tools.order_by_number(102)
    return await getattr(tools, kind)()


@pytest.mark.parametrize(
    "kind,path",
    [
        ("id", "/v1/assistant-tools/orders/" + DATA["order"]["id"]),
        ("number", "/v1/assistant-tools/orders/by-number/102"),
        ("orders", "/v1/assistant-tools/orders"),
        ("oldest_order", "/v1/assistant-tools/orders?selection=oldest"),
    ],
)
def test_fixed_routes_and_scoped_results(kind, path):
    async def run():
        calls = []
        payload = (
            [DATA["order"]] if kind in {"orders", "oldest_order"} else DATA["order"]
        )

        def backend(request):
            calls.append(request)
            assert request.method == "GET"
            assert str(request.url) == "http://commerce" + path
            assert request.headers["Authorization"] == "Bearer order-scope"
            assert "X-Commerce-Area" not in request.headers
            return httpx.Response(200, json=payload)

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            tools = CommerceTools(
                client, "order-scope", delivery_headers={"X-Commerce-Area": "ignored"}
            )
            result = await read(tools, kind)
            actual = (
                [r.model_dump(mode="json") for r in result]
                if isinstance(result, list)
                else result.model_dump(mode="json")
            )
            assert actual == payload and tools.calls == 1
        assert len(calls) == 1

    asyncio.run(run())


@pytest.mark.parametrize(
    "payload,valid",
    [
        ([DATA["order"]] * 50, True),
        ([DATA["order"]] * 51, False),
        ({}, False),
        ([{}], False),
    ],
)
def test_list_shape_and_count_bounds(payload, valid):
    async def run():
        async with httpx.AsyncClient(
            base_url="http://commerce",
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload)),
        ) as client:
            transport = OrderTransport(client, "token", reserve_read=Mock())
            if valid:
                assert len(await transport.orders()) == 50
            else:
                with pytest.raises(ToolUnavailable):
                    await transport.orders()

    asyncio.run(run())


@pytest.mark.parametrize("kind", ["id", "orders", "number"])
@pytest.mark.parametrize("extra", [0, 1])
def test_streamed_response_limit(kind, extra):
    async def run():
        payload = [DATA["order"]] if kind == "orders" else DATA["order"]
        data = json.dumps(payload).encode()
        data += b" " * (32768 + extra - len(data))
        async with httpx.AsyncClient(
            base_url="http://commerce",
            transport=httpx.MockTransport(lambda _: httpx.Response(200, content=data)),
        ) as client:
            tools = CommerceTools(client, "token")
            if extra:
                with pytest.raises(ToolUnavailable):
                    await read(tools, kind)
            else:
                assert await read(tools, kind)

    asyncio.run(run())


def test_cart_and_order_reads_share_one_budget():
    async def run():
        calls = []

        def backend(request):
            calls.append(request)
            return httpx.Response(
                200,
                json=DATA["cart"]
                if request.url.path.endswith("/cart")
                else [DATA["order"]],
            )

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            tools = CommerceTools(client, "order", cart_capability="cart")
            await tools.cart()
            await tools.orders()
            await tools.cart()
            await tools.oldest_order()
            with pytest.raises(ToolUnavailable):
                await tools.order_by_number(102)
            assert tools.calls == 5
        assert len(calls) == 4

    asyncio.run(run())


@pytest.mark.parametrize("kind", ["orders", "oldest_order", "number"])
def test_missing_capability_does_not_reserve_or_read(kind):
    async def run():
        reserve = Mock()

        def backend(_):
            pytest.fail("Unauthorized read")

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            transport = OrderTransport(client, "", reserve_read=reserve)
            with pytest.raises(ToolUnavailable):
                await read(transport, kind)
        reserve.assert_not_called()

    asyncio.run(run())


@pytest.mark.parametrize("number", [0, -1, 9223372036854775808])
def test_invalid_order_number_rejected_before_reservation(number):
    async def run():
        reserve = Mock()
        async with httpx.AsyncClient() as client:
            with pytest.raises(ToolUnavailable):
                await OrderTransport(
                    client, "token", reserve_read=reserve
                ).order_by_number(number)
        reserve.assert_not_called()

    asyncio.run(run())


@pytest.mark.parametrize("failure", [403, 503, "timeout"])
def test_failures_do_not_retry(failure):
    async def run():
        calls = []

        def backend(request):
            calls.append(request)
            if failure == "timeout":
                raise httpx.ReadTimeout("private")
            return httpx.Response(failure, text="private")

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            with pytest.raises(ToolDenied if failure == 403 else ToolUnavailable):
                await CommerceTools(client, "token").orders()
        assert len(calls) == 1

    asyncio.run(run())


def test_cancellation_propagates_without_retry():
    async def run():
        entered = asyncio.Event()
        calls = []

        async def backend(request):
            calls.append(request)
            entered.set()
            await asyncio.Event().wait()

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            task = asyncio.create_task(CommerceTools(client, "token").orders())
            await entered.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert len(calls) == 1

    asyncio.run(run())


def test_order_transport_import_is_independent():
    subprocess.run(
        [
            sys.executable,
            "-c",
            """
import sys
import app.commerce_action_engine.adapters.orders
for name in sys.modules:
    assert not name.startswith(('app.commerce_action_engine.adapters.commerce','app.commerce_action_engine.application','app.commerce_action_engine.platform','app.commerce_resolution_engine.runtime')), name
""",
        ],
        check=True,
    )
