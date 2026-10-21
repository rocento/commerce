"""Stage only in the dedicated localhost Phase 3 assistant database."""

import asyncio
import hashlib
import json
import os
import sys
from pathlib import Path

import psycopg
from psycopg.conninfo import conninfo_to_dict
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "commerce-assistant-platform"))
from app.commerce_action_engine.actions.domain_evidence.contracts import DomainPack
from app.commerce_action_engine.platform.domain_evidence import stage_pack


async def main():
    dsn = os.environ["PHASE3_DATABASE_URL"]
    options = conninfo_to_dict(dsn)
    assert (options["host"], options["port"], options["dbname"]) == (
        "127.0.0.1",
        "57433",
        "assistant",
    )
    async with await psycopg.AsyncConnection.connect(
        os.environ["PHASE3_TEST_DATABASE_URL"], autocommit=True
    ) as admin:
        exists = await (
            await admin.execute("SELECT 1 FROM pg_database WHERE datname='assistant'")
        ).fetchone()
        if not exists:
            await admin.execute("CREATE DATABASE assistant")
    async with await psycopg.AsyncConnection.connect(
        dsn, autocommit=True, row_factory=dict_row
    ) as conn:
        existing = await (
            await conn.execute(
                "SELECT to_regclass('assistant.domain_releases') AS table_name"
            )
        ).fetchone()
        if existing["table_name"] is None:
            await conn.execute("""DO $$ BEGIN
                IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_runtime') THEN CREATE ROLE ai_runtime NOLOGIN; END IF;
                IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_knowledge_writer') THEN CREATE ROLE ai_knowledge_writer NOLOGIN; END IF;
            END $$""")
            async with conn.transaction():
                for path in sorted((ROOT / "commerce-assistant-platform/migrations").glob("*.sql")):
                    await conn.execute(
                        path.read_text().replace(
                            ":'tenant_id'::uuid",
                            "'00000000-0000-0000-0000-000000000001'::uuid",
                        )
                    )
                await conn.execute(
                    (ROOT / "commerce-ops/deploy/assistant/shared-tenants.sql").read_text()
                )
        out = ROOT / "output/enterprise-knowledge-phase3-20261010"
        pack = DomainPack.model_validate_json((out / "candidate.json").read_text())
        for source in pack.sources:
            assert (
                hashlib.sha256((out / source.document_ref).read_bytes()).hexdigest()
                == source.document_sha256
            )
        fingerprint = await stage_pack(conn, pack)
        rows = await (
            await conn.execute(
                "SELECT id,metadata FROM assistant.domain_profiles WHERE release_fingerprint=%s ORDER BY id",
                (fingerprint,),
            )
        ).fetchall()
        assert {row["id"]: row["metadata"] for row in rows} == {
            p.id: p.model_dump(mode="json") for p in pack.profiles
        }
        counts = await (
            await conn.execute(
                "SELECT (SELECT count(*) FROM assistant.domain_bindings) AS active_bindings,(SELECT count(*) FROM assistant.product_evidence) AS product_facts"
            )
        ).fetchone()
        assert counts == {"active_bindings": 0, "product_facts": 0}
        report = {
            "database": "assistant",
            "host": "127.0.0.1",
            "port": 57433,
            "container": "commerce-knowledge-phase3-db",
            "fingerprint": fingerprint,
            "profiles": len(rows),
            "sources": len(pack.sources),
            **counts,
            "migration": "011_domain_evidence.sql",
            "production_touched": False,
        }
        (out / "local-stage.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report))


asyncio.run(main())
