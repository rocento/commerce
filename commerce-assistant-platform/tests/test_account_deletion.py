"""Privacy endpoint authentication and real PostgreSQL resurrection protection."""

import asyncio
import os
from pathlib import Path
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from test_delivery_history import setup  # noqa: F401 -- shared signed-token fixture

from app.commerce_action_engine.platform.store import Store


def test_erasure_requires_dedicated_scope(setup):  # noqa: F811
    client, store, headers, claims = setup
    assert client.post("/v1/account-deletion", headers=headers()).status_code == 401
    result = client.post(
        "/v1/account-deletion", headers=headers(scope="account_deletion")
    )
    assert result.json() == {"deleted": True}
    store.erase_customer.assert_awaited_once_with(
        UUID(claims["tenant"]), UUID(claims["sub"])
    )
    assert (
        client.post(
            "/v1/account-deletion",
            headers=headers(scope="account_deletion", tenant=str(uuid4())),
        ).status_code
        == 401
    )


def test_erasure_failure_is_not_acknowledged(setup):  # noqa: F811
    client, store, headers, _ = setup
    store.erase_customer.side_effect = RuntimeError("private database details")
    result = client.post(
        "/v1/account-deletion", headers=headers(scope="account_deletion")
    )
    assert result.status_code == 503
    assert "private" not in result.text


def test_database_erasure_is_scoped_and_blocks_delayed_writes():
    asyncio.run(database_erasure())


async def database_erasure():
    dsn = os.environ.get("ACCOUNT_DELETION_TEST_DATABASE_URL")
    if not dsn:
        pytest.skip("Isolated deletion database required")
    config = conninfo_to_dict(dsn)
    database = "deletion_" + uuid4().hex
    tenant, customer, other, conversation, request = (uuid4() for _ in range(5))
    root = Path(__file__).resolve().parents[2]
    async with await psycopg.AsyncConnection.connect(dsn, autocommit=True) as admin:
        await admin.execute(
            "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_runtime') THEN CREATE ROLE ai_runtime LOGIN PASSWORD 'isolated_runtime'; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_knowledge_writer') THEN CREATE ROLE ai_knowledge_writer NOLOGIN; END IF; END $$"
        )
        await admin.execute(
            sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database))
        )
        try:
            async with await psycopg.AsyncConnection.connect(
                make_conninfo(**{**config, "dbname": database}), autocommit=True
            ) as migration:
                for path in sorted((root / "commerce-assistant-platform/migrations").glob("*.sql")):
                    await migration.execute(
                        path.read_text().replace(
                            ":'tenant_id'::uuid", f"'{tenant}'::uuid"
                        )
                    )
                await migration.execute(
                    (
                        root / "commerce-assistant-platform/migrations/012_account_deletion.sql"
                    ).read_text()
                )
            store = Store.__new__(Store)
            store.pool = AsyncConnectionPool(
                make_conninfo(
                    **{
                        **config,
                        "dbname": database,
                        "user": "ai_runtime",
                        "password": "isolated_runtime",
                    }
                ),
                open=False,
                kwargs={"row_factory": dict_row},
            )
            await store.open()
            try:
                await store.admit_customer_request(tenant, customer, request)
                await store.save(
                    tenant,
                    customer,
                    conversation,
                    request,
                    "Private question",
                    "Private answer",
                )
                await store.save(
                    tenant, other, uuid4(), uuid4(), "Keep question", "Keep answer"
                )
                await store.erase_customer(tenant, customer)
                await store.erase_customer(tenant, customer)
                assert await store.history(tenant, customer, None) == []
                assert len(await store.history(tenant, other, None)) == 1
                with pytest.raises(psycopg.Error):
                    await store.save(
                        tenant,
                        customer,
                        conversation,
                        uuid4(),
                        "Late private question",
                        "Late answer",
                    )
                with pytest.raises(psycopg.Error):
                    await store.admit_customer_request(tenant, customer, uuid4())
                async with store.pool.connection() as conn, conn.transaction():
                    await conn.execute(
                        "SELECT set_config('assistant.tenant',%s,true)", (str(tenant),)
                    )
                    await conn.execute(
                        "INSERT INTO assistant.metrics(tenant_id,request_id,outcome,latency_ms) VALUES(%s,%s,'late',1)",
                        (tenant, request),
                    )
                    row = await (
                        await conn.execute(
                            "SELECT count(*) AS n FROM assistant.metrics WHERE request_id=%s",
                            (request,),
                        )
                    ).fetchone()
                    assert row["n"] == 0
                with pytest.raises(psycopg.Error):
                    await store.erase_customer(uuid4(), other)
            finally:
                await store.close()
        finally:
            await admin.execute(
                sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                    sql.Identifier(database)
                )
            )


@pytest.mark.parametrize(
    "path,scope", [("/v1/chat", "chat"), ("/v1/delivery-event", "delivery_event")]
)
def test_customer_admission_storage_failure_blocks_request(setup, path, scope):  # noqa: F811
    client, store, headers, claims = setup
    store.admit_customer_request.side_effect = RuntimeError("private storage details")
    response = client.post(path, headers=headers(scope=scope), json={})
    assert response.status_code == 503
    assert response.json() == {"detail": "Account storage unavailable"}
    store.admit_customer_request.assert_awaited_once_with(
        UUID(claims["tenant"]), UUID(claims["sub"]), UUID(claims["request_id"])
    )
    store.save.assert_not_awaited()
