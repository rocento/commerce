"""The relocated adapter preserves scoped reads and planning lifecycle guards."""

import asyncio
import json
import subprocess
import sys
from uuid import UUID

import httpx
import pytest
from test_assistant import identity  # noqa: F401 -- shared authentication fixture
from test_commerce_planning import WHO

from app.commerce_action_engine.adapters.commerce import CommerceTools
from app.commerce_action_engine.adapters.planned_commerce import PlannedCommerceTools
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable

DATA = {
    "cart": {
        "items": [],
        "subtotal": "0",
        "discount_amount": "0",
        "currency": "USD",
        "fully_reserved": False,
    },
    "delivery": {"configured": True, "deliverable": True, "area_id": None},
    "order": {
        "id": str(UUID(int=1)),
        "number": 102,
        "status": "shipped",
        "subtotal": "30",
        "discount_amount": "0",
        "tax_amount": "2",
        "delivery_fee": "3",
        "total": "35",
        "currency": "USD",
        "cancellation_available": False,
        "shipments": [],
    },
}
PATHS = {
    "cart": "/v1/assistant-tools/cart",
    "delivery": "/v1/assistant-tools/delivery",
    "order": f"/v1/assistant-tools/orders/{UUID(int=1)}",
}
TOKENS = {"cart": "cart-read", "delivery": "catalog-read", "order": "order-read"}


def adapter(client, records):
    base = CommerceTools(
        client,
        "order-read",
        cart_capability="cart-read",
        catalog_capability="catalog-read",
        delivery_headers={"X-Commerce-Area": "area"},
        wishlist_capability="wishlist-read",
        locations_capability="locations-read",
        support_capability="support",
        cart_write_capability="cart-write",
        wishlist_write_capability="wishlist-write",
        wishlist_cart_transfer_capability="transfer",
        compound_read_capability="compound-read",
        compound_write_capability="compound-write",
    )
    return base, PlannedCommerceTools(base, WHO, record_planning=records.append)


async def read(tools, kind):
    if kind == "order":
        return await tools.call("order_status", {"order_id": str(UUID(int=1))})
    return await getattr(tools, kind)()


@pytest.mark.parametrize("kind", ["cart", "delivery", "order"])
def test_scoped_reads_preserve_wire_result_budget_and_telemetry(kind):
    async def run():
        requests, records = [], []

        def backend(request):
            requests.append(request)
            assert request.method == "GET" and request.url.path == PATHS[kind]
            assert request.headers["Authorization"] == f"Bearer {TOKENS[kind]}"
            if kind != "order":
                assert request.headers["X-Commerce-Area"] == "area"
            return httpx.Response(200, json=DATA[kind])

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            base, tools = adapter(client, records)
            for _ in range(4):
                result = await read(tools, kind)
                assert result.model_dump(mode="json") == DATA[kind]
            with pytest.raises(ToolUnavailable):
                await read(tools, kind)
            assert base.calls == tools.calls == 5
        assert len(requests) == 4
        assert records[2]["skills"][0]["completed"] == 1
        assert records[-1]["failed"] is True
        assert records[-1]["skills"][0]["completed"] == 0
        assert all(r["playbook"] == f"playbook://commerce/{kind}" for r in records)

    asyncio.run(run())


@pytest.mark.parametrize("kind", ["cart", "delivery", "order"])
def test_denied_read_is_not_retried_or_completed(kind):
    async def run():
        requests, records = [], []

        def backend(request):
            requests.append(request)
            return httpx.Response(403, text="private upstream detail")

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            _, tools = adapter(client, records)
            with pytest.raises(ToolDenied):
                await read(tools, kind)
        assert len(requests) == 1 and records[-1]["failed"] is True
        assert records[-1]["skills"][0]["completed"] == 0
        assert "private upstream detail" not in str(records)

    asyncio.run(run())


@pytest.mark.parametrize("extra", [0, 1])
def test_response_size_boundary_is_preserved(extra):
    async def run():
        body = json.dumps(DATA["cart"]).encode()
        body += b" " * (32768 + extra - len(body))
        records = []
        async with httpx.AsyncClient(
            base_url="http://commerce",
            transport=httpx.MockTransport(lambda _: httpx.Response(200, content=body)),
        ) as client:
            _, tools = adapter(client, records)
            if extra:
                with pytest.raises(ToolUnavailable):
                    await tools.cart()
            else:
                assert (await tools.cart()).model_dump(mode="json") == DATA["cart"]
        assert records[-1]["failed"] is bool(extra)

    asyncio.run(run())


def test_cancellation_propagates_and_records_failed_read():
    async def run():
        entered = asyncio.Event()
        requests, records = [], []

        async def backend(request):
            requests.append(request)
            entered.set()
            await asyncio.Event().wait()

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            _, tools = adapter(client, records)
            task = asyncio.create_task(tools.cart())
            await entered.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert len(requests) == 1 and records[-1]["failed"] is True
        assert records[-1]["skills"][0]["completed"] == 0

    asyncio.run(run())


def test_wrapper_preserves_all_delegated_capabilities():
    async def run():
        async with httpx.AsyncClient() as client:
            base, tools = adapter(client, [])
            for name in vars(base):
                if name != "compound":
                    assert getattr(tools, name) == getattr(base, name)
            assert tools.compound.read_token == "compound-read"
            assert tools.compound.write_token == "compound-write"

    asyncio.run(run())


def test_unknown_operation_does_not_start_planning_or_http():
    async def run():
        def backend(_):
            pytest.fail("Unregistered operation reached transport")

        records = []
        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            _, tools = adapter(client, records)
            with pytest.raises(ValueError, match="Unregistered tool"):
                await tools.call("checkout", {})
        assert records == []

    asyncio.run(run())


def test_planning_public_api_no_longer_loads_transport():
    subprocess.run(
        [
            sys.executable,
            "-c",
            """
import sys
from app.commerce_action_engine.execution import planning
for name in planning.__all__:
    getattr(planning, name)
assert not hasattr(planning, 'PlannedCommerceTools')
for name in sys.modules:
    assert not name.startswith(('httpx', 'app.commerce_action_engine.adapters', 'app.commerce_action_engine.application', 'app.commerce_action_engine.platform')), name
""",
        ],
        check=True,
    )


@pytest.mark.parametrize("enabled", [False, True])
def test_chat_wires_canonical_adapter_only_when_planning_enabled(
    request, monkeypatch, enabled
):
    from dataclasses import replace

    from test_assistant import test_order_card_grounding_and_sse

    from app.commerce_action_engine.adapters import planned_commerce
    from app.commerce_action_engine.platform import planning_summary

    created = []

    class Observed(PlannedCommerceTools):
        def __init__(self, base, principal, *, record_planning=None):
            created.append(record_planning)
            super().__init__(base, principal, record_planning=record_planning)

    monkeypatch.setattr(planned_commerce, "PlannedCommerceTools", Observed)
    config, request_id, headers = request.getfixturevalue("identity")
    config = replace(
        config, feature_flags=frozenset({"commerce_planning"} if enabled else ())
    )
    test_order_card_grounding_and_sse((config, request_id, headers))
    assert created == ([planning_summary] if enabled else [])
