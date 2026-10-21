"""Opt-in isolated PostgreSQL tests for concurrent claims, replay and RLS.

Same disposable DB setup as test_completion_postgres; never use production DSNs.
"""

import asyncio
import os
from pathlib import Path
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from test_compound_planning import Reader, interpreted, receipt, resolved

from app.commerce_action_engine.execution.agents import Principal
from app.commerce_action_engine.execution.planning.compound import prepare
from app.commerce_action_engine.platform.store import Store
from app.commerce_contracts.compound_plan import (
    CompoundPlan,
    CompoundScope,
)

DSN = os.environ.get("COMPLETION_TEST_DSN")
ADMIN_DSN = os.environ.get("COMPLETION_TEST_ADMIN_DSN")
pytestmark = pytest.mark.skipif(
    not DSN or not ADMIN_DSN, reason="isolated PostgreSQL test DSNs required"
)


def test_real_plan_identity_atomic_claims_late_receipts_and_scope():
    async def run():
        scope = CompoundScope(
            tenant_id=UUID(int=1), customer_id=uuid4(), conversation_id=uuid4()
        )
        owner = Principal(
            tenant=scope.tenant_id, subject=scope.customer_id, persona="shopper"
        )
        store = object.__new__(Store)
        store.pool = AsyncConnectionPool(
            DSN, open=False, kwargs={"row_factory": dict_row}
        )
        migrations = Path(__file__).resolve().parents[1] / "migrations"
        async with await psycopg.AsyncConnection.connect(ADMIN_DSN) as admin:
            for name in [
                "006_request_revisions.sql",
                "009_shopping_clarifications.sql",
                "007_compound_plans.sql",
                "007_compound_plans.sql",
            ]:
                await admin.execute((migrations / name).read_text())
        await store.open()
        try:
            revision = await store.begin_request(
                scope.tenant_id, scope.customer_id, scope.conversation_id
            )
            plan = await prepare(
                interpreted(resolved()),
                owner,
                Reader(),
                conversation=scope.conversation_id,
                request=uuid4(),
                revision=revision,
                input_hash="a" * 64,
            )
            assert await store.save_compound_plan(plan) == plan
            assert await store.save_compound_plan(plan) == plan
            assert (
                await store.get_compound_plan(scope, plan.request_id, plan.input_hash)
                == plan
            )
            for field in ["tenant_id", "customer_id", "conversation_id"]:
                other = scope.model_copy(update={field: uuid4()})
                assert (
                    await store.get_compound_plan(
                        other, plan.request_id, plan.input_hash
                    )
                    is None
                )
            with pytest.raises(ValueError):
                await store.get_compound_plan(scope, plan.request_id, "b" * 64)
            claims = await asyncio.gather(
                *[
                    store.transition_compound(
                        scope, plan.request_id, plan.actions[0].id, transition="claim"
                    )
                    for _ in range(2)
                ],
                return_exceptions=True,
            )
            assert sum(isinstance(v, CompoundPlan) for v in claims) == 1
            running = next(v for v in claims if isinstance(v, CompoundPlan))
            with pytest.raises(ValueError):
                await store.transition_compound(
                    scope, plan.request_id, plan.actions[1].id, transition="claim"
                )
            unknown = await store.transition_compound(
                scope, plan.request_id, plan.actions[0].id, transition="uncertain"
            )
            assert unknown.actions[1].state == "not_started"
            new_revision = await store.begin_request(
                scope.tenant_id, scope.customer_id, scope.conversation_id
            )
            evidence = receipt(running, 0)
            # Late authoritative evidence can settle the old write, but cannot
            # reactivate its successor or grant execution to the new revision.
            settled = await store.transition_compound(
                scope,
                plan.request_id,
                plan.actions[0].id,
                transition="receipt",
                receipt=evidence,
            )
            assert (
                settled.actions[0].state == "succeeded"
                and settled.actions[1].state == "superseded"
            )
            with pytest.raises(ValueError):
                await store.transition_compound(
                    scope, plan.request_id, plan.actions[1].id, transition="claim"
                )
            stale = await prepare(
                interpreted(resolved()),
                owner,
                Reader(),
                conversation=scope.conversation_id,
                request=uuid4(),
                revision=revision,
                input_hash="c" * 64,
            )
            assert await store.save_compound_plan(stale) is None
            current = await prepare(
                interpreted(resolved()),
                owner,
                Reader(),
                conversation=scope.conversation_id,
                request=uuid4(),
                revision=new_revision,
                input_hash="d" * 64,
            )
            assert await store.save_compound_plan(current) == current
            assert current.actions[0].operation_id != plan.actions[0].operation_id
        finally:
            await store.close()
            async with await psycopg.AsyncConnection.connect(ADMIN_DSN) as admin:
                await admin.execute(
                    "DELETE FROM assistant.conversations WHERE tenant_id=%s AND customer_id=%s AND id=%s",
                    (scope.tenant_id, scope.customer_id, scope.conversation_id),
                )
                remaining = await (
                    await admin.execute(
                        "SELECT count(*) FROM assistant.compound_plans WHERE customer_id=%s",
                        (scope.customer_id,),
                    )
                ).fetchone()
                assert remaining[0] == 0

    asyncio.run(run())
