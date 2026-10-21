"""Opt-in actual RLS, expiration and concurrent claim checks in a disposable DB.

Uses the same isolated database/roles as test_completion_postgres. This test
applies migration 006 using the admin connection; never use a production DSN.
"""

import asyncio
import os
from pathlib import Path
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from app.commerce_action_engine.platform.store import Store

DSN = os.environ.get("COMPLETION_TEST_DSN")
ADMIN_DSN = os.environ.get("COMPLETION_TEST_ADMIN_DSN")
pytestmark = pytest.mark.skipif(
    not DSN or not ADMIN_DSN, reason="isolated PostgreSQL test DSNs required"
)


def test_real_atomic_claims_expiry_rls_and_late_publication():
    async def run():
        tenant, customer, conversation = UUID(int=1), uuid4(), uuid4()
        scope = (tenant, customer, conversation)
        store = object.__new__(Store)
        store.pool = AsyncConnectionPool(
            DSN, open=False, kwargs={"row_factory": dict_row}
        )
        async with await psycopg.AsyncConnection.connect(ADMIN_DSN) as admin:
            migration = (
                Path(__file__).resolve().parents[1]
                / "migrations/006_request_revisions.sql"
            ).read_text()
            await admin.execute(migration)
            await admin.execute(migration)  # upgrade is repeatable
            shopping_migration = (
                Path(__file__).resolve().parents[1]
                / "migrations/009_shopping_clarifications.sql"
            ).read_text()
            await admin.execute(shopping_migration)
        await store.open()
        try:
            first = await store.begin_request(*scope)
            assert await store.publish_question(
                *scope, first, "add it", "Which product?"
            )

            async def claim(*owner):
                return await store.begin_request(
                    *owner,
                    expected_revision=first,
                    original="add it",
                    question="Which product?",
                )

            assert await claim(tenant, uuid4(), conversation) is None
            assert await claim(tenant, customer, uuid4()) is None
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                await claim(UUID(int=2), customer, conversation)
            claims = await asyncio.gather(claim(*scope), claim(*scope))
            assert sum(value is not None for value in claims) == 1
            current = next(value for value in claims if value)
            assert not await store.publish_question(
                *scope, first, "add it", "Which product?"
            )
            assert await store.publish_question(
                *scope, current, "add it", "Which product?"
            )
            async with await psycopg.AsyncConnection.connect(ADMIN_DSN) as admin:
                await admin.execute(
                    "UPDATE assistant.request_revisions SET expires_at=now()-interval '1 second' WHERE customer_id=%s",
                    (customer,),
                )
            assert (
                await store.begin_request(
                    *scope,
                    expected_revision=current,
                    original="add it",
                    question="Which product?",
                )
                is None
            )
            older = await store.begin_request(*scope)
            newer = await store.begin_request(*scope)
            assert not await store.publish_question(
                *scope, older, "old", "old question"
            )
            assert await store.publish_question(*scope, newer, "new", "new question")
            # Cascading retention removes the pending authority too.
            async with await psycopg.AsyncConnection.connect(ADMIN_DSN) as admin:
                await admin.execute(
                    "DELETE FROM assistant.conversations WHERE tenant_id=%s AND customer_id=%s AND id=%s",
                    scope,
                )
                row = await (
                    await admin.execute(
                        "SELECT count(*) FROM assistant.request_revisions WHERE customer_id=%s",
                        (customer,),
                    )
                ).fetchone()
                assert row[0] == 0
        finally:
            await store.close()
            async with await psycopg.AsyncConnection.connect(ADMIN_DSN) as admin:
                await admin.execute(
                    "DELETE FROM assistant.conversations WHERE id=%s OR customer_id=%s",
                    (conversation, customer),
                )

    asyncio.run(run())
