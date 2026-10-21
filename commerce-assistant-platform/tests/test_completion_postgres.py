"""Opt-in integration against a disposable database initialized with real migrations."""

import asyncio
import os
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from app.commerce_action_engine.platform.completion import completion_metadata
from app.commerce_action_engine.platform.store import Store

DSN = os.environ.get("COMPLETION_TEST_DSN")
ADMIN_DSN = os.environ.get("COMPLETION_TEST_ADMIN_DSN")
pytestmark = pytest.mark.skipif(
    not DSN or not ADMIN_DSN, reason="isolated PostgreSQL test DSNs required"
)


def test_real_completion_queries_and_forced_owner_isolation():
    async def run():
        tenant = UUID(int=1)
        customer, other, conversation = uuid4(), uuid4(), uuid4()
        store = object.__new__(Store)
        store.pool = AsyncConnectionPool(
            DSN, open=False, kwargs={"row_factory": dict_row}
        )
        await store.open()
        try:
            before = await store.completion_insights(tenant)
            original = "find rings under 100"
            request = uuid4()
            pending = completion_metadata(
                {
                    "language_gate": {
                        "status": "NEEDS_CONTEXT",
                        "intent": "PRODUCT_SEARCH",
                    }
                },
                outcome="completed",
            )
            await store.save(
                tenant,
                customer,
                conversation,
                request,
                original,
                "Which currency?",
                [],
                pending,
            )
            await store.metric(
                tenant, request, "completed", 10, pending, conversation, customer
            )
            ctx = await store.completion_context(
                tenant, customer, conversation, expected_question=original
            )
            assert ctx["matches_original"] is True
            assert ctx["completion"]["status"] == "clarification"
            assert (
                await store.completion_context(
                    tenant, other, conversation, expected_question=original
                )
                is None
            )
            assert (
                await store.completion_context(
                    UUID(int=2), customer, conversation, expected_question=original
                )
                is None
            )
            mismatch = await store.completion_context(
                tenant, customer, conversation, expected_question="different request"
            )
            assert mismatch["matches_original"] is False
            recovered = completion_metadata(
                {
                    "language_gate": {"status": "RESOLVED", "intent": "PRODUCT_SEARCH"},
                    "completion_evidence": "read_result",
                },
                outcome="completed",
                clarification_reply=True,
                prior_completion=ctx,
            )
            assert recovered["completion"]["clarification_recovered"] is True
            second = uuid4()
            await store.save(
                tenant,
                customer,
                conversation,
                second,
                "find rings under 100 EGP",
                "Verified results",
                [],
                recovered,
            )
            await store.metric(
                tenant, second, "completed", 10, recovered, conversation, customer
            )
            latest = await store.completion_context(
                tenant, customer, conversation, expected_question=original
            )
            assert (
                latest["request_id"] == str(second)
                and latest["matches_original"] is False
            )
            await store.metric(tenant, uuid4(), "completed", 10, {}, conversation)
            counts = await store.completion_insights(tenant)
            for key, delta in {
                "turns": 3,
                "measured_turns": 2,
                "unmeasured_turns": 1,
                "tasks_completed": 1,
                "clarification": 1,
                "clarification_recovered": 1,
            }.items():
                assert counts[key] - before[key] == delta, key
            assert (await store.completion_insights(UUID(int=2)))["turns"] == 0
            async with await psycopg.AsyncConnection.connect(ADMIN_DSN) as admin:
                await admin.execute(
                    "UPDATE assistant.turns SET created_at=now()-interval '16 minutes' WHERE customer_id=%s",
                    (customer,),
                )
            assert (
                await store.completion_context(
                    tenant, customer, conversation, expected_question=original
                )
                is None
            )
        finally:
            await store.close()
            async with await psycopg.AsyncConnection.connect(ADMIN_DSN) as admin:
                await admin.execute(
                    "DELETE FROM assistant.conversations WHERE customer_id=%s",
                    (customer,),
                )
                await admin.execute(
                    "DELETE FROM assistant.metrics WHERE conversation_id=%s",
                    (conversation,),
                )

    asyncio.run(run())
