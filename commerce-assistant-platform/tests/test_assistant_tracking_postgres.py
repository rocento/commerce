"""Opt-in disposable PostgreSQL checks; use the existing completion test DB setup."""

import asyncio
import os
from pathlib import Path
from uuid import uuid4

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


@pytest.mark.parametrize("capture_version", [1, 2])
def test_tracking_rls_retention_and_pagination(capture_version, monkeypatch):
    monkeypatch.delenv("AI_INTENT_DEBUG_DIR", raising=False)

    async def scenario():
        migration = (
            Path(__file__).parents[1] / "migrations/008_assistant_tracking.sql"
        ).read_text()
        async with await psycopg.AsyncConnection.connect(
            ADMIN_DSN, row_factory=dict_row
        ) as admin:
            await admin.execute(migration)
            await admin.execute(migration)
            tenant = (
                await (
                    await admin.execute(
                        "SELECT tenant_id FROM assistant.deployment WHERE singleton"
                    )
                ).fetchone()
            )["tenant_id"]
        store = object.__new__(Store)
        store.pool = AsyncConnectionPool(
            DSN, open=False, kwargs={"row_factory": dict_row}
        )
        await store.open()
        request_ids = [uuid4(), uuid4(), uuid4()]
        other = uuid4()
        try:
            for request in request_ids:
                if capture_version == 2:
                    from app.commerce_resolution_engine.diagnostics import (
                        begin_debug,
                        debug_record,
                        finish_debug,
                    )

                    token = begin_debug(
                        str(request), "I want dinner test@example.com", enabled=True
                    )
                    from app.commerce_resolution_engine.boundaries import (
                        REQUEST_HEADER,
                        RESPONSE_HEADER,
                        boundary,
                        gateway_dispatch,
                    )

                    gateway_dispatch(f"1/{request}/{uuid4()}")
                    with boundary("language-engine", "resolve") as call:
                        call.received(
                            {
                                RESPONSE_HEADER: f"{call.headers[REQUEST_HEADER]}/{uuid4()}/2.5"
                            },
                            200,
                        )
                    debug_record(
                        "final_result",
                        {
                            "outcome": "completed",
                            "completion": {"version": 1, "status": "unverified"},
                            "measurements": {"version": 1, "request_duration_ms": 12},
                        },
                    )
                    document = finish_debug(token)
                else:
                    document = {
                        "version": 1,
                        "request_id": str(request),
                        "truncated": False,
                        "events": [
                            {
                                "stage": "customer_request",
                                "data": {"message": "I want dinner test@example.com"},
                            }
                        ],
                    }
                await store.save_tracking(
                    tenant,
                    request,
                    document,
                )
            report = await store.tracking_report(tenant, request_ids[0])
            assert report["redacted"] and "test@example.com" not in str(report)
            assert report["version"] == capture_version
            if capture_version == 2:
                remote = next(
                    e["data"]["_journey"]
                    for e in report["events"]
                    if e["stage"] == "service_span"
                    and e["data"]["_journey"]["service"] == "language-engine"
                )
                assert remote["clockId"] == remote["spanId"]
                assert remote["parentService"] == "assistant-python"
                assert remote["durationMs"] == 2.5
                assert (
                    report["events"][-1]["data"]["measurements"]["request_duration_ms"]
                    == 12
                )
                assert report["events"][-1]["data"]["_journey"]["traceId"] == str(
                    request_ids[0]
                )
            assert await store.tracking_report(other, request_ids[0]) is None
            foreign = uuid4()
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                await store.save_tracking(
                    other, foreign, {"request_id": str(foreign), "events": []}
                )
            async with await psycopg.AsyncConnection.connect(ADMIN_DSN) as admin:
                for request in request_ids:
                    await admin.execute(
                        "INSERT INTO assistant.metrics(tenant_id,request_id,outcome,latency_ms,metadata) VALUES(%s,%s,'completed',10,'{}')",
                        (tenant, request),
                    )
                await admin.execute(
                    "UPDATE assistant.tracking_reports SET created_at=now()-interval '8 days' WHERE tenant_id=%s AND request_id=%s",
                    (tenant, request_ids[0]),
                )
            assert await store.tracking_report(tenant, request_ids[0]) is None
            params = {
                "limit": 50,
                "hours": 24,
                "outcome": "completed",
                "request_id": None,
                "before": None,
                "before_id": None,
            }
            rows = await store.tracking_list(tenant, **params)
            mine = [row for row in rows if row["request_id"] in request_ids]
            assert len(mine) == 3
            assert not next(row for row in mine if row["request_id"] == request_ids[0])[
                "report_available"
            ]
            params.update(before=mine[0]["created_at"], before_id=mine[0]["request_id"])
            subsequent = await store.tracking_list(tenant, **params)
            assert mine[0]["request_id"] not in {
                row["request_id"] for row in subsequent
            }
            assert (
                await store.tracking_list(
                    other, **{**params, "before": None, "before_id": None}
                )
                == []
            )
        finally:
            async with await psycopg.AsyncConnection.connect(ADMIN_DSN) as admin:
                await admin.execute(
                    "DELETE FROM assistant.metrics WHERE tenant_id=%s AND request_id=ANY(%s)",
                    (tenant, request_ids),
                )
                await admin.execute(
                    "DELETE FROM assistant.tracking_reports WHERE tenant_id=%s AND request_id=ANY(%s)",
                    (tenant, request_ids),
                )
            await store.close()

    asyncio.run(scenario())
