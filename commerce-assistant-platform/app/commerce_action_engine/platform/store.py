"""AI-owned operational history. Parameterized queries plus forced owner/tenant RLS."""

import json
import re
from pathlib import Path
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from app.commerce_contracts.compound_plan import CompoundScope

from .completion import completion_context as bounded_completion_context
from .compound_plans import CompoundPlanStore
from .request_revisions import RequestRevisionStore
from .shopping_questions import ShoppingQuestionStore
from .tracking import TrackingStore

# Runtime result labels for internal routing/fallbacks, never external model IDs.
INTERNAL_MODEL_NAMES = (
    "commerce-language-engine",
    "approved-knowledge",
    "deterministic",
    "unconfigured",
)


def redact(text: str) -> str:
    text = re.sub(r"(?i)\b(?:bearer\s+|sk-|password\s*[:=]\s*)\S+", "[redacted]", text)
    text = re.sub(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b", "[contact redacted]", text)
    return re.sub(r"(?<!\w)\+?\d[\d -]{7,}\d(?!\w)", "[number redacted]", text)


def scrub(value: Any, key: str = "") -> Any:
    if isinstance(value, dict):
        return {k: scrub(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v, key) for v in value]
    if isinstance(value, str) and key not in {
        "id",
        "product_id",
        "sku",
        "image_id",
        "route",
        "kind",
        "currency",
        "price",
    }:
        return redact(value)
    return value


def message_metadata(metadata: dict[str, Any] | None) -> dict[str, Any]:
    """Keep history/recovery fields within migration 004's 2 KiB limit.

    Full routing, retrieval and usage diagnostics belong to ``metrics``. Never
    truncate JSON or a completion/receipt field to make it fit. The default JSON
    encoder escapes non-ASCII text, conservatively bounding PostgreSQL's UTF-8
    jsonb representation as well.
    """
    result: dict[str, Any] = {}
    source = metadata or {}
    for key in (
        "response_source",
        "model_calls",
        "completion",
        "compound_plan_id",
        "compound_action_states",
        "route_reason",
    ):
        if key in source:
            candidate = {**result, key: source[key]}
            if len(json.dumps(candidate).encode("utf-8")) <= 2048:
                result = candidate
    return result


class Store(
    RequestRevisionStore, ShoppingQuestionStore, CompoundPlanStore, TrackingStore
):
    def __init__(
        self,
        password_file: str,
        *,
        knowledge_writer: bool = False,
        host: str = "ai-postgres",
        user: str = "ai_runtime",
    ):
        self.pool: AsyncConnectionPool[AsyncConnection[dict[str, Any]]] = (
            AsyncConnectionPool(
                make_conninfo(
                    host=host,
                    port=5432,
                    dbname="assistant",
                    user=user.replace("ai_runtime", "ai_knowledge_writer", 1)
                    if knowledge_writer
                    else user,
                    password=Path(password_file).read_text().strip(),
                    connect_timeout=2,
                ),
                min_size=0,
                max_size=4,
                timeout=2,
                open=False,
                kwargs={"row_factory": dict_row},
            )
        )

    async def admit_customer_request(
        self, tenant: UUID, customer: UUID, request: UUID
    ) -> None:
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true),set_config('assistant.customer',%s,true)",
                (str(tenant), str(customer)),
            )
            await connection.execute(
                "INSERT INTO assistant.customer_requests(tenant_id,customer_id,request_id) VALUES(%s,%s,%s) ON CONFLICT DO NOTHING",
                (tenant, customer, request),
            )

    async def erase_customer(self, tenant: UUID, customer: UUID) -> None:
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true),set_config('assistant.customer',%s,true)",
                (str(tenant), str(customer)),
            )
            await connection.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,72))",
                (str(tenant) + str(customer),),
            )
            await connection.execute(
                "INSERT INTO assistant.deleted_customers VALUES(%s,%s) ON CONFLICT DO NOTHING",
                (tenant, customer),
            )
            rows = await (
                await connection.execute(
                    "SELECT request_id FROM assistant.customer_requests WHERE tenant_id=%s AND customer_id=%s UNION SELECT request_id FROM assistant.turns WHERE tenant_id=%s AND customer_id=%s ORDER BY request_id",
                    (tenant, customer, tenant, customer),
                )
            ).fetchall()
            for row in rows:
                request_id = row["request_id"]
                await connection.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s,73))",
                    (str(tenant) + str(request_id),),
                )
                await connection.execute(
                    "INSERT INTO assistant.deleted_requests VALUES(%s,%s) ON CONFLICT DO NOTHING",
                    (tenant, request_id),
                )
                await connection.execute(
                    "DELETE FROM assistant.metrics WHERE tenant_id=%s AND request_id=%s",
                    (tenant, request_id),
                )
                await connection.execute(
                    "DELETE FROM assistant.tracking_reports WHERE tenant_id=%s AND request_id=%s",
                    (tenant, request_id),
                )
            await connection.execute(
                "DELETE FROM assistant.conversations WHERE tenant_id=%s AND customer_id=%s",
                (tenant, customer),
            )
            await connection.execute(
                "DELETE FROM assistant.customer_requests WHERE tenant_id=%s AND customer_id=%s",
                (tenant, customer),
            )

    async def open(self) -> None:
        await self.pool.open()

    async def close(self) -> None:
        await self.pool.close()

    async def ready(self) -> bool:
        # Inspect metadata without reading tenant data or changing RLS context.
        # Migration 008 must be complete before this runtime accepts traffic.
        async with self.pool.connection() as connection:
            row = await (
                await connection.execute(
                    "SELECT to_regclass('assistant.deployment') IS NOT NULL "
                    "AND to_regclass('assistant.request_revisions') IS NOT NULL "
                    "AND (SELECT count(*) FROM information_schema.columns WHERE table_schema='assistant' "
                    "AND table_name='request_revisions' AND column_name IN ('shopping_state','shopping_store_id',"
                    "'shopping_session_id','shopping_active_state','shopping_active_store_id',"
                    "'shopping_active_session_id','shopping_active_expires_at'))=7 "
                    "AND to_regclass('assistant.compound_plans') IS NOT NULL "
                    "AND EXISTS (SELECT 1 FROM pg_catalog.pg_class AS tracking "
                    "WHERE tracking.oid=to_regclass('assistant.tracking_reports') "
                    "AND tracking.relkind='r' "
                    "AND tracking.relrowsecurity AND tracking.relforcerowsecurity "
                    "AND has_table_privilege(current_user,tracking.oid,'SELECT') "
                    "AND has_table_privilege(current_user,tracking.oid,'INSERT') "
                    "AND has_table_privilege(current_user,tracking.oid,'DELETE')) AS ready"
                )
            ).fetchone()
            return bool(row and row["ready"])

    async def save(
        self,
        tenant: UUID,
        customer: UUID,
        conversation: UUID,
        request: UUID,
        question: str,
        answer: str,
        blocks: list[dict[str, Any]] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        history_metadata = message_metadata(metadata)
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant', %s, true),set_config('assistant.customer',%s,true)",
                (str(tenant), str(customer)),
            )
            await connection.execute(
                "INSERT INTO assistant.conversations(tenant_id,customer_id,id) VALUES(%s,%s,%s) ON CONFLICT DO NOTHING",
                (tenant, customer, conversation),
            )
            # Lock the conversation to enforce a bounded turn count across concurrent streams.
            await connection.execute(
                "SELECT id FROM assistant.conversations WHERE tenant_id=%s AND customer_id=%s AND id=%s FOR UPDATE",
                (tenant, customer, conversation),
            )
            row = await (
                await connection.execute(
                    "SELECT count(*) AS n FROM assistant.turns WHERE tenant_id=%s AND customer_id=%s AND conversation_id=%s",
                    (tenant, customer, conversation),
                )
            ).fetchone()
            existing = await (
                await connection.execute(
                    "SELECT conversation_id FROM assistant.turns WHERE tenant_id=%s AND customer_id=%s AND request_id=%s",
                    (tenant, customer, request),
                )
            ).fetchone()
            if existing:
                if existing["conversation_id"] != conversation:
                    raise ValueError("Request belongs to another conversation")
                if await self._compound_history_matches(
                    connection,
                    CompoundScope(
                        tenant_id=tenant,
                        customer_id=customer,
                        conversation_id=conversation,
                    ),
                    request,
                    metadata or {},
                ):
                    await connection.execute(
                        "UPDATE assistant.turns SET answer=%s WHERE tenant_id=%s AND customer_id=%s AND request_id=%s",
                        (redact(answer)[:8000], tenant, customer, request),
                    )
                    await connection.execute(
                        "UPDATE assistant.messages SET text=%s,blocks=%s,metadata=%s "
                        "WHERE tenant_id=%s AND customer_id=%s AND request_id=%s AND role='assistant'",
                        (
                            redact(answer)[:8000],
                            Jsonb(scrub(blocks or [])),
                            Jsonb(history_metadata),
                            tenant,
                            customer,
                            request,
                        ),
                    )
                return
            if row and row["n"] >= 30:
                raise ValueError("Conversation limit reached")
            await connection.execute(
                "INSERT INTO assistant.turns(tenant_id,customer_id,conversation_id,request_id,question,answer) VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                (
                    tenant,
                    customer,
                    conversation,
                    request,
                    redact(question)[:4000],
                    redact(answer)[:8000],
                ),
            )
            for role, content, rich in (
                ("user", question, []),
                ("assistant", answer, blocks or []),
            ):
                await connection.execute(
                    "INSERT INTO assistant.messages(tenant_id,customer_id,request_id,role,text,blocks,metadata) VALUES(%s,%s,%s,%s,%s,%s,%s)",
                    (
                        tenant,
                        customer,
                        request,
                        role,
                        redact(content)[:8000],
                        Jsonb(scrub(rich)),
                        Jsonb(history_metadata),
                    ),
                )
            await connection.execute(
                "DELETE FROM assistant.conversations WHERE tenant_id=%s AND customer_id=%s AND created_at < now()-interval '30 days'",
                (tenant, customer),
            )

    async def history(
        self, tenant: UUID, customer: UUID, conversation: UUID | None = None
    ) -> list[dict[str, Any]]:
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true),set_config('assistant.customer',%s,true)",
                (str(tenant), str(customer)),
            )
            if conversation:
                query = "SELECT t.conversation_id,t.request_id,t.question,t.answer,t.created_at,coalesce(m.blocks,'[]') AS blocks,m.helpful,CASE WHEN m.metadata->>'response_source' IN ('R','L') THEN m.metadata->>'response_source' WHEN m.metadata ? 'model_calls' THEN CASE WHEN (m.metadata->>'model_calls')::int > 0 THEN 'L' ELSE 'R' END ELSE NULL END AS response_source FROM assistant.turns t LEFT JOIN assistant.messages m ON m.tenant_id=t.tenant_id AND m.customer_id=t.customer_id AND m.request_id=t.request_id AND m.role='assistant' WHERE t.tenant_id=%s AND t.customer_id=%s AND t.conversation_id=%s AND t.created_at>now()-interval '30 days' ORDER BY t.created_at DESC,t.request_id DESC LIMIT 30"
                cursor = await connection.execute(
                    query, (tenant, customer, conversation)
                )
            else:
                cursor = await connection.execute(
                    "SELECT * FROM (SELECT DISTINCT ON (conversation_id) conversation_id,request_id,question,answer,created_at FROM assistant.turns WHERE tenant_id=%s AND customer_id=%s AND created_at>now()-interval '30 days' ORDER BY conversation_id,created_at DESC,request_id DESC) recent ORDER BY created_at DESC LIMIT 20",
                    (tenant, customer),
                )
            return list(await cursor.fetchall())

    async def metric(
        self,
        tenant: UUID,
        request: UUID,
        outcome: str,
        latency_ms: int,
        metadata: dict[str, Any] | None = None,
        conversation: UUID | None = None,
        customer: UUID | None = None,
    ) -> None:
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true)", (str(tenant),)
            )
            helpful = None
            compound_completion = None
            if customer:
                await connection.execute(
                    "SELECT set_config('assistant.customer',%s,true)", (str(customer),)
                )
                feedback = await (
                    await connection.execute(
                        "SELECT helpful,metadata FROM assistant.messages WHERE tenant_id=%s AND customer_id=%s AND request_id=%s AND role='assistant' FOR UPDATE",
                        (tenant, customer, request),
                    )
                ).fetchone()
                helpful = feedback["helpful"] if feedback else None
                saved_metadata = feedback["metadata"] if feedback else {}
                if (
                    saved_metadata.get("compound_plan_id")
                    and saved_metadata.get("compound_action_states")
                    and all(
                        state in {"succeeded", "failed", "not_started", "superseded"}
                        for state in saved_metadata["compound_action_states"]
                    )
                    and isinstance(saved_metadata.get("completion"), dict)
                ):
                    # Use the locked saved answer, not a late duplicate's trace.
                    # Preserve original latency, usage and costs on metric replay.
                    compound_completion = saved_metadata["completion"]
            await connection.execute(
                "INSERT INTO assistant.metrics(tenant_id,request_id,outcome,latency_ms,metadata,conversation_id,helpful) VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                (
                    tenant,
                    request,
                    outcome,
                    min(latency_ms, 60000),
                    Jsonb(metadata or {}),
                    conversation,
                    helpful,
                ),
            )
            if compound_completion is not None:
                await connection.execute(
                    "UPDATE assistant.metrics SET metadata=jsonb_set(metadata,'{completion}',%s) "
                    "WHERE tenant_id=%s AND request_id=%s",
                    (Jsonb(compound_completion), tenant, request),
                )
            await connection.execute(
                "DELETE FROM assistant.metrics WHERE tenant_id=%s AND created_at<now()-interval '90 days'",
                (tenant,),
            )

    async def model_budget_available(
        self,
        tenant: UUID,
        conversation: UUID | None,
        daily_limit: int,
        session_limit: int,
    ) -> bool:
        """Check configured token caps using aggregate metadata, never prompt content."""
        if not daily_limit and not (session_limit and conversation):
            return True
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true)", (str(tenant),)
            )
            if daily_limit:
                daily = await (
                    await connection.execute(
                        "SELECT coalesce(sum(coalesce((metadata->>'input_tokens')::bigint,0)+coalesce((metadata->>'output_tokens')::bigint,0)),0)::bigint AS tokens FROM assistant.metrics WHERE tenant_id=%s AND created_at>now()-interval '24 hours'",
                        (tenant,),
                    )
                ).fetchone()
                if daily and int(daily["tokens"]) >= daily_limit:
                    return False
            if session_limit and conversation:
                session = await (
                    await connection.execute(
                        "SELECT coalesce(sum(coalesce((metadata->>'input_tokens')::bigint,0)+coalesce((metadata->>'output_tokens')::bigint,0)),0)::bigint AS tokens FROM assistant.metrics WHERE tenant_id=%s AND conversation_id=%s AND created_at>now()-interval '30 days'",
                        (tenant, conversation),
                    )
                ).fetchone()
                if session and int(session["tokens"]) >= session_limit:
                    return False
        return True

    async def purge(self, tenant: UUID) -> None:
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true)", (str(tenant),)
            )
            await connection.execute("SELECT assistant.purge_expired(%s)", (tenant,))

    async def metrics(self, tenant: UUID) -> list[dict[str, Any]]:
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true)", (str(tenant),)
            )
            cursor = await connection.execute(
                "SELECT request_id,outcome,latency_ms,created_at FROM assistant.metrics WHERE tenant_id=%s AND exported_at IS NULL ORDER BY created_at LIMIT 256",
                (tenant,),
            )
            return list(await cursor.fetchall())

    async def acknowledge_metrics(self, tenant: UUID, ids: list[UUID]) -> None:
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true)", (str(tenant),)
            )
            await connection.execute(
                "UPDATE assistant.metrics SET exported_at=now() WHERE tenant_id=%s AND request_id=ANY(%s)",
                (tenant, ids),
            )

    async def context(
        self, tenant: UUID, customer: UUID, conversation: UUID
    ) -> list[dict[str, Any]]:
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true),set_config('assistant.customer',%s,true)",
                (str(tenant), str(customer)),
            )
            selected = await (
                await connection.execute(
                    "SELECT question,answer FROM assistant.turns WHERE tenant_id=%s AND customer_id=%s AND conversation_id=%s AND created_at>now()-interval '30 days' ORDER BY created_at DESC,request_id DESC LIMIT 3",
                    (tenant, customer, conversation),
                )
            ).fetchall()
        # At most six messages / 6000 characters, never raw tools or old price cards.
        return [
            {"role": role, "text": str(row[key])[:1000]}
            for row in reversed(selected)
            for role, key in (("user", "question"), ("assistant", "answer"))
        ]

    async def feedback(
        self, tenant: UUID, customer: UUID, request: UUID, helpful: bool
    ) -> bool:
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true),set_config('assistant.customer',%s,true)",
                (str(tenant), str(customer)),
            )
            row = await (
                await connection.execute(
                    "UPDATE assistant.messages m SET helpful=%s FROM assistant.turns t WHERE m.tenant_id=%s AND m.customer_id=%s AND m.request_id=%s AND m.role='assistant' AND t.tenant_id=m.tenant_id AND t.customer_id=m.customer_id AND t.request_id=m.request_id AND t.created_at>now()-interval '30 days' RETURNING m.request_id",
                    (helpful, tenant, customer, request),
                )
            ).fetchone()
            if not row:
                return False
            await connection.execute(
                "UPDATE assistant.metrics SET helpful=%s WHERE tenant_id=%s AND request_id=%s",
                (helpful, tenant, request),
            )
            return True

    async def completion_context(
        self,
        tenant: UUID,
        customer: UUID,
        conversation: UUID,
        *,
        expected_question: str | None = None,
    ) -> dict[str, object] | None:
        """Read only the newest turn's bounded recovery metadata, never its text.

        Compare the original question inside the owner-scoped query. Do not search
        backwards for a matching old request or treat redacted/truncated questions
        as exact matches. This metadata is observational and grants no authority.
        """
        exact_question = (
            expected_question
            if isinstance(expected_question, str)
            and 0 < len(expected_question) <= 4000
            and redact(expected_question) == expected_question
            else None
        )
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true),set_config('assistant.customer',%s,true)",
                (str(tenant), str(customer)),
            )
            row = await (
                await connection.execute(
                    """
                    SELECT t.request_id,
                           coalesce(t.question=%s,false) AS matches_original,
                           coalesce(metric.metadata->'completion',m.metadata->'completion') AS completion
                    FROM assistant.turns t
                    LEFT JOIN assistant.messages m
                      ON m.tenant_id=t.tenant_id AND m.customer_id=t.customer_id
                     AND m.request_id=t.request_id AND m.role='assistant'
                    LEFT JOIN assistant.metrics metric
                      ON metric.tenant_id=t.tenant_id AND metric.request_id=t.request_id
                    WHERE t.tenant_id=%s AND t.customer_id=%s AND t.conversation_id=%s
                      AND t.created_at>now()-interval '15 minutes'
                    ORDER BY t.created_at DESC,t.request_id DESC LIMIT 1
                    """,
                    (exact_question, tenant, customer, conversation),
                )
            ).fetchone()
        if not row:
            return None
        return bounded_completion_context(
            row.get("completion"),
            request_id=row.get("request_id"),
            matches_original=row.get("matches_original") is True,
        )

    async def completion_insights(self, tenant: UUID) -> dict[str, int]:
        """Operator-only 24-hour task counters; the public usage DTO is unchanged.

        Historical turns without versioned evidence remain explicitly unmeasured.
        A conversation with a completion is not necessarily a finished shopping
        journey. Unanswered clarifications are not inferred to be abandonment.
        """
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true)", (str(tenant),)
            )
            row = await (
                await connection.execute(
                    """
                    WITH measured AS (
                      SELECT conversation_id,outcome,
                             CASE WHEN metadata#>>'{completion,version}'='1'
                                  THEN metadata->'completion' END AS completion
                      FROM assistant.metrics
                      WHERE tenant_id=%s AND created_at>now()-interval '24 hours'
                    )
                    SELECT count(*) AS turns,
                           count(completion) AS measured_turns,
                           count(*) FILTER (WHERE completion IS NULL) AS unmeasured_turns,
                           count(*) FILTER (WHERE outcome='completed') AS requests_completed,
                           count(*) FILTER (WHERE completion->>'model_attempted'='false') AS deterministic_attempted,
                           count(*) FILTER (WHERE completion->>'model_attempted'='true') AS model_attempted,
                           count(*) FILTER (WHERE completion->>'status'='completed') AS tasks_completed,
                           count(*) FILTER (WHERE completion->>'status'='completed' AND completion->>'mode'='deterministic') AS deterministic_completed,
                           count(*) FILTER (WHERE completion->>'status'='completed' AND completion->>'mode'='model_assisted') AS model_assisted_completed,
                           count(*) FILTER (WHERE completion->>'status'='clarification') AS clarification,
                           count(*) FILTER (WHERE completion->>'status'='handoff') AS handoff,
                           count(*) FILTER (WHERE completion->>'status'='unsupported') AS unsupported,
                           count(*) FILTER (WHERE completion->>'status'='unavailable') AS unavailable,
                           count(*) FILTER (WHERE completion->>'status'='denied') AS denied,
                           count(*) FILTER (WHERE completion->>'status'='disconnected') AS disconnected,
                           count(*) FILTER (WHERE completion->>'status'='unverified') AS unverified,
                           count(*) FILTER (WHERE completion->>'clarification_reply'='true') AS clarification_replies,
                           count(*) FILTER (WHERE completion->>'clarification_recovered'='true') AS clarification_recovered,
                           count(*) FILTER (WHERE completion->>'clarification_reply'='true' AND completion->>'status'!='completed') AS clarification_not_completed,
                           count(DISTINCT conversation_id) FILTER (WHERE completion->>'status'='completed') AS conversations_with_completion
                    FROM measured
                    """,
                    (tenant,),
                )
            ).fetchone()
        return {key: int(value or 0) for key, value in (row or {}).items()}

    async def insights(self, tenant: UUID) -> dict[str, Any]:
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true)", (str(tenant),)
            )
            # Internal language routing is operational telemetry, not provider usage.
            # Keep it in conversation/outcome/tool metrics while excluding historical
            # pseudo-model rows from token totals, spend and pricing coverage.
            # Coalescing NULL retains unattributed/unknown provider usage.
            row = await (
                await connection.execute(
                    """
                    WITH recent AS (
                        SELECT *, coalesce(metadata->>'model','') <> ALL(%s) AS provider_usage
                        FROM assistant.metrics
                        WHERE tenant_id=%s AND created_at>now()-interval '24 hours'
                    )
                    SELECT count(*) AS turns,
                           count(DISTINCT conversation_id) AS conversations,
                           count(*) FILTER (WHERE outcome!='completed') AS errors,
                           coalesce(avg(latency_ms),0)::float AS latency_ms,
                           count(*) FILTER (WHERE helpful=true) AS helpful,
                           count(*) FILTER (WHERE helpful=false) AS not_helpful,
                           coalesce(sum((metadata->>'input_tokens')::bigint) FILTER (WHERE provider_usage),0)::bigint AS input_tokens,
                           coalesce(sum((metadata->>'output_tokens')::bigint) FILTER (WHERE provider_usage),0)::bigint AS output_tokens,
                           coalesce(sum((metadata->>'estimated_cost_micros')::bigint) FILTER (WHERE provider_usage),0)::bigint AS estimated_cost_micros,
                           coalesce(sum((metadata->>'model_calls')::bigint) FILTER (WHERE provider_usage),0)::bigint AS model_calls,
                           coalesce(sum((metadata->>'tool_calls')::bigint),0)::bigint AS tool_calls,
                           coalesce(sum((metadata->>'retrieval_count')::bigint),0)::bigint AS retrieval_count,
                           count(*) FILTER (WHERE provider_usage AND metadata ? 'input_tokens') AS usage_recorded,
                           count(*) FILTER (WHERE provider_usage AND metadata ? 'estimated_cost_micros') AS cost_recorded
                    FROM recent
                    """,
                    (list(INTERNAL_MODEL_NAMES), tenant),
                )
            ).fetchone()
            result = dict(row or {})
            models = await (
                await connection.execute(
                    """
                    SELECT left(coalesce(nullif(btrim(metadata->>'provider'),''),'unknown'),100) AS provider,
                           left(coalesce(nullif(btrim(metadata->>'model'),''),'unknown'),100) AS model,
                           coalesce(sum((metadata->>'input_tokens')::bigint),0)::bigint AS input_tokens,
                           coalesce(sum((metadata->>'output_tokens')::bigint),0)::bigint AS output_tokens,
                           count(*) AS turns
                    FROM assistant.metrics
                    WHERE tenant_id=%s AND created_at>now()-interval '24 hours'
                      AND metadata ? 'input_tokens'
                      AND coalesce(metadata->>'model','') <> ALL(%s)
                    GROUP BY 1,2 ORDER BY count(*) DESC LIMIT 10
                    """,
                    (tenant, list(INTERNAL_MODEL_NAMES)),
                )
            ).fetchall()
            result["models"] = list(models)
            routes = await (
                await connection.execute(
                    "SELECT left(coalesce(metadata->>'route_reason','unknown'),100) AS route,count(*) AS turns FROM assistant.metrics WHERE tenant_id=%s AND created_at>now()-interval '24 hours' GROUP BY 1 ORDER BY count(*) DESC LIMIT 10",
                    (tenant,),
                )
            ).fetchall()
            result["routes"] = list(routes)
            return result
