"""Tenant-isolated, seven-day operator reports with bounded keyset pagination."""

import json
import re
from collections.abc import Callable
from datetime import datetime
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

_SECRET_KEYS = frozenset(
    {
        "api_key",
        "authorization",
        "password",
        "secret",
        "access_token",
        "refresh_token",
        "cookie",
        "client_secret",
    }
)
_TOKEN = re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")


def redact_tracking(value: Any, key: str = "") -> Any:
    from .store import redact

    # A report repeats many strings (source, identifiers, schema field values).
    # Memoization is local to this call: no customer text survives in a cache.
    return _redact_tracking(value, key, {}, redact)


def _redact_tracking(
    item: Any, field: str, strings: dict[str, str], redact: Callable[[str], str]
) -> Any:
    if field.casefold() in _SECRET_KEYS:
        return "[redacted]"
    if isinstance(item, dict):
        return {k: _redact_tracking(v, k, strings, redact) for k, v in item.items()}
    if isinstance(item, list):
        return [_redact_tracking(v, field, strings, redact) for v in item]
    if not isinstance(item, str):
        return item
    if item in strings:
        return strings[item]
    # Preserve UUID references; their digit groups are not phone numbers.
    try:
        UUID(item)
        result = item
    except ValueError:
        result = redact(item)
        if "eyJ" in result:
            result = _TOKEN.sub("[token redacted]", result)
    strings[item] = result
    return result


class TrackingStore:
    pool: AsyncConnectionPool[AsyncConnection[dict[str, Any]]]

    async def save_tracking(
        self, tenant: UUID, request: UUID, document: dict[str, Any]
    ) -> None:
        if document.get("request_id") != str(request):
            raise ValueError("tracking_request_mismatch")
        report = redact_tracking(document)
        report["request_id"] = str(request)
        report["redacted"] = True
        if len(json.dumps(report, ensure_ascii=False).encode()) > 1_400_000:
            raise ValueError("tracking_report_limit")
        question = next(
            (
                e.get("data", {}).get("message", "")
                for e in report["events"]
                if e.get("stage") == "customer_request"
            ),
            "",
        )
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true)", (str(tenant),)
            )
            await connection.execute(
                "INSERT INTO assistant.tracking_reports(tenant_id,request_id,question_preview,report) "
                "VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                (tenant, request, str(question)[:500], Jsonb(report)),
            )
            await connection.execute(
                "DELETE FROM assistant.tracking_reports WHERE tenant_id=%s AND created_at<now()-interval '7 days'",
                (tenant,),
            )

    async def tracking_list(
        self,
        tenant: UUID,
        *,
        limit: int,
        hours: int,
        outcome: str | None,
        request_id: UUID | None,
        before: datetime | None,
        before_id: UUID | None,
    ) -> list[dict[str, Any]]:
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true)", (str(tenant),)
            )
            return await (
                await connection.execute(
                    "SELECT m.request_id,m.created_at,m.outcome,m.latency_ms,m.conversation_id,"
                    "coalesce(m.metadata->>'route_reason','unknown') AS route,"
                    "m.metadata#>>'{language_gate,intent}' AS intent,"
                    "m.metadata->>'model' AS model,"
                    "coalesce((m.metadata->>'model_calls')::int,0) AS model_calls,"
                    "coalesce((m.metadata->>'input_tokens')::bigint,0) AS input_tokens,"
                    "coalesce((m.metadata->>'output_tokens')::bigint,0) AS output_tokens,"
                    "r.question_preview,(r.request_id IS NOT NULL) AS report_available "
                    "FROM assistant.metrics m LEFT JOIN assistant.tracking_reports r "
                    "ON r.tenant_id=m.tenant_id AND r.request_id=m.request_id AND r.created_at>now()-interval '7 days' "
                    "WHERE m.tenant_id=%s AND m.created_at>now()-(%s*interval '1 hour') "
                    "AND (%s::text IS NULL OR m.outcome=%s) AND (%s::uuid IS NULL OR m.request_id=%s) "
                    "AND (%s::timestamptz IS NULL OR (m.created_at,m.request_id)<(%s,%s::uuid)) "
                    "ORDER BY m.created_at DESC,m.request_id DESC LIMIT %s",
                    (
                        tenant,
                        hours,
                        outcome,
                        outcome,
                        request_id,
                        request_id,
                        before,
                        before,
                        before_id,
                        limit,
                    ),
                )
            ).fetchall()

    async def tracking_report(
        self, tenant: UUID, request: UUID
    ) -> dict[str, Any] | None:
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true)", (str(tenant),)
            )
            row = await (
                await connection.execute(
                    "SELECT report FROM assistant.tracking_reports WHERE tenant_id=%s AND request_id=%s "
                    "AND created_at>now()-interval '7 days'",
                    (tenant, request),
                )
            ).fetchone()
            return row["report"] if row else None
