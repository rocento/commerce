"""Opt-in serial dispatch against isolated real assistant PostgreSQL storage."""

import asyncio
import os
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from test_compound_execution import language as language  # noqa: PLC0414
from test_compound_planning import Reader, interpreted, receipt

from app.commerce_action_engine.application.handlers.compound import describe
from app.commerce_action_engine.execution.agents import Principal
from app.commerce_action_engine.execution.planning.compound import prepare
from app.commerce_action_engine.execution.planning.compound_execution import (
    CompoundExecutionSession,
    executable,
)
from app.commerce_action_engine.platform.store import Store
from app.commerce_orchestration_engine.journeys.compound import execute

DSN = os.environ.get("COMPLETION_TEST_DSN")
ADMIN_DSN = os.environ.get("COMPLETION_TEST_ADMIN_DSN")
pytestmark = pytest.mark.skipif(
    not DSN or not ADMIN_DSN, reason="isolated PostgreSQL test DSNs required"
)


@pytest.mark.parametrize("supersede", [False, True])
def test_real_dispatch_claims_receipts_and_supersession(language, supersede):
    async def run():
        tenant, customer, conversation = UUID(int=1), uuid4(), uuid4()
        principal = Principal(tenant=tenant, subject=customer, persona="shopper")
        store = object.__new__(Store)
        store.pool = AsyncConnectionPool(
            DSN, open=False, kwargs={"row_factory": dict_row}
        )
        await store.open()
        try:
            revision = await store.begin_request(tenant, customer, conversation)
            review = await prepare(
                interpreted(language),
                principal,
                Reader(),
                conversation=conversation,
                request=uuid4(),
                revision=revision,
                input_hash="a" * 64,
            )
            await store.save_compound_plan(review)
            candidate = executable(review, interpreted(language), principal)
            # No operation may promote the stored review, even when a new runtime enables writes.
            assert await store.save_compound_plan(candidate) == review
            with pytest.raises(ValueError, match="not_executable"):
                await store.transition_compound(
                    review.scope,
                    review.request_id,
                    review.actions[0].id,
                    transition="dispatch",
                )
            revision = await store.begin_request(tenant, customer, conversation)
            plan = executable(
                await prepare(
                    interpreted(language),
                    principal,
                    Reader(),
                    conversation=conversation,
                    request=uuid4(),
                    revision=revision,
                    input_hash="b" * 64,
                ),
                interpreted(language),
                principal,
            )
            await store.save_compound_plan(plan)
            calls = []

            class Writer:
                async def apply(self, command, action_id):
                    index = next(
                        i for i, a in enumerate(plan.actions) if a.id == action_id
                    )
                    current = await store.get_compound_plan(
                        plan.scope, plan.request_id, plan.input_hash
                    )
                    assert current.actions[index].state == "running"
                    if index:
                        assert current.actions[0].state == "succeeded"
                    calls.append(index)
                    if supersede and index == 0:
                        await store.begin_request(tenant, customer, conversation)
                    return receipt(plan, index)

            # Race two would-be dispatchers; the database admits only one claim.
            await asyncio.gather(
                *[
                    execute(
                        plan,
                        CompoundExecutionSession(
                            plan, principal, write_capability=True
                        ),
                        Reader(),
                        Writer(),
                        store,
                    )
                    for _ in range(2)
                ]
            )
            saved = await store.get_compound_plan(
                plan.scope, plan.request_id, plan.input_hash
            )
            assert calls == ([0] if supersede else [0, 1])
            assert [a.state for a in saved.actions] == (
                ["succeeded", "superseded"] if supersede else ["succeeded", "succeeded"]
            )
            # A duplicate's early reply may win the first history insert. Final
            # receipted outcomes replace it, but stale or unrelated replies cannot.
            args = (tenant, customer, conversation, plan.request_id, "original request")
            await store.save(*args, "Early duplicate reply", [], {})
            await store.metric(
                tenant,
                plan.request_id,
                "completed",
                10,
                {"completion": {"status": "unverified"}, "input_tokens": 7},
                conversation,
                customer,
            )
            metadata = {
                "intent_retrieval": {"diagnostic": "x" * 3000},
                "route_reason": "compound_plan_recovery",
                "compound_plan_id": str(saved.id),
                "compound_action_states": [a.state for a in saved.actions],
                "completion": {"status": "unverified" if supersede else "completed"},
            }
            for invalid in (
                {},
                {**metadata, "compound_plan_id": str(uuid4())},
                {**metadata, "compound_action_states": ["ready", "ready"]},
            ):
                await store.save(*args, "Must not replace", [], invalid)
            async with await psycopg.AsyncConnection.connect(ADMIN_DSN) as admin:
                query = "SELECT text FROM assistant.messages WHERE request_id=%s AND role='assistant'"
                assert (
                    await (await admin.execute(query, (plan.request_id,))).fetchone()
                )[0] == "Early duplicate reply"
                await store.save(*args, describe(saved), [], metadata)
                await store.metric(
                    tenant,
                    plan.request_id,
                    "completed",
                    99,
                    {"completion": {"status": "unverified"}, "input_tokens": 99},
                    conversation,
                    customer,
                )
                await store.save(
                    *args,
                    "Late stale reply",
                    [],
                    {**metadata, "compound_action_states": ["ready", "ready"]},
                )
                assert (
                    await (await admin.execute(query, (plan.request_id,))).fetchone()
                )[0] == describe(saved)
                metric = (
                    await (
                        await admin.execute(
                            "SELECT metadata FROM assistant.metrics WHERE request_id=%s",
                            (plan.request_id,),
                        )
                    ).fetchone()
                )[0]
                assert metric["completion"] == metadata["completion"]
                assert metric["input_tokens"] == 7
                assert (
                    await (
                        await admin.execute(
                            "SELECT answer FROM assistant.turns WHERE request_id=%s",
                            (plan.request_id,),
                        )
                    ).fetchone()
                )[0] == describe(saved)
        finally:
            await store.close()
            async with await psycopg.AsyncConnection.connect(ADMIN_DSN) as admin:
                await admin.execute(
                    "DELETE FROM assistant.conversations WHERE customer_id=%s",
                    (customer,),
                )

    asyncio.run(run())
