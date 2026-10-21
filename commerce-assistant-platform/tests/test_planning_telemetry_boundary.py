"""Injected observers preserve decisions, lifecycle records and request isolation."""

import asyncio
import subprocess
import sys
from unittest.mock import Mock

import pytest
from test_commerce_meaning import SCHEMA
from test_commerce_planning import PORTS, WHO

from app.commerce_action_engine.actions.catalog import CatalogResult, SchemaArgs
from app.commerce_action_engine.actions.shopping import ShoppingIntent
from app.commerce_action_engine.actions.shopping.meaning import (
    MeaningConflict,
    apply_meaning,
)
from app.commerce_action_engine.execution.planning.runtime import (
    PlanningSession,
    planned_read,
    start_planning,
)
from app.commerce_action_engine.platform.telemetry import (
    TurnTrace,
    meaning_summary,
    planning_summary,
    trace_turn,
)


@pytest.mark.parametrize(
    "module", ["actions.shopping.meaning", "execution.planning.runtime"]
)
def test_imports_without_platform_or_application(module):
    subprocess.run(
        [
            sys.executable,
            "-c",
            f"""
import importlib, sys
importlib.import_module('app.commerce_action_engine.{module}')
for name in sys.modules:
    assert not name.startswith(('app.commerce_action_engine.platform', 'app.commerce_action_engine.application', 'httpx', 'psycopg')), name
""",
        ],
        check=True,
    )


@pytest.mark.parametrize("conflict", [False, True])
def test_meaning_observer_records_before_conflict_and_preserves_constraints(conflict):
    message = "shoes under $100 over $200" if conflict else "black shoes under $100"
    plans = [ShoppingIntent(shopping=True, query="shoes") for _ in range(2)]
    records = []
    for i, plan in enumerate(plans):
        if conflict:
            with pytest.raises(MeaningConflict):
                apply_meaning(
                    plan,
                    message,
                    SCHEMA,
                    record_meaning=(lambda f, c: records.append((f, c))) if i else None,
                )
        else:
            apply_meaning(
                plan,
                message,
                SCHEMA,
                record_meaning=(lambda f, c: records.append((f, c))) if i else None,
            )
    assert plans[0] == plans[1]
    assert len(records) == 1 and records[0][1].required is conflict
    trace = TurnTrace()
    with trace_turn(trace):
        meaning_summary(*records[0])
    assert trace.totals["meaning_requirements"] == len(records[0][0].requirements)
    assert trace.totals["meaning_clarifications"] == int(conflict)


@pytest.mark.parametrize("failure", [None, "error", "cancel"])
def test_planning_records_lifecycle_and_keeps_failures(failure):
    async def run():
        records = []
        session = PlanningSession(
            "discovery", WHO, PORTS, record_planning=records.append
        )

        async def operation():
            if failure == "error":
                raise ValueError("backend failed")
            if failure == "cancel":
                raise asyncio.CancelledError()
            return CatalogResult(products=[], category=None)

        if failure:
            with pytest.raises(
                ValueError if failure == "error" else asyncio.CancelledError
            ):
                await session.perform(
                    "catalog.get_catalog_schema", SchemaArgs(), operation, lambda r: r
                )
        else:
            await session.perform(
                "catalog.get_catalog_schema", SchemaArgs(), operation, lambda r: r
            )
        assert len(records) == 3
        schema = [
            next(s for s in r["skills"] if s["step"] == "schema") for r in records
        ]
        assert [s["attempts"] for s in schema] == [0, 1, 1]
        assert [s["completed"] for s in schema] == [0, 0, 0 if failure else 1]
        assert records[-1]["failed"] is bool(failure)
        assert session.active is None
        assert all("arguments_json" not in str(r) for r in records)

    asyncio.run(run())


def test_library_fallback_and_disabled_planning_report_only_when_expected(monkeypatch):
    def missing():
        raise OSError("missing definitions")

    monkeypatch.setattr(
        "app.commerce_action_engine.execution.planning.runtime.library", missing
    )
    records = []
    assert (
        start_planning(False, "discovery", WHO, {}, record_planning=records.append)
        is None
    )
    assert records == []
    assert (
        start_planning(True, "discovery", WHO, {}, record_planning=records.append)
        is None
    )

    async def run():
        calls = []

        async def operation():
            calls.append(1)
            return "result"

        assert (
            await planned_read(
                "cart",
                WHO,
                "commerce.cart",
                SchemaArgs(),
                operation,
                lambda r: SchemaArgs(),
                record_planning=records.append,
            )
            == "result"
        )
        assert calls == [1]

    asyncio.run(run())
    assert records == [{"path": "legacy", "reason": "planning_library_unavailable"}] * 2


def test_concurrent_callbacks_keep_turn_traces_separate():
    async def run():
        async def turn(journey):
            trace = TurnTrace()
            with trace_turn(trace):
                session = PlanningSession(
                    journey, WHO, PORTS, record_planning=planning_summary
                )
                await asyncio.sleep(0)
                session.fail()
            return trace

        traces = await asyncio.gather(turn("discovery"), turn("cart"))
        assert [t.planning["playbook"] for t in traces] == [
            "playbook://commerce/discovery",
            "playbook://commerce/cart",
        ]
        assert all(t.planning["failed"] for t in traces)

    asyncio.run(run())


def test_domain_defaults_are_inert_even_inside_a_trace():
    trace = TurnTrace()
    with trace_turn(trace):
        PlanningSession("discovery", WHO, PORTS)
        apply_meaning(
            ShoppingIntent(shopping=True, query="shoes"), "black shoes", SCHEMA
        )
    assert trace.planning is None and trace.totals["meaning_requirements"] == 0


def test_basket_application_supplies_both_observers(monkeypatch):
    from unittest.mock import AsyncMock
    from uuid import UUID

    from app.commerce_action_engine.application import baskets

    workflow = AsyncMock(return_value=("done", []))
    monkeypatch.setattr(baskets.basket_workflow, "plan_basket", workflow)
    asyncio.run(
        baskets.plan_basket("shoes", "shop", UUID(int=1), Mock(), {}, WHO, Mock())
    )
    assert workflow.call_args.kwargs["record_meaning"] is meaning_summary
    assert workflow.call_args.kwargs["record_planning"] is planning_summary


def test_compound_application_records_preparation_without_enabling_writes():
    from uuid import uuid4

    from test_compound_orchestration import PlanStore
    from test_compound_planning import CONVERSATION, Reader, interpreted, resolved

    from app.commerce_action_engine.application.handlers.compound import (
        prepare_response,
    )

    trace = TurnTrace()
    with trace_turn(trace):
        text, plan = asyncio.run(
            prepare_response(
                interpreted(resolved()),
                WHO,
                Reader(),
                PlanStore(),
                conversation=CONVERSATION,
                request=uuid4(),
                revision=uuid4(),
                fingerprint="a" * 64,
            )
        )
    assert plan is not None and not plan.execution_enabled
    assert trace.planning["playbook"] == "playbook://commerce/compound-review"
    assert sum(row["completed"] for row in trace.planning["skills"]) == 4
    assert "No changes have been made" in text


def test_planned_commerce_forwards_observer_to_each_read(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from uuid import UUID

    from app.commerce_action_engine.adapters import planned_commerce as commerce
    from app.commerce_action_engine.adapters.commerce import CommerceTools

    read = AsyncMock(return_value=SimpleNamespace())
    monkeypatch.setattr(commerce, "planned_read", read)
    observer = Mock()
    wrapper = commerce.PlannedCommerceTools(
        CommerceTools(Mock(), "capability"), WHO, record_planning=observer
    )

    async def run():
        await wrapper.cart()
        await wrapper.delivery()
        await wrapper.call("order_status", {"order_id": str(UUID(int=1))})

    asyncio.run(run())
    assert read.await_count == 3
    assert all(
        call.kwargs["record_planning"] is observer for call in read.call_args_list
    )


def test_shopping_application_keeps_meaning_metrics():
    from test_commerce_meaning import test_end_to_end_preference_and_injection_are_data

    trace = TurnTrace()
    with trace_turn(trace):
        test_end_to_end_preference_and_injection_are_data()
    assert trace.totals["meaning_requirements"] > 0
    assert trace.totals["meaning_conflicts"] == 0
