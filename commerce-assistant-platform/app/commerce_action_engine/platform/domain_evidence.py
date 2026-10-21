"""Read immutable domain releases and tenant evidence from the shared assistant DB."""

from typing import Any
from uuid import UUID

from psycopg import AsyncConnection
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from app.commerce_action_engine.actions.domain_evidence.contracts import (
    DomainPack,
    ProductFact,
)


class PostgresDomainEvidence:
    def __init__(
        self, pool: AsyncConnectionPool[AsyncConnection[dict[str, Any]]]
    ) -> None:
        self.pool = pool

    async def active_pack(self, tenant: UUID) -> DomainPack | None:
        async with self.pool.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT set_config('assistant.tenant',%s,true)", (str(tenant),)
            )
            row = await (
                await conn.execute(
                    """SELECT r.fingerprint,r.manifest FROM assistant.domain_bindings b
                JOIN assistant.domain_releases r ON r.fingerprint=b.release_fingerprint
                WHERE b.tenant_id=%s AND NOT EXISTS(SELECT 1 FROM assistant.domain_release_revocations v WHERE v.fingerprint=r.fingerprint)""",
                    (tenant,),
                )
            ).fetchone()
        if not row:
            return None
        pack = DomainPack.model_validate(row["manifest"])
        if pack.fingerprint != row["fingerprint"]:
            raise ValueError("Domain release fingerprint mismatch")
        return pack

    async def product_facts(
        self, tenant: UUID, products: tuple[UUID, ...]
    ) -> tuple[ProductFact, ...]:
        if not products:
            return ()
        if len(products) > 64:
            raise ValueError("Product evidence read exceeds request bound")
        async with self.pool.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT set_config('assistant.tenant',%s,true)", (str(tenant),)
            )
            rows = await (
                await conn.execute(
                    """SELECT e.metadata FROM assistant.product_evidence e
                WHERE e.tenant_id=%s AND e.product_id=ANY(%s) AND NOT EXISTS (
                  SELECT 1 FROM assistant.product_evidence_revocations v
                  WHERE v.tenant_id=e.tenant_id AND v.evidence_id=e.id)
                ORDER BY e.id LIMIT 1281""",
                    (tenant, list(products)),
                )
            ).fetchall()
        if len(rows) > 1280:
            raise ValueError("Too many evidence records; review duplicate attestations")
        return tuple(ProductFact.model_validate(r["metadata"]) for r in rows)


async def stage_pack(conn: AsyncConnection[Any], pack: DomainPack) -> str:
    """Operator import; a transaction stages all rows without creating bindings."""
    fingerprint = pack.fingerprint
    async with conn.transaction():
        await conn.execute(
            "INSERT INTO assistant.domain_releases(fingerprint,revision,manifest) VALUES(%s,%s,%s) ON CONFLICT DO NOTHING",
            (fingerprint, pack.revision, Jsonb(pack.model_dump(mode="json"))),
        )
        for table, records in (
            ("domain_sources", pack.sources),
            ("domain_profiles", pack.profiles),
        ):
            for record in records:
                await conn.execute(
                    f"INSERT INTO assistant.{table}(release_fingerprint,id,metadata) VALUES(%s,%s,%s) ON CONFLICT DO NOTHING",
                    (fingerprint, record.id, Jsonb(record.model_dump(mode="json"))),
                )
    return fingerprint


async def attest_product(conn: AsyncConnection[Any], fact: ProductFact) -> None:
    """Knowledge-writer import, constrained by tenant login and immutable fact ID."""
    async with conn.transaction():
        await conn.execute(
            "SELECT set_config('assistant.tenant',%s,true)", (str(fact.tenant_id),)
        )
        await conn.execute(
            "INSERT INTO assistant.product_evidence(tenant_id,product_id,id,metadata) VALUES(%s,%s,%s,%s)",
            (
                fact.tenant_id,
                fact.product_id,
                fact.id,
                Jsonb(fact.model_dump(mode="json")),
            ),
        )
