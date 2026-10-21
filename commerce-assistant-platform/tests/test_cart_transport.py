"""Cart composition preserves shared budgets, capabilities and uncertain writes."""

import asyncio
import json
import subprocess
import sys
from unittest.mock import Mock

import httpx
import pytest
from test_cart_actions import snapshot

from app.commerce_action_engine.adapters.cart import CartTransport
from app.commerce_action_engine.adapters.commerce import CommerceTools
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable


@pytest.mark.parametrize("operation", ["cart", "change_cart"])
def test_capabilities_are_separate_and_checked_before_budget_or_http(operation):
    async def run():
        reserve = Mock()

        def backend(_):
            pytest.fail("Missing capability reached HTTP")

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            transport = CartTransport(
                client,
                "" if operation == "cart" else "read",
                "" if operation == "change_cart" else "write",
                {},
                reserve_read=reserve,
            )
            with pytest.raises(ToolUnavailable):
                await (
                    transport.cart()
                    if operation == "cart"
                    else transport.change_cart({"action": "clear"})
                )
        reserve.assert_not_called()

    asyncio.run(run())


def test_cart_and_other_reads_share_budget_while_writes_do_not_consume_it():
    async def run():
        calls = []

        def backend(request):
            calls.append(request)
            if request.url.path.endswith("/delivery"):
                return httpx.Response(
                    200, json={"configured": True, "deliverable": True, "area_id": None}
                )
            return httpx.Response(200, json=snapshot(0).model_dump(mode="json"))

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            tools = CommerceTools(
                client,
                "",
                cart_capability="read",
                catalog_capability="catalog",
                cart_write_capability="write",
            )
            for _ in range(2):
                await tools.cart()
                await tools.delivery()
            assert tools.calls == 4
            await tools.change_cart({"action": "clear"})
            assert tools.calls == 4
            with pytest.raises(ToolUnavailable):
                await tools.cart()
            assert tools.calls == 5
        assert len(calls) == 5

    asyncio.run(run())


def test_cart_wire_contract_and_authoritative_snapshot():
    async def run():
        requests = []
        reserve = Mock()

        def backend(request):
            requests.append(request)
            return httpx.Response(200, json=snapshot(0).model_dump(mode="json"))

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            transport = CartTransport(
                client,
                "read-only",
                "write-only",
                {"X-Commerce-Area": "area"},
                reserve_read=reserve,
            )
            assert await transport.cart() == snapshot(0)
            assert await transport.change_cart({"action": "clear"}) == snapshot(0)
        reserve.assert_called_once_with()
        assert [r.method for r in requests] == ["GET", "POST"]
        assert all(r.url.path == "/v1/assistant-tools/cart" for r in requests)
        assert requests[0].headers["Authorization"] == "Bearer read-only"
        assert requests[0].headers["X-Commerce-Area"] == "area"
        assert requests[1].headers["Authorization"] == "Bearer write-only"
        assert requests[1].headers["X-Commerce-Request"] == "1"
        assert "X-Commerce-Area" not in requests[1].headers
        assert json.loads(requests[1].content) == {"action": "clear"}

    asyncio.run(run())


@pytest.mark.parametrize("failure", [403, 409, 503, "timeout", "invalid"])
@pytest.mark.parametrize("operation", ["cart", "change_cart"])
def test_failed_operations_never_retry_or_expose_upstream_details(failure, operation):
    async def run():
        calls = []

        def backend(request):
            calls.append(request)
            if failure == "timeout":
                raise httpx.ReadTimeout("private backend detail")
            return httpx.Response(
                failure if isinstance(failure, int) else 200,
                content=b"private backend detail",
            )

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            tools = CommerceTools(
                client, "", cart_capability="read", cart_write_capability="write"
            )
            with pytest.raises(
                ToolDenied if failure == 403 else ToolUnavailable
            ) as error:
                await (
                    tools.cart()
                    if operation == "cart"
                    else tools.change_cart({"action": "clear"})
                )
            assert "private backend detail" not in str(error.value)
            assert tools.calls == (1 if operation == "cart" else 0)
        assert len(calls) == 1

    asyncio.run(run())


@pytest.mark.parametrize("operation", ["cart", "change_cart"])
def test_cancellation_is_not_swallowed_or_retried(operation):
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
            tools = CommerceTools(
                client, "", cart_capability="read", cart_write_capability="write"
            )
            task = asyncio.create_task(
                tools.cart()
                if operation == "cart"
                else tools.change_cart({"action": "clear"})
            )
            await entered.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert len(calls) == 1

    asyncio.run(run())


def test_cart_adapter_import_does_not_load_facade_or_application():
    subprocess.run(
        [
            sys.executable,
            "-c",
            """
import sys
import app.commerce_action_engine.adapters.cart
for name in sys.modules:
    assert not name.startswith(('app.commerce_action_engine.adapters.commerce', 'app.commerce_action_engine.application', 'app.commerce_action_engine.platform', 'app.commerce_resolution_engine.runtime')), name
""",
        ],
        check=True,
    )
