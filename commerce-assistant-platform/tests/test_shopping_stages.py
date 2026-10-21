"""Shopping stages share read budgets and preserve evidence across their boundaries."""

import asyncio
from unittest.mock import AsyncMock

import pytest
from test_catalog_schema import catalog_schema
from test_shopping import TENANT, WHO, product

from app.commerce_action_engine.actions.catalog import (
    DEFINITIONS,
    CatalogResult,
    CatalogSchema,
    Product,
    SchemaArgs,
    SearchToolArgs,
)
from app.commerce_action_engine.actions.shopping.contracts import ShoppingIntent
from app.commerce_action_engine.application.shopping_flow.catalog import ShoppingCatalog
from app.commerce_action_engine.application.shopping_flow.contracts import (
    GroundedShopping,
    PreparedShopping,
    ReferenceSelection,
)
from app.commerce_action_engine.application.shopping_flow.presentation import (
    ShoppingResponder,
)
from app.commerce_action_engine.application.shopping_flow.references import (
    resolve_references,
)
from app.commerce_action_engine.execution.agents import default_agents
from app.commerce_action_engine.shared.errors import RuntimeErrorCode, ToolDenied
from app.commerce_resolution_engine.contracts import ModelResponse, Usage
from app.commerce_resolution_engine.runtime import RuntimeTool


def session(handlers, *, limit=4, timeout=5, on_tool=None):
    agent = default_agents(TENANT).load(TENANT, "shopper")
    agent = agent.model_copy(
        update={"safety": agent.safety.model_copy(update={"max_tool_calls": limit})}
    )
    definitions = {definition.name: definition for definition in DEFINITIONS}
    tools = {
        name: RuntimeTool(
            definitions[name],
            CatalogResult,
            handler,
            frozenset({"shopper"}),
            timeout_seconds=timeout,
        )
        for name, handler in handlers.items()
    }
    return ShoppingCatalog(tools, agent, WHO, None, on_tool)


def test_schema_and_search_share_one_budget_and_unknown_tools_do_not_spend_it():
    schema = CatalogSchema(**catalog_schema())
    read_schema = AsyncMock(
        return_value=CatalogResult(products=[], category=None, catalog_schema=schema)
    )
    search = AsyncMock(return_value=CatalogResult(products=[], category=None))
    observed = []
    catalog = session(
        {"get_catalog_schema": read_schema, "search_products": search},
        limit=2,
        on_tool=observed.append,
    )

    async def run():
        with pytest.raises(RuntimeErrorCode, match="tool_not_allowed"):
            await catalog.call("unknown", SchemaArgs())
        assert catalog.calls == 0
        await catalog.discover()
        await catalog.call("search_products", SearchToolArgs(query="shoes"))
        with pytest.raises(RuntimeErrorCode, match="tool_not_allowed"):
            await catalog.call("search_products", SearchToolArgs(query="shoes"))

    asyncio.run(run())
    assert catalog.calls == 2 and observed == ["get_catalog_schema", "search_products"]
    read_schema.assert_awaited_once()
    search.assert_awaited_once()


@pytest.mark.parametrize(
    "error",
    [
        ToolDenied(),
        RuntimeErrorCode("output_limit"),
        ValueError("private upstream details"),
    ],
)
def test_failed_read_consumes_budget_preserving_only_boundary_safe_errors(error):
    read = AsyncMock(side_effect=error)
    catalog = session({"search_products": read}, limit=1)

    async def run():
        with pytest.raises((ToolDenied, RuntimeErrorCode)) as caught:
            await catalog.call("search_products", SearchToolArgs(query="shoes"))
        if isinstance(error, (ToolDenied, RuntimeErrorCode)):
            assert caught.value is error
        else:
            assert caught.value.code == "tool_unavailable"
            assert "private upstream details" not in str(caught.value)
        with pytest.raises(RuntimeErrorCode, match="tool_not_allowed"):
            await catalog.call("search_products", SearchToolArgs(query="shoes"))

    asyncio.run(run())
    assert catalog.calls == 1
    read.assert_awaited_once()


@pytest.mark.parametrize("stop", ["timeout", "cancel"])
def test_interrupted_catalog_read_closes_work_and_never_retries(stop):
    async def run():
        entered, closed = asyncio.Event(), asyncio.Event()

        async def read(*args):
            entered.set()
            try:
                await asyncio.Future()
            finally:
                closed.set()

        handler = AsyncMock(side_effect=read)
        catalog = session(
            {"search_products": handler},
            timeout=0.01 if stop == "timeout" else 5,
        )
        task = asyncio.create_task(
            catalog.call("search_products", SearchToolArgs(query="shoes"))
        )
        await asyncio.wait_for(entered.wait(), 1)
        if stop == "cancel":
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            with pytest.raises(RuntimeErrorCode, match="tool_unavailable"):
                await task
        assert closed.is_set() and catalog.calls == 1
        handler.assert_awaited_once()

    asyncio.run(run())


def test_reference_price_refinement_is_explicit_and_keeps_previous_stage_facts():
    item = Product.model_validate(product(price="49"))
    plan = ShoppingIntent(
        shopping=True,
        query="shoes",
        cheaper=True,
        min_price="10",
        max_price="100",
        currency="USD",
    )
    schema = CatalogSchema(**catalog_schema())
    response = ModelResponse("", (), plan, Usage(0, 0, 0), "fixture", "stop")
    prepared = PreparedShopping(
        message=f"Find cheaper shoes than {item.route}",
        constraint_message="",
        response=response,
        plan=plan,
        gate=None,
        interpreted=False,
        required_names=(),
        revision_changed=False,
        resuming=False,
    )
    grounded = GroundedShopping(plan, schema, None, {}, None, None, 0)
    read = AsyncMock(return_value=CatalogResult(products=[item], category=None))
    catalog = session({"get_product": read})
    outcome = asyncio.run(
        resolve_references(
            prepared,
            grounded,
            catalog=catalog,
            responder=ShoppingResponder(response, None, False, 8000),
        )
    )
    assert isinstance(outcome, ReferenceSelection)
    assert outcome.plan.max_price == "49" and outcome.plan.exclusive_max
    assert outcome.plan.min_price == "10" and outcome.product == item
    assert grounded.plan.max_price == "100" and not grounded.plan.exclusive_max
    assert prepared.plan == plan and outcome.plan is not plan
    read.assert_awaited_once()


def test_catalog_trace_records_selected_criteria_and_result_counts(monkeypatch):
    from uuid import uuid4

    from app.commerce_resolution_engine.diagnostics import begin_debug, finish_debug

    monkeypatch.delenv("AI_INTENT_DEBUG_DIR", raising=False)
    schema = CatalogSchema(**catalog_schema())
    catalog = session(
        {
            "get_catalog_schema": AsyncMock(
                return_value=CatalogResult(
                    products=[], category=None, catalog_schema=schema
                )
            ),
            "search_products": AsyncMock(
                return_value=CatalogResult(products=[], category=None)
            ),
        }
    )

    async def run():
        token = begin_debug(str(uuid4()), "fruit", enabled=True)
        try:
            await catalog.discover()
            await catalog.call(
                "search_products",
                SearchToolArgs(
                    query="fruit", max_price="200", exclusive_max=True, currency="EGP"
                ),
            )
        finally:
            report = finish_debug(token)
        events = [
            e["data"] for e in report["events"] if e["stage"] == "python_function"
        ]
        calls = [e for e in events if e["function"] == "ShoppingCatalog.call"]
        assert calls[0]["details"]["operation"] == "get_catalog_schema"
        assert calls[0]["details"]["schema_returned"] is True
        assert calls[1]["details"]["criteria"]["query"] == "fruit"
        assert calls[1]["details"]["criteria"]["exclusive_max"] is True
        assert calls[1]["details"]["products_returned"] == 0
        assert "details" not in next(
            e for e in events if e["function"] == "ShoppingCatalog.discover"
        )

    asyncio.run(run())


def test_local_filter_capture_does_not_add_catalog_requests(monkeypatch):
    from uuid import uuid4

    from test_shopping import scenario

    from app.commerce_resolution_engine.diagnostics import begin_debug, finish_debug

    monkeypatch.delenv("AI_INTENT_DEBUG_DIR", raising=False)

    async def run():
        plain, plain_requests = await scenario(
            "Find shoes", {"category": "shoes"}, [product()], commerce_meaning=True
        )
        token = begin_debug(str(uuid4()), "Find shoes", enabled=True)
        try:
            captured, captured_requests = await scenario(
                "Find shoes", {"category": "shoes"}, [product()], commerce_meaning=True
            )
        finally:
            report = finish_debug(token)
        assert plain.text == captured.text
        assert len(plain_requests) == len(captured_requests)
        filters = [
            event["data"]
            for event in report["events"]
            if event["stage"] == "catalog_filter"
        ]
        assert filters
        assert all(
            0 <= event["products_after"] <= event["products_before"]
            for event in filters
        )
        assert all(event["checks"] for event in filters)

    asyncio.run(run())
