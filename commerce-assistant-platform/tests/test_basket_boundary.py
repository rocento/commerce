"""Basket ports, application tracing and scoped transport ownership."""

import asyncio
import json
import subprocess
import sys
from uuid import UUID

import httpx
import pytest
from test_baskets import BasketGoal, BasketPlan, Provider
from test_catalog_schema import catalog_schema
from test_execution import proposal

from app.commerce_action_engine.actions.catalog import (
    CatalogResult,
    CatalogSchema,
    SchemaArgs,
    SearchToolArgs,
)
from app.commerce_action_engine.actions.shopping import basket_workflow
from app.commerce_action_engine.adapters.baskets import BasketTools
from app.commerce_action_engine.application.baskets import plan_basket
from app.commerce_action_engine.execution.agents import Principal
from app.commerce_action_engine.platform import TurnTrace, trace_turn
from app.commerce_action_engine.shared.errors import RuntimeErrorCode, ToolUnavailable
from app.commerce_resolution_engine.contracts import ToolDefinition
from app.commerce_resolution_engine.runtime import RuntimeTool


class Gateway:
    """Deliberately has no HTTP client or generic call method."""

    def __init__(self, task, value):
        self.task, self.value = task, value
        self.operations = []
        self.draft = None

    async def context(self, task):
        assert task == self.task
        self.operations.append("context")
        return {
            "cart": {"items": [], "currency": "USD"},
            "cancelled": False,
            "task_revision": 1,
            "source_revision": 2,
            "execution_enabled": True,
        }

    async def quote(self, task, draft):
        assert task == self.task
        self.operations.append("quote")
        self.draft = draft
        return self.value


def catalog():
    async def schema(arguments, principal):
        return CatalogResult(
            products=[],
            category=None,
            catalog_schema=CatalogSchema.model_validate(catalog_schema()),
        )

    async def unused_search(arguments, principal):
        pytest.fail("An empty basket plan must not search products")

    return {
        "get_catalog_schema": RuntimeTool(
            ToolDefinition("get_catalog_schema", "Read schema", SchemaArgs),
            CatalogResult,
            schema,
            frozenset({"shopper"}),
        ),
        "search_products": RuntimeTool(
            ToolDefinition("search_products", "Search products", SearchToolArgs),
            CatalogResult,
            unused_search,
            frozenset({"shopper"}),
        ),
    }


@pytest.mark.parametrize("application", [False, True])
@pytest.mark.parametrize("planning", [False, True])
def test_plain_gateway_and_telemetry_callbacks_preserve_proposal(application, planning):
    async def run():
        task, value = proposal()
        gateway = Gateway(task, value)
        provider = Provider(BasketPlan(goal=BasketGoal()))
        policies, receipts, plans = [], [], []
        trace = TurnTrace()
        run_plan = plan_basket if application else basket_workflow.plan_basket
        callbacks = (
            {}
            if application
            else {
                "record_policy": policies.append,
                "record_execution": receipts.append,
                "record_planning": plans.append,
            }
        )
        with trace_turn(trace):
            text, blocks = await run_plan(
                "Build a basket under USD 150",
                "shop",
                task,
                provider,
                catalog(),
                Principal(tenant=UUID(int=1), persona="shopper"),
                gateway,
                commerce_meaning=True,
                commerce_planning=planning,
                planning_prices=(400, 1600),
                **callbacks,
            )
        assert gateway.operations == ["context", "quote"]
        assert gateway.draft["goal"]["budget"] == "150"
        assert gateway.draft["goal"]["budget_exclusive"] is True
        assert gateway.draft["source_revision"] == 2
        assert "Your live cart has not changed." in text
        assert [b.kind for b in blocks] == ["text", "basket_proposal"]
        assert str(blocks[-1].proposal_id) == value["id"]
        assert len(provider.requests) == 1
        if application:
            assert trace.execution["proposal_id"] == value["id"]
            assert len(trace.policy_decisions) == 1
            assert trace.policy_decisions[0]["confirmation"] != "none"
            assert not policies and not receipts
        else:
            assert trace.execution is None and not trace.policy_decisions
            assert len(policies) == len(receipts) == 1
            assert receipts[0]["proposal_id"] == value["id"]
        if planning:
            if application:
                assert trace.planning is not None and not plans
            else:
                assert trace.planning is None and plans[-1]["failed"] is False

    asyncio.run(run())


@pytest.mark.parametrize("receipt", ["invalid", "missing"])
def test_unverified_receipt_never_reaches_application_trace(receipt):
    async def run():
        task, value = proposal()
        if receipt == "invalid":
            value["execution"]["verdict"] = "blocked"
        else:
            del value["execution"]
        trace = TurnTrace()
        with (
            trace_turn(trace),
            pytest.raises(RuntimeErrorCode, match="execution_verification_failed"),
        ):
            await plan_basket(
                "Build a basket",
                "shop",
                task,
                Provider(BasketPlan(goal=BasketGoal())),
                catalog(),
                Principal(tenant=UUID(int=1), persona="shopper"),
                Gateway(task, value),
            )
        assert trace.execution is None

    asyncio.run(run())


def test_basket_contracts_do_not_load_transport():
    subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "from app.commerce_action_engine.actions.shopping.baskets import BasketPlan\n"
                "import sys\nassert 'app.commerce_action_engine.adapters.baskets' not in sys.modules"
            ),
        ],
        check=True,
    )


def test_adapter_shares_two_call_limit_and_preserves_scoped_http_contract():
    async def run():
        task, cart = UUID(int=30), UUID(int=20)
        requests = []
        draft = {"task_id": str(task), "selections": []}

        def handle(request):
            requests.append(request)
            assert request.url.path == f"/v1/assistant-tools/baskets/{cart}"
            assert request.headers["authorization"] == "Bearer scoped-token"
            assert request.headers["x-commerce-request"] == "1"
            assert request.headers["x-commerce-assistant-errors"] == "1"
            if request.method == "GET":
                assert dict(request.url.params) == {"task_id": str(task)}
            else:
                assert request.method == "POST"
                assert not request.url.params
                assert json.loads(request.content) == draft
            return httpx.Response(200, json={"checked": True})

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(handle)
        ) as client:
            gateway = BasketTools(client, str(cart), "scoped-token")
            assert await gateway.context(task) == {"checked": True}
            assert await gateway.quote(task, draft) == {"checked": True}
            with pytest.raises(ToolUnavailable):
                await gateway.context(task)
            assert len(requests) == 2
            assert not client.is_closed

    asyncio.run(run())


@pytest.mark.parametrize("content", [b"x" * 262145, b"not json", b"[]"])
def test_adapter_rejects_oversized_or_invalid_payloads_without_retry(content):
    async def run():
        calls = []

        def handle(request):
            calls.append(request)
            return httpx.Response(200, content=content)

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(handle)
        ) as client:
            gateway = BasketTools(client, str(UUID(int=20)), "scoped-token")
            with pytest.raises(ToolUnavailable):
                await gateway.context(UUID(int=30))
            assert len(calls) == 1
            assert not client.is_closed

    asyncio.run(run())


def test_adapter_cancellation_closes_response_and_preserves_client_ownership():
    async def run():
        started = asyncio.Event()
        calls = []

        class Body(httpx.AsyncByteStream):
            closed = False

            async def __aiter__(self):
                started.set()
                await asyncio.Event().wait()
                yield b"{}"

            async def aclose(self):
                self.closed = True

        body = Body()

        def handle(request):
            calls.append(request)
            return httpx.Response(200, stream=body)

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(handle)
        ) as client:
            gateway = BasketTools(client, str(UUID(int=20)), "scoped-token")
            work = asyncio.create_task(gateway.context(UUID(int=30)))
            await asyncio.wait_for(started.wait(), 1)
            work.cancel()
            with pytest.raises(asyncio.CancelledError):
                await work
            assert body.closed and len(calls) == 1
            assert not client.is_closed

    asyncio.run(run())
