"""AI-store persistence; runtime has SELECT only, operator ingestion has a separate role."""

import json
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool
from pydantic import ValidationError

from app.commerce_contracts.agents import Principal
from app.commerce_contracts.intent_example import IndexedIntentExample
from app.commerce_knowledge_rag.intent_examples import (
    normalized_utterance,
    review_examples,
)
from app.commerce_knowledge_rag.policy_review import policy_identity
from app.commerce_knowledge_rag.service import (
    Chunk,
    Hit,
    KnowledgeError,
    Source,
    validate_vectors,
)


class PostgresKnowledgeIndex:
    def __init__(self, pool: AsyncConnectionPool[AsyncConnection[dict[str, Any]]]):
        # Application composition owns credentials and the pool lifecycle.
        self.pool = pool

    async def validate_example_chunks(
        self, source: Source, chunks: list[Chunk], model: str
    ) -> None:
        """Preflight before embeddings; replacement repeats this under its lock."""
        async with self.pool.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT set_config('assistant.tenant',%s,true)", (str(source.tenant),)
            )
            row = await (
                await conn.execute(
                    "SELECT model FROM assistant.knowledge_sources WHERE tenant_id=%s AND id=%s",
                    (source.tenant, source.id),
                )
            ).fetchone()
            if row and row["model"] != model:
                raise KnowledgeError("embedding_model_migration_required")
            await self._check_example_chunks(conn, source, chunks, model)

    async def _check_example_chunks(
        self,
        conn: AsyncConnection[dict[str, Any]],
        source: Source,
        chunks: list[Chunk],
        model: str,
    ) -> bool:
        incoming: list[IndexedIntentExample] = []
        for chunk in chunks:
            try:
                incoming.append(IndexedIntentExample.model_validate_json(chunk.text))
            except ValidationError:
                return (
                    False  # Ordinary answer documents have a separate publication path.
                )
        if not incoming:
            return False
        rows = await (
            await conn.execute(
                """SELECT c.body,s.model FROM assistant.knowledge_chunks c
            JOIN assistant.knowledge_sources s ON s.tenant_id=c.tenant_id AND s.id=c.source_id
            WHERE s.tenant_id=%s AND s.collection=%s AND s.id<>%s LIMIT 4097""",
                (source.tenant, source.collection, source.id),
            )
        ).fetchall()
        if len(rows) > 4096:
            raise KnowledgeError("example_collection_review_limit")
        if any(row["model"] != model for row in rows):
            raise KnowledgeError("embedding_model_migration_required")
        existing: list[IndexedIntentExample] = []
        for row in rows:
            try:
                existing.append(IndexedIntentExample.model_validate_json(row["body"]))
            except ValidationError:
                raise KnowledgeError("example_collection_mixed_content") from None
        review_examples([*existing, *incoming])
        keys = {normalized_utterance(item.utterance) for item in existing}
        if any(normalized_utterance(item.utterance) in keys for item in incoming):
            raise KnowledgeError("example_duplicate_source")
        return True

    async def unchanged(self, source: Source, digest: str, model: str) -> bool:
        """Avoid an embedding request when the approved source is already indexed."""
        metadata = source.model_dump(mode="json")
        metadata["personas"] = sorted(source.personas)
        metadata["permissions"] = sorted(source.permissions)
        async with self.pool.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT set_config('assistant.tenant',%s,true)", (str(source.tenant),)
            )
            row = await (
                await conn.execute(
                    "SELECT revision,digest,metadata,model FROM assistant.knowledge_sources WHERE tenant_id=%s AND id=%s",
                    (source.tenant, source.id),
                )
            ).fetchone()
        return bool(
            row
            and row["revision"] == source.revision
            and row["digest"] == digest
            and row["metadata"] == metadata
            and row["model"] == model
        )

    async def replace(
        self,
        source: Source,
        digest: str,
        chunks: list[Chunk],
        vectors: list[list[float]],
        model: str,
    ) -> bool:
        if not source.current():
            raise KnowledgeError("source_not_current")
        validate_vectors(vectors, len(chunks))
        async with self.pool.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT set_config('assistant.tenant',%s,true)", (str(source.tenant),)
            )
            # Collection lock serializes cross-source review, including first publication.
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
                (f"knowledge:{source.tenant}:{source.collection}",),
            )
            if source.kind == "policy":
                rows = await (
                    await conn.execute(
                        "SELECT metadata FROM assistant.knowledge_sources WHERE tenant_id=%s AND collection=%s AND kind='policy' AND id<>%s",
                        (source.tenant, source.collection, source.id),
                    )
                ).fetchall()
                for item in rows:
                    other = Source.model_validate(item["metadata"])
                    if (
                        other.current()
                        and other.language == source.language
                        and other.personas & source.personas
                        and other.permissions == source.permissions
                        and policy_identity(other.title)
                        == policy_identity(source.title)
                    ):
                        raise KnowledgeError(
                            "policy_source_conflict_use_existing_revision"
                        )
            is_examples = await self._check_example_chunks(conn, source, chunks, model)
            # Serialize same-source replacements, including first publication.
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
                (f"{source.tenant}:{source.id}",),
            )
            row = await (
                await conn.execute(
                    "SELECT revision,digest,metadata,model FROM assistant.knowledge_sources WHERE tenant_id=%s AND id=%s FOR UPDATE",
                    (source.tenant, source.id),
                )
            ).fetchone()
            metadata = source.model_dump(mode="json")
            # Stable JSON for set-valued policy metadata.
            metadata["personas"] = sorted(source.personas)
            metadata["permissions"] = sorted(source.permissions)
            if row:
                if row["model"] != model and is_examples:
                    raise KnowledgeError("embedding_model_migration_required")
                if (
                    row["revision"] == source.revision
                    and row["digest"] == digest
                    and row["metadata"] == metadata
                    and row["model"] == model
                ):
                    return False
                if row["revision"] >= source.revision:
                    raise KnowledgeError("revision_conflict")
            await conn.execute(
                """INSERT INTO assistant.knowledge_sources
                (tenant_id,id,revision,metadata,digest,model,approved,collection,language,kind,personas,permissions)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT(tenant_id,id) DO UPDATE SET revision=excluded.revision,metadata=excluded.metadata,
                digest=excluded.digest,model=excluded.model,approved=excluded.approved,collection=excluded.collection,
                language=excluded.language,kind=excluded.kind,personas=excluded.personas,permissions=excluded.permissions,updated_at=now()""",
                (
                    source.tenant,
                    source.id,
                    source.revision,
                    Jsonb(metadata),
                    digest,
                    model,
                    source.approved,
                    source.collection,
                    source.language,
                    source.kind,
                    sorted(source.personas),
                    sorted(source.permissions),
                ),
            )
            await conn.execute(
                "DELETE FROM assistant.knowledge_chunks WHERE tenant_id=%s AND source_id=%s",
                (source.tenant, source.id),
            )
            for chunk, vector in zip(chunks, vectors, strict=True):
                await conn.execute(
                    """INSERT INTO assistant.knowledge_chunks
                    (tenant_id,source_id,id,page,ordinal,body,embedding) VALUES(%s,%s,%s,%s,%s,%s,%s::vector)""",
                    (
                        source.tenant,
                        source.id,
                        chunk.id,
                        chunk.page,
                        chunk.ordinal,
                        chunk.text,
                        json.dumps(vector),
                    ),
                )
        return True

    async def delete(self, tenant: UUID, source_id: UUID) -> None:
        async with self.pool.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT set_config('assistant.tenant',%s,true)", (str(tenant),)
            )
            await conn.execute(
                "DELETE FROM assistant.knowledge_sources WHERE tenant_id=%s AND id=%s",
                (tenant, source_id),
            )

    async def search(
        self,
        principal: Principal,
        collections: frozenset[str],
        vector: list[float],
        model: str,
        language: str | None,
        kinds: frozenset[str],
    ) -> list[Hit]:
        validate_vectors([vector], 1)
        async with self.pool.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT set_config('assistant.tenant',%s,true)",
                (str(principal.tenant),),
            )
            rows = await (
                await conn.execute(
                    """SELECT s.metadata,c.id,c.page,c.ordinal,c.body,
                1-(c.embedding <=> %s::vector) AS score
                FROM assistant.knowledge_chunks c JOIN assistant.knowledge_sources s
                ON s.tenant_id=c.tenant_id AND s.id=c.source_id
                WHERE s.tenant_id=%s AND s.approved AND s.collection=ANY(%s) AND s.model=%s
                AND (s.metadata->>'withdrawn_at' IS NULL OR (s.metadata->>'withdrawn_at')::timestamptz>now())
                AND (s.kind<>'policy' OR (s.metadata->>'effective_from' IS NOT NULL AND s.metadata->>'valid_until' IS NOT NULL))
                AND (s.metadata->>'effective_from' IS NULL OR (s.metadata->>'effective_from')::timestamptz<=now())
                AND (s.metadata->>'valid_until' IS NULL OR (s.metadata->>'valid_until')::timestamptz>now())
                AND %s=ANY(s.personas) AND s.permissions <@ %s::text[]
                AND (%s::text IS NULL OR s.language=%s) AND (cardinality(%s::text[])=0 OR s.kind=ANY(%s))
                AND CASE WHEN pg_input_is_valid(c.body,'jsonb') THEN
                  CASE WHEN c.body::jsonb->>'schema_version'='intent-example-v2' THEN
                    c.body::jsonb->'review'->>'label'='positive'
                    AND c.body::jsonb->'review'->>'review_status'='approved'
                    AND c.body::jsonb->'review'->>'split'='train'
                    AND c.body::jsonb->'review'->'context_requirements'='[]'::jsonb
                  ELSE true END
                ELSE true END
                ORDER BY c.embedding <=> %s::vector, c.source_id,c.ordinal LIMIT 32""",
                    (
                        json.dumps(vector),
                        principal.tenant,
                        sorted(collections),
                        model,
                        principal.persona,
                        sorted(principal.permissions),
                        language,
                        language,
                        sorted(kinds),
                        sorted(kinds),
                        json.dumps(vector),
                    ),
                )
            ).fetchall()
        return [
            Hit(
                Source.model_validate(row["metadata"]),
                Chunk(row["id"], row["page"], row["ordinal"], row["body"]),
                float(row["score"]),
            )
            for row in rows
        ]
