"""Real PostgreSQL migrations, login-bound isolation, immutable releases and rollback."""

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
from test_domain_evidence import PACK, TENANT, sample

from app.commerce_action_engine.platform.domain_evidence import (
    PostgresDomainEvidence,
    attest_product,
    stage_pack,
)

DSN = os.getenv("PHASE3_TEST_DATABASE_URL", "")
pytestmark = pytest.mark.skipif(
    not DSN, reason="Dedicated Phase 3 database not configured"
)
ROOT = Path(__file__).resolve().parents[2]


async def initialize(conn):
    await conn.execute("""DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_runtime') THEN CREATE ROLE ai_runtime NOLOGIN; END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_knowledge_writer') THEN CREATE ROLE ai_knowledge_writer NOLOGIN; END IF;
    END $$""")
    for path in sorted((ROOT / "commerce-assistant-platform/migrations").glob("*.sql")):
        await conn.execute(
            path.read_text().replace(":'tenant_id'::uuid", f"'{TENANT}'::uuid")
        )
    await conn.execute((ROOT / "commerce-ops/deploy/assistant/shared-tenants.sql").read_text())
    # Both ordinary reruns and shared reapplication retain isolation and grants.
    await conn.execute(
        (ROOT / "commerce-assistant-platform/migrations/011_domain_evidence.sql").read_text()
    )
    await conn.execute((ROOT / "commerce-ops/deploy/assistant/shared-tenants.sql").read_text())


def test_shared_database_staging_tenant_isolation_immutability_revocation_and_rollback():
    async def run():
        suffix = uuid4().hex[:16]
        database, login = "phase3_" + suffix, "p3_reader_" + suffix
        writer = "p3_writer_" + suffix
        password = uuid4().hex  # disposable test credential, never logged
        config = conninfo_to_dict(DSN)
        async with await psycopg.AsyncConnection.connect(DSN, autocommit=True) as admin:
            await admin.execute(
                sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database))
            )
            try:
                test_dsn = make_conninfo(**{**config, "dbname": database})
                async with await psycopg.AsyncConnection.connect(
                    test_dsn, autocommit=True
                ) as conn:
                    await initialize(conn)
                    for role, group in (
                        (login, "ai_runtime"),
                        (writer, "ai_knowledge_writer"),
                    ):
                        await conn.execute(
                            sql.SQL(
                                "CREATE ROLE {} LOGIN INHERIT PASSWORD {} IN ROLE {}"
                            ).format(
                                sql.Identifier(role),
                                sql.Literal(password),
                                sql.Identifier(group),
                            )
                        )
                        await conn.execute(
                            "INSERT INTO assistant.tenant_logins VALUES(%s,%s,'fixture')",
                            (role, TENANT),
                        )
                    assert await stage_pack(conn, PACK) == PACK.fingerprint
                    assert await stage_pack(conn, PACK) == PACK.fingerprint
                    with pytest.raises(psycopg.Error, match="immutable"):
                        await conn.execute(
                            "UPDATE assistant.domain_profiles SET metadata=metadata"
                        )
                    with pytest.raises(psycopg.Error, match="immutable"):
                        await conn.execute("DELETE FROM assistant.domain_releases")
                async with AsyncConnectionPool(
                    make_conninfo(
                        **{
                            **config,
                            "dbname": database,
                            "user": login,
                            "password": password,
                        }
                    ),
                    min_size=1,
                    max_size=2,
                    kwargs={"row_factory": dict_row},
                    open=False,
                ) as pool:
                    reader = PostgresDomainEvidence(pool)
                    assert (
                        await reader.active_pack(TENANT) is None
                    )  # staged means inactive
                    p, _, facts = sample()
                    async with await psycopg.AsyncConnection.connect(
                        test_dsn, autocommit=True
                    ) as owner:
                        await owner.execute(
                            "INSERT INTO assistant.domain_bindings(tenant_id,release_fingerprint) VALUES(%s,%s)",
                            (TENANT, PACK.fingerprint),
                        )
                    assert (
                        await reader.active_pack(TENANT)
                    ).fingerprint == PACK.fingerprint
                    assert await reader.active_pack(UUID(int=2)) is None
                    async with await psycopg.AsyncConnection.connect(
                        make_conninfo(
                            **{
                                **config,
                                "dbname": database,
                                "user": writer,
                                "password": password,
                            }
                        ),
                        autocommit=True,
                    ) as author:
                        await attest_product(author, facts[0])
                        with pytest.raises(psycopg.Error):
                            await attest_product(
                                author,
                                facts[0].model_copy(
                                    update={"id": uuid4(), "tenant_id": UUID(int=2)}
                                ),
                            )
                        with pytest.raises(psycopg.Error):
                            await author.execute(
                                "UPDATE assistant.domain_bindings SET activated_at=now()"
                            )
                    assert len(await reader.product_facts(TENANT, (p.id,))) == 1
                    assert not await reader.product_facts(UUID(int=2), (p.id,))
                    async with pool.connection() as c:
                        with pytest.raises(psycopg.Error):
                            async with c.transaction():
                                await c.execute(
                                    "UPDATE assistant.domain_bindings SET activated_at=now()"
                                )
                        with pytest.raises(psycopg.Error):
                            async with c.transaction():
                                await c.execute(
                                    "DELETE FROM assistant.product_evidence"
                                )
                    async with await psycopg.AsyncConnection.connect(
                        test_dsn, autocommit=True
                    ) as owner:
                        await owner.execute(
                            "INSERT INTO assistant.product_evidence_revocations(tenant_id,evidence_id,reason) VALUES(%s,%s,'withdrawn fixture')",
                            (TENANT, facts[0].id),
                        )
                        assert not await reader.product_facts(TENANT, (p.id,))
                        next_pack = PACK.model_copy(update={"revision": 2})
                        await stage_pack(owner, next_pack)
                        await owner.execute(
                            "UPDATE assistant.domain_bindings SET release_fingerprint=%s WHERE tenant_id=%s",
                            (next_pack.fingerprint, TENANT),
                        )
                        assert (
                            await reader.active_pack(TENANT)
                        ).fingerprint == next_pack.fingerprint
                        await owner.execute(
                            "UPDATE assistant.domain_bindings SET release_fingerprint=%s WHERE tenant_id=%s",
                            (PACK.fingerprint, TENANT),
                        )
                        assert (
                            await reader.active_pack(TENANT)
                        ).fingerprint == PACK.fingerprint
                        await owner.execute(
                            "INSERT INTO assistant.domain_release_revocations(fingerprint,reason) VALUES(%s,'withdrawn fixture')",
                            (PACK.fingerprint,),
                        )
                        assert await reader.active_pack(TENANT) is None
            finally:
                await admin.execute(
                    sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                        sql.Identifier(database)
                    )
                )
                for role in (login, writer):
                    await admin.execute(
                        sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(role))
                    )

    asyncio.run(run())
