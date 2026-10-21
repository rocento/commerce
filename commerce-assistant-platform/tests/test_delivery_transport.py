"""Delivery/location transport retains header scope, bounds and shared budgets."""

import asyncio
import json
import subprocess
import sys
from unittest.mock import Mock

import httpx
import pytest
from test_cart_actions import snapshot

from app.commerce_action_engine.adapters.commerce import CommerceTools
from app.commerce_action_engine.adapters.delivery import DeliveryTransport
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable

DATA = {
    "delivery": {"configured": True, "deliverable": True, "area_id": None},
    "locations": [{"id": "saved", "label": "Home", "custom_field": "preserved"}],
}


def facade(client):
    return CommerceTools(
        client,
        "other",
        cart_capability="cart",
        catalog_capability="catalog",
        locations_capability="locations",
        delivery_headers={"X-Commerce-Latitude": "30", "X-Commerce-Longitude": "31"},
    )


@pytest.mark.parametrize("kind", ["delivery", "locations"])
def test_scoped_wire_contract(kind):
    async def run():
        requests = []

        def backend(request):
            requests.append(request)
            return httpx.Response(200, json=DATA[kind])

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            tools = facade(client)
            result = await getattr(tools, kind)()
            assert (
                result if kind == "locations" else result.model_dump(mode="json")
            ) == DATA[kind]
            assert tools.calls == 1
        request = requests[0]
        assert len(requests) == 1 and request.method == "GET"
        assert request.url.path == "/v1/assistant-tools/" + kind
        assert request.headers["Authorization"] == "Bearer " + (
            "catalog" if kind == "delivery" else "locations"
        )
        if kind == "delivery":
            assert request.headers["X-Commerce-Latitude"] == "30"
            assert request.headers["X-Commerce-Longitude"] == "31"
        else:
            assert (
                "X-Commerce-Latitude" not in request.headers
                and "X-Commerce-Longitude" not in request.headers
            )

    asyncio.run(run())


@pytest.mark.parametrize("kind", ["delivery", "locations"])
def test_missing_capability_checked_before_reservation(kind):
    async def run():
        reserve = Mock()

        def backend(_):
            pytest.fail("Missing capability reached HTTP")

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            tools = DeliveryTransport(
                client,
                "" if kind == "delivery" else "catalog",
                "" if kind == "locations" else "locations",
                {},
                reserve_read=reserve,
            )
            with pytest.raises(ToolUnavailable):
                await getattr(tools, kind)()
        reserve.assert_not_called()

    asyncio.run(run())


@pytest.mark.parametrize(
    "payload,valid",
    [([{}] * 50, True), ([{}] * 51, False), ({}, False), ([None], False)],
)
def test_location_list_bounds_preserve_dictionary_contract(payload, valid):
    async def run():
        async with httpx.AsyncClient(
            base_url="http://commerce",
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload)),
        ) as client:
            if valid:
                assert await facade(client).locations() == payload
            else:
                with pytest.raises(ToolUnavailable):
                    await facade(client).locations()

    asyncio.run(run())


@pytest.mark.parametrize("kind", ["delivery", "locations"])
@pytest.mark.parametrize("extra", [0, 1])
def test_streamed_response_boundary(kind, extra):
    async def run():
        body = json.dumps(DATA[kind]).encode()
        body += b" " * (32768 + extra - len(body))
        async with httpx.AsyncClient(
            base_url="http://commerce",
            transport=httpx.MockTransport(lambda _: httpx.Response(200, content=body)),
        ) as client:
            if extra:
                with pytest.raises(ToolUnavailable):
                    await getattr(facade(client), kind)()
            else:
                assert await getattr(facade(client), kind)()

    asyncio.run(run())


@pytest.mark.parametrize("kind", ["delivery", "locations"])
@pytest.mark.parametrize("failure", [403, 503, "timeout", "invalid"])
def test_errors_are_mapped_without_retries(kind, failure):
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
                await getattr(facade(client), kind)()
        assert len(requests) == 1 and "private detail" not in str(error.value)

    asyncio.run(run())


def test_delivery_and_locations_share_cart_budget():
    async def run():
        requests = []

        def backend(request):
            requests.append(request)
            kind = request.url.path.rsplit("/", 1)[-1]
            return httpx.Response(
                200,
                json=snapshot(0).model_dump(mode="json")
                if kind == "cart"
                else DATA[kind],
            )

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            tools = facade(client)
            await tools.cart()
            await tools.delivery()
            await tools.locations()
            await tools.cart()
            with pytest.raises(ToolUnavailable):
                await tools.delivery()
            assert tools.calls == 5
        assert len(requests) == 4

    asyncio.run(run())


@pytest.mark.parametrize("kind", ["delivery", "locations"])
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
            task = asyncio.create_task(getattr(facade(client), kind)())
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
import app.commerce_action_engine.adapters.delivery
for name in sys.modules:
    assert not name.startswith(('app.commerce_action_engine.adapters.commerce','app.commerce_action_engine.application','app.commerce_action_engine.platform','app.commerce_resolution_engine.runtime')), name
""",
        ],
        check=True,
    )
