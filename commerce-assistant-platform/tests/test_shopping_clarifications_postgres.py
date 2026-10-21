"""Actual owner/session RLS, revision CAS, expiry and concurrent read continuations.

Use only the dedicated disposable database configured by the two test DSNs.
"""

import asyncio
import os
from pathlib import Path
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from test_shopping_clarifications import question

from app.commerce_action_engine.actions.shopping.continuation import ActiveShopping
from app.commerce_action_engine.platform.store import Store

DSN = os.environ.get("COMPLETION_TEST_DSN")
ADMIN_DSN = os.environ.get("COMPLETION_TEST_ADMIN_DSN")
pytestmark = pytest.mark.skipif(
    not DSN or not ADMIN_DSN, reason="isolated PostgreSQL test DSNs required"
)


def test_real_scopes_expiry_single_claim_and_new_turn_supersession():
    async def run():
        scope = (UUID(int=1), uuid4(), uuid4())
        store_id, session_id = uuid4(), uuid4()
        store = object.__new__(Store)
        store.pool = AsyncConnectionPool(
            DSN, open=False, kwargs={"row_factory": dict_row}
        )
        migrations = Path(__file__).parents[1] / "migrations"
        async with await psycopg.AsyncConnection.connect(ADMIN_DSN) as admin:
            for name in [
                "006_request_revisions.sql",
                "009_shopping_clarifications.sql",
                "009_shopping_clarifications.sql",
            ]:
                await admin.execute((migrations / name).read_text())
        await store.open()
        try:
            revision = await store.begin_request(*scope)
            assert await store.publish_shopping_question(
                *scope,
                revision,
                "rings",
                question(),
                store_id=store_id,
                session_id=session_id,
            )

            async def read(*owner, **kwargs):
                return await store.shopping_question(
                    *owner,
                    store_id=kwargs.get("store_id", store_id),
                    session_id=kwargs.get("session_id", session_id),
                    revision=revision,
                )

            assert (await read(*scope))["plan"] == question()
            assert await read(scope[0], uuid4(), scope[2]) is None
            assert await read(scope[0], scope[1], uuid4()) is None
            assert await read(UUID(int=2), scope[1], scope[2]) is None
            assert await read(*scope, store_id=uuid4()) is None
            assert await read(*scope, session_id=uuid4()) is None
            # A legacy compound revision cannot claim a shopping frame.
            assert (
                await store.begin_request(
                    *scope,
                    expected_revision=revision,
                    original="rings",
                    question=question().question,
                )
                is None
            )

            async def claim():
                return await store.claim_shopping_question(
                    *scope,
                    store_id=store_id,
                    session_id=session_id,
                    revision=revision,
                    original="rings",
                    question=question().question,
                )

            claims = await asyncio.gather(claim(), claim())
            assert sum(value is not None for value in claims) == 1
            current = next(value for value in claims if value is not None)
            assert await read(*scope) is None
            assert not await store.publish_shopping_question(
                *scope,
                revision,
                "rings",
                question(),
                store_id=store_id,
                session_id=session_id,
            )
            assert await store.publish_shopping_question(
                *scope,
                current,
                "rings",
                question(),
                store_id=store_id,
                session_id=session_id,
            )
            async with await psycopg.AsyncConnection.connect(ADMIN_DSN) as admin:
                await admin.execute(
                    "UPDATE assistant.request_revisions SET expires_at=now()-interval '1 second' WHERE tenant_id=%s AND customer_id=%s AND conversation_id=%s",
                    scope,
                )
            assert (
                await store.shopping_question(
                    *scope, store_id=store_id, session_id=session_id
                )
                is None
            )
            assert (
                await store.claim_shopping_question(
                    *scope,
                    store_id=store_id,
                    session_id=session_id,
                    revision=current,
                    original="rings",
                    question=question().question,
                )
                is None
            )

            latest = await store.begin_request(*scope)
            assert await store.publish_shopping_question(
                *scope,
                latest,
                "rings",
                question(),
                store_id=store_id,
                session_id=session_id,
            )
            superseding = await store.begin_request(*scope)
            assert superseding != latest
            assert (
                await store.shopping_question(
                    *scope, store_id=store_id, session_id=session_id
                )
                is None
            )
            assert not await store.publish_shopping_question(
                *scope,
                latest,
                "rings",
                question(),
                store_id=store_id,
                session_id=session_id,
            )
            active = ActiveShopping(
                frame=question().frame, descriptor_revision="catalog-v1", currency="USD"
            )
            assert await store.save_active_shopping(
                *scope,
                superseding,
                "rings",
                active,
                store_id=store_id,
                session_id=session_id,
            )
            assert (
                await store.shopping_active(
                    *scope, store_id=store_id, session_id=session_id
                )
            )["active"] == active
            assert (
                await store.shopping_active(
                    *scope, store_id=store_id, session_id=uuid4()
                )
                is None
            )

            async def active_claim():
                return await store.claim_active_shopping(
                    *scope,
                    store_id=store_id,
                    session_id=session_id,
                    revision=superseding,
                )

            active_claims = await asyncio.gather(active_claim(), active_claim())
            assert sum(value is not None for value in active_claims) == 1
            assert (
                await store.shopping_active(
                    *scope, store_id=store_id, session_id=session_id
                )
                is None
            )
        finally:
            await store.close()
            async with await psycopg.AsyncConnection.connect(ADMIN_DSN) as admin:
                await admin.execute(
                    "DELETE FROM assistant.conversations WHERE tenant_id=%s AND customer_id=%s AND id=%s",
                    scope,
                )

    asyncio.run(run())
