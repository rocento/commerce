"""Opt-in isolated database test; never reads production connection settings."""

import asyncio
import os
from pathlib import Path
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from app.commerce_contracts.agents import Principal
from app.commerce_knowledge_rag import Chunk, KnowledgeError, Source
from app.commerce_knowledge_rag.store import PostgresKnowledgeIndex

DSN = os.getenv("M04_TEST_DATABASE_URL", "")
pytestmark = pytest.mark.skipif(
    not DSN, reason="M04 isolated pgvector test database not configured"
)
TENANT = UUID(int=1)
VECTOR = [1.0] + [0.0] * 1535


def test_atomic_revisions_semantic_ranking_filters_and_database_grants():
    async def scenario():
        database = "m04_" + uuid4().hex
        async with await psycopg.AsyncConnection.connect(DSN, autocommit=True) as admin:
            await admin.execute(
                psycopg.sql.SQL("CREATE DATABASE {}").format(
                    psycopg.sql.Identifier(database)
                )
            )
            await admin.execute(
                "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_runtime') THEN CREATE ROLE ai_runtime LOGIN PASSWORD 'runtime-test-only'; END IF; END $$"
            )
        test_dsn = make_conninfo(**{**conninfo_to_dict(DSN), "dbname": database})
        async with await psycopg.AsyncConnection.connect(
            test_dsn, autocommit=True
        ) as admin:
            migrations = Path(__file__).resolve().parents[1] / "migrations"
            await admin.execute((migrations / "001_ai_store.sql").read_text())
            await admin.execute(
                (migrations / "002_deployment_boundary.sql")
                .read_text()
                .replace(":'tenant_id'::uuid", f"'{TENANT}'::uuid")
            )
            await admin.execute((migrations / "003_knowledge.sql").read_text())
            # Migration reruns must be safe.
            await admin.execute((migrations / "003_knowledge.sql").read_text())
            await admin.execute(
                "ALTER ROLE ai_knowledge_writer LOGIN PASSWORD 'writer-test-only'"
            )
        settings = conninfo_to_dict(test_dsn)

        async def index(role, password):
            pool = AsyncConnectionPool(
                make_conninfo(**{**settings, "user": role, "password": password}),
                open=False,
                min_size=0,
                max_size=2,
                kwargs={"row_factory": dict_row},
            )
            await pool.open()
            return pool, PostgresKnowledgeIndex(pool)

        writer_store, writer = await index("ai_knowledge_writer", "writer-test-only")
        reader_store, reader = await index("ai_runtime", "runtime-test-only")
        source = Source(
            id=UUID(int=3),
            tenant=TENANT,
            title="Returns",
            revision=1,
            kind="policy",
            effective_from="2020-01-01T00:00:00Z",
            valid_until="2099-01-01T00:00:00Z",
            collection="public",
            approved=True,
        )
        chunk = Chunk("a" * 64, 1, 0, "Return within 30 days.")
        who = Principal(tenant=TENANT, persona="shopper")
        try:
            assert await writer.replace(
                source, "digest1", [chunk], [VECTOR], "embedding-model"
            )
            assert not await writer.replace(
                source, "digest1", [chunk], [VECTOR], "embedding-model"
            )
            with pytest.raises(KnowledgeError, match="revision_conflict"):
                await writer.replace(
                    source, "different", [chunk], [VECTOR], "embedding-model"
                )
            with pytest.raises(KnowledgeError, match="policy_source_conflict"):
                await writer.replace(
                    source.model_copy(
                        update={"id": UUID(int=99), "title": " RETURNS "}
                    ),
                    "conflicting-policy",
                    [Chunk("b" * 64, 1, 0, "Return in 7 days")],
                    [VECTOR],
                    "embedding-model",
                )
            hits = await reader.search(
                who,
                frozenset({"public"}),
                VECTOR,
                "embedding-model",
                "en",
                frozenset({"policy"}),
            )
            assert (
                len(hits) == 1
                and hits[0].score == pytest.approx(1)
                and hits[0].chunk.text == chunk.text
            )
            assert not await reader.search(
                who, frozenset({"public"}), VECTOR, "wrong-model", None, frozenset()
            )
            assert not await reader.search(
                who, frozenset({"public"}), VECTOR, "embedding-model", "fr", frozenset()
            )
            assert not await reader.search(
                who,
                frozenset({"private"}),
                VECTOR,
                "embedding-model",
                None,
                frozenset(),
            )
            private = source.model_copy(
                update={"id": UUID(int=4), "permissions": frozenset({"reports.read"})}
            )
            assert await writer.replace(
                private, "private", [chunk], [VECTOR], "embedding-model"
            )
            assert (
                len(
                    await reader.search(
                        who,
                        frozenset({"public"}),
                        VECTOR,
                        "embedding-model",
                        None,
                        frozenset(),
                    )
                )
                == 1
            )
            revision = source.model_copy(update={"revision": 2})
            changed = Chunk("b" * 64, 2, 0, "Return within 14 days.")
            assert await writer.replace(
                revision, "digest2", [changed], [VECTOR], "embedding-model"
            )
            hits = await reader.search(
                who, frozenset({"public"}), VECTOR, "embedding-model", None, frozenset()
            )
            assert (
                len(hits) == 1
                and hits[0].source.revision == 2
                and hits[0].chunk.page == 2
            )
            assert "14 days" in hits[0].chunk.text
            with pytest.raises(psycopg.errors.CheckViolation):
                await writer.replace(
                    source.model_copy(update={"revision": 3}),
                    "bad-revision",
                    [Chunk("c" * 64, 1, 0, "x" * 1201)],
                    [VECTOR],
                    "embedding-model",
                )
            hits = await reader.search(
                who, frozenset({"public"}), VECTOR, "embedding-model", None, frozenset()
            )
            assert hits[0].source.revision == 2 and "14 days" in hits[0].chunk.text
            unrelated = source.model_copy(
                update={"id": UUID(int=5), "title": "Size guide", "kind": "size_guide"}
            )
            orthogonal = [0.0, 1.0] + [0.0] * 1534
            await writer.replace(
                unrelated, "unrelated", [chunk], [orthogonal], "embedding-model"
            )
            ranked = await reader.search(
                who, frozenset({"public"}), VECTOR, "embedding-model", None, frozenset()
            )
            assert ranked[0].source.id == source.id and ranked[
                -1
            ].score == pytest.approx(0)
            await writer.delete(TENANT, unrelated.id)
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                await reader.replace(
                    source, "attack", [chunk], [VECTOR], "embedding-model"
                )
            other = Principal(tenant=UUID(int=99), persona="shopper")
            assert not await reader.search(
                other,
                frozenset({"public"}),
                VECTOR,
                "embedding-model",
                None,
                frozenset(),
            )
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                await writer.replace(
                    source.model_copy(update={"tenant": UUID(int=99)}),
                    "cross",
                    [chunk],
                    [VECTOR],
                    "embedding-model",
                )
            await writer.delete(TENANT, source.id)
            assert not await reader.search(
                who, frozenset({"public"}), VECTOR, "embedding-model", None, frozenset()
            )
        finally:
            await writer_store.close()
            await reader_store.close()

    asyncio.run(scenario())
