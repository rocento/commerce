"""Support transport preserves read scopes, creation validation and shared budgets."""

import asyncio
import json
import subprocess
import sys
from unittest.mock import Mock
from uuid import UUID

import httpx
import pytest
from pydantic import ValidationError
from test_cart_actions import snapshot
from test_support_create_handler import receipt, submission

from app.commerce_action_engine.adapters.commerce import CommerceTools
from app.commerce_action_engine.adapters.support import SupportTransport
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable

KINDS = ["list", "detail", "create"]


async def invoke(tools, kind):
    if kind == "list":
        return await tools.support_tickets()
    if kind == "detail":
        return await tools.support_ticket(UUID(int=3))
    return await tools.create_ticket(submission(str(UUID(int=1))))


def facade(client):
    return CommerceTools(
        client,
        "create-token",
        cart_capability="cart-token",
        support_capability="read-token",
    )


@pytest.mark.parametrize("kind", KINDS)
def test_fixed_routes_capabilities_and_typed_results(kind):
    async def run():
        requests = []
        payload = [receipt()["ticket"]] if kind == "list" else receipt()

        def backend(request):
            requests.append(request)
            return httpx.Response(200, json=payload)

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            tools = facade(client)
            result = await invoke(tools, kind)
            assert tools.calls == 1
        assert len(requests) == 1
        request = requests[0]
        assert request.method == ("POST" if kind == "create" else "GET")
        assert request.url.path == "/v1/assistant-tools/support/tickets" + (
            "/" + str(UUID(int=3)) if kind == "detail" else ""
        )
        assert request.headers["Authorization"] == "Bearer " + (
            "create-token" if kind == "create" else "read-token"
        )
        if kind == "create":
            assert request.headers["X-Commerce-Request"] == "1"
            assert json.loads(request.content) == {
                k: v for k, v in submission(str(UUID(int=1))).items() if v is not None
            }
        actual = (
            [r.model_dump(mode="json") for r in result]
            if isinstance(result, list)
            else result.model_dump(mode="json")
        )
        assert actual == payload

    asyncio.run(run())


@pytest.mark.parametrize("kind", ["list", "detail"])
def test_missing_read_capability_cannot_borrow_creation_token(kind):
    async def run():
        reserve = Mock()

        def backend(_):
            pytest.fail("Missing read capability reached HTTP")

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            with pytest.raises(ToolUnavailable):
                await invoke(
                    SupportTransport(client, "", "create", reserve_call=reserve), kind
                )
        reserve.assert_not_called()

    asyncio.run(run())


def test_invalid_creation_input_does_not_reserve_or_dispatch():
    async def run():
        reserve = Mock()
        async with httpx.AsyncClient() as client:
            with pytest.raises(ValidationError):
                await SupportTransport(
                    client, "read", "create", reserve_call=reserve
                ).create_ticket({"subject": "missing fields"})
        reserve.assert_not_called()

    asyncio.run(run())


def test_creation_and_reads_share_cart_budget():
    async def run():
        requests = []

        def backend(request):
            requests.append(request)
            payload = (
                snapshot(0).model_dump(mode="json")
                if request.url.path.endswith("/cart")
                else [receipt()["ticket"]]
                if request.method == "GET" and request.url.path.endswith("/tickets")
                else receipt()
            )
            return httpx.Response(200, json=payload)

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            tools = facade(client)
            await tools.cart()
            for kind in KINDS:
                await invoke(tools, kind)
            with pytest.raises(ToolUnavailable):
                await invoke(tools, "create")
            assert tools.calls == 5
        assert len(requests) == 4

    asyncio.run(run())


@pytest.mark.parametrize(
    "payload,valid",
    [
        ([receipt()["ticket"]] * 100, True),
        ([receipt()["ticket"]] * 101, False),
        ({}, False),
        ([None], False),
        ([{}], False),
    ],
)
def test_list_count_and_schema_bounds(payload, valid):
    async def run():
        async with httpx.AsyncClient(
            base_url="http://commerce",
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload)),
        ) as client:
            if valid:
                assert len(await facade(client).support_tickets()) == 100
            else:
                with pytest.raises(ToolUnavailable):
                    await facade(client).support_tickets()

    asyncio.run(run())


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("extra", [0, 1])
def test_response_size_boundary(kind, extra):
    async def run():
        payload = [receipt()["ticket"]] if kind == "list" else receipt()
        data = json.dumps(payload).encode()
        data += b" " * (32768 + extra - len(data))
        async with httpx.AsyncClient(
            base_url="http://commerce",
            transport=httpx.MockTransport(lambda _: httpx.Response(200, content=data)),
        ) as client:
            if extra:
                with pytest.raises(ToolUnavailable):
                    await invoke(facade(client), kind)
            else:
                assert await invoke(facade(client), kind)

    asyncio.run(run())


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("failure", [403, 503, "timeout", "invalid"])
def test_failure_mapping_without_retries(kind, failure):
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
            with pytest.raises(
                ToolDenied if failure == 403 else ToolUnavailable
            ) as error:
                await invoke(facade(client), kind)
        assert len(requests) == 1 and "private detail" not in str(error.value)

    asyncio.run(run())


@pytest.mark.parametrize("kind", KINDS)
def test_cancellation_is_not_swallowed_or_retried(kind):
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
            task = asyncio.create_task(invoke(facade(client), kind))
            await entered.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert len(requests) == 1

    asyncio.run(run())


def test_import_has_no_facade_or_application_dependency():
    subprocess.run(
        [
            sys.executable,
            "-c",
            """
import sys
import app.commerce_action_engine.adapters.support
for name in sys.modules:
    assert not name.startswith(('app.commerce_action_engine.adapters.commerce','app.commerce_action_engine.application','app.commerce_action_engine.platform','app.commerce_resolution_engine.runtime')), name
""",
        ],
        check=True,
    )
