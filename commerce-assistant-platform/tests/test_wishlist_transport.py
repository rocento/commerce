"""Wishlist extraction preserves scoped commands, read bounds and uncertain outcomes."""

import asyncio
import json
import subprocess
import sys
from unittest.mock import Mock
from uuid import UUID

import httpx
import pytest
from test_cart_actions import snapshot

from app.commerce_action_engine.adapters.commerce import CommerceTools
from app.commerce_action_engine.adapters.wishlist import WishlistTransport
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable

ID = UUID(int=7)
RECEIPT = {
    "items": [
        {
            "product_id": str(ID),
            "name": "Tea",
            "status": "transferred",
            "detail": "Transferred",
        }
    ],
    "cart": snapshot(0).model_dump(mode="json"),
}
OPERATIONS = [
    "wishlist",
    "add_wishlist_item",
    "remove_wishlist_item",
    "transfer_wishlist_to_cart",
]


async def invoke(tools, operation):
    if operation == "wishlist":
        return await tools.wishlist()
    if operation == "transfer_wishlist_to_cart":
        return await tools.transfer_wishlist_to_cart([ID])
    return await getattr(tools, operation)(ID)


def facade(client):
    return CommerceTools(
        client,
        "orders",
        cart_capability="cart",
        wishlist_capability="read",
        wishlist_write_capability="write",
        wishlist_cart_transfer_capability="transfer",
    )


@pytest.mark.parametrize("operation", OPERATIONS)
def test_wire_contract_uses_only_the_correct_capability(operation):
    async def run():
        requests = []

        def backend(request):
            requests.append(request)
            if operation == "wishlist":
                return httpx.Response(200, json=[str(ID)])
            if operation == "transfer_wishlist_to_cart":
                return httpx.Response(200, json=RECEIPT)
            return httpx.Response(204)

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            tools = facade(client)
            result = await invoke(tools, operation)
            assert tools.calls == (1 if operation == "wishlist" else 0)
        assert len(requests) == 1
        request = requests[0]
        assert request.method == (
            "GET"
            if operation == "wishlist"
            else "DELETE"
            if operation == "remove_wishlist_item"
            else "POST"
        )
        token = (
            "read"
            if operation == "wishlist"
            else "transfer"
            if operation == "transfer_wishlist_to_cart"
            else "write"
        )
        assert request.headers["Authorization"] == "Bearer " + token
        assert request.url.path == (
            "/v1/assistant-tools/cart/wishlist-transfer"
            if token == "transfer"
            else "/v1/assistant-tools/wishlist"
        )
        if operation == "wishlist":
            assert result == [ID]
        else:
            assert request.headers["X-Commerce-Request"] == "1"
            assert json.loads(request.content) == (
                {"product_ids": [str(ID)]}
                if token == "transfer"
                else {"product_id": str(ID)}
            )
            if token == "transfer":
                assert result.model_dump(mode="json") == RECEIPT

    asyncio.run(run())


@pytest.mark.parametrize("operation", OPERATIONS)
def test_missing_capability_cannot_borrow_another_token(operation):
    async def run():
        reserve = Mock()

        def backend(_):
            pytest.fail("Missing capability reached HTTP")

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            transport = WishlistTransport(
                client,
                "" if operation == "wishlist" else "read",
                ""
                if operation in {"add_wishlist_item", "remove_wishlist_item"}
                else "write",
                "" if operation == "transfer_wishlist_to_cart" else "transfer",
                reserve_read=reserve,
            )
            with pytest.raises(ToolUnavailable):
                await invoke(transport, operation)
        reserve.assert_not_called()

    asyncio.run(run())


@pytest.mark.parametrize("operation", OPERATIONS)
@pytest.mark.parametrize("failure", [403, 503, "timeout"])
def test_failed_operations_are_not_retried(operation, failure):
    async def run():
        requests = []

        def backend(request):
            requests.append(request)
            if failure == "timeout":
                raise httpx.ReadTimeout("private detail")
            return httpx.Response(failure, text="private detail")

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            with pytest.raises(
                ToolDenied if failure == 403 else ToolUnavailable
            ) as error:
                await invoke(facade(client), operation)
        assert len(requests) == 1 and "private detail" not in str(error.value)

    asyncio.run(run())


@pytest.mark.parametrize(
    "payload,valid",
    [
        ([str(ID)] * 500, True),
        ([str(ID)] * 501, False),
        ({}, False),
        (["invalid-id"], False),
        ([None], False),
    ],
)
def test_read_list_validation(payload, valid):
    async def run():
        async with httpx.AsyncClient(
            base_url="http://commerce",
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload)),
        ) as client:
            if valid:
                assert len(await facade(client).wishlist()) == 500
            else:
                with pytest.raises(ToolUnavailable):
                    await facade(client).wishlist()

    asyncio.run(run())


@pytest.mark.parametrize("extra", [0, 1])
def test_streamed_read_limit(extra):
    async def run():
        body = json.dumps([str(ID)]).encode()
        body += b" " * (32768 + extra - len(body))
        async with httpx.AsyncClient(
            base_url="http://commerce",
            transport=httpx.MockTransport(lambda _: httpx.Response(200, content=body)),
        ) as client:
            if extra:
                with pytest.raises(ToolUnavailable):
                    await facade(client).wishlist()
            else:
                assert await facade(client).wishlist() == [ID]

    asyncio.run(run())


def test_mixed_reads_share_budget_and_mutations_do_not_consume_it():
    async def run():
        requests = []

        def backend(request):
            requests.append(request)
            if request.method == "GET":
                return httpx.Response(
                    200,
                    json=snapshot(0).model_dump(mode="json")
                    if request.url.path.endswith("/cart")
                    else [str(ID)],
                )
            return (
                httpx.Response(200, json=RECEIPT)
                if request.url.path.endswith("/wishlist-transfer")
                else httpx.Response(204)
            )

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            tools = facade(client)
            for _ in range(2):
                await tools.cart()
                await tools.wishlist()
            for operation in OPERATIONS[1:]:
                await invoke(tools, operation)
            assert tools.calls == 4
            with pytest.raises(ToolUnavailable):
                await tools.wishlist()
        assert len(requests) == 7

    asyncio.run(run())


def test_invalid_transfer_receipt_is_unavailable_without_replay():
    async def run():
        requests = []

        def backend(request):
            requests.append(request)
            return httpx.Response(200, json={"items": []})

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            with pytest.raises(ToolUnavailable):
                await facade(client).transfer_wishlist_to_cart([ID])
        assert len(requests) == 1

    asyncio.run(run())


@pytest.mark.parametrize("operation", OPERATIONS)
def test_cancellation_propagates_without_replay(operation):
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
            task = asyncio.create_task(invoke(facade(client), operation))
            await entered.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert len(requests) == 1

    asyncio.run(run())


def test_transport_import_does_not_load_facade_or_application():
    subprocess.run(
        [
            sys.executable,
            "-c",
            """
import sys
import app.commerce_action_engine.adapters.wishlist
for name in sys.modules:
    assert not name.startswith(('app.commerce_action_engine.adapters.commerce','app.commerce_action_engine.application','app.commerce_action_engine.platform','app.commerce_resolution_engine.runtime')), name
""",
        ],
        check=True,
    )
