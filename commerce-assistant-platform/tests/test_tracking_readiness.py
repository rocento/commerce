"""Fail readiness when tracking storage or its runtime access is incomplete."""

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import psycopg
import pytest
from psycopg.rows import dict_row

from app.commerce_action_engine.platform.store import Store


def store_with_connection(connection):
    @asynccontextmanager
    async def connected():
        yield connection

    store = object.__new__(Store)
    store.pool = SimpleNamespace(connection=connected)
    return store


@pytest.mark.parametrize(
    "row,expected", [({"ready": True}, True), ({"ready": False}, False), (None, False)]
)
def test_ready_uses_database_readiness_result(row, expected):
    cursor = SimpleNamespace(fetchone=AsyncMock(return_value=row))
    connection = SimpleNamespace(execute=AsyncMock(return_value=cursor))
    assert asyncio.run(store_with_connection(connection).ready()) is expected
    connection.execute.assert_awaited_once()
    cursor.fetchone.assert_awaited_once()


def test_ready_checks_all_tracking_privileges_and_rls_without_tenant_data():
    cursor = SimpleNamespace(fetchone=AsyncMock(return_value={"ready": True}))
    connection = SimpleNamespace(execute=AsyncMock(return_value=cursor))
    assert asyncio.run(store_with_connection(connection).ready())
    query = connection.execute.await_args.args[0]
    for table in (
        "deployment",
        "request_revisions",
        "compound_plans",
        "tracking_reports",
    ):
        assert f"to_regclass('assistant.{table}')" in query
    assert "tracking.relrowsecurity AND tracking.relforcerowsecurity" in query
    for privilege in ("SELECT", "INSERT", "DELETE"):
        # PostgreSQL's comma-separated privilege argument means ANY privilege;
        # readiness must require each one individually with AND.
        assert (
            f"AND has_table_privilege(current_user,tracking.oid,'{privilege}')" in query
        )
    assert "FROM pg_catalog.pg_class" in query
    assert "FROM assistant." not in query
    assert "set_config" not in query and "current_setting" not in query


def test_readiness_database_failure_propagates_to_endpoint_dependency_boundary():
    connection = SimpleNamespace(
        execute=AsyncMock(side_effect=psycopg.OperationalError("unavailable"))
    )
    with pytest.raises(psycopg.OperationalError):
        asyncio.run(store_with_connection(connection).ready())


@pytest.mark.skipif(
    not os.getenv("COMPLETION_TEST_ADMIN_DSN"),
    reason="isolated PostgreSQL admin test DSN required",
)
@pytest.mark.parametrize(
    "incomplete",
    [
        None,
        "ALTER TABLE assistant.tracking_reports RENAME TO tracking_reports_readiness_missing",
        "ALTER TABLE assistant.tracking_reports DISABLE ROW LEVEL SECURITY",
        "ALTER TABLE assistant.tracking_reports NO FORCE ROW LEVEL SECURITY",
        "REVOKE SELECT ON assistant.tracking_reports FROM ai_runtime",
        "REVOKE INSERT ON assistant.tracking_reports FROM ai_runtime",
        "REVOKE DELETE ON assistant.tracking_reports FROM ai_runtime",
    ],
)
def test_postgres_readiness_rejects_incomplete_tracking_migration(incomplete):
    async def scenario():
        # Test DDL and grants remain in one transaction and always roll back.
        # SET LOCAL ROLE makes current_user match the actual runtime without
        # requiring credentials or any report/customer rows.
        connection = await psycopg.AsyncConnection.connect(
            os.environ["COMPLETION_TEST_ADMIN_DSN"], row_factory=dict_row
        )
        try:
            migration = (
                Path(__file__).parents[1] / "migrations/008_assistant_tracking.sql"
            ).read_text()
            await connection.execute(migration)
            await connection.execute(
                (
                    Path(__file__).parents[1]
                    / "migrations/009_shopping_clarifications.sql"
                ).read_text()
            )
            if incomplete:
                await connection.execute(incomplete)
            await connection.execute("SET LOCAL ROLE ai_runtime")
            assert await store_with_connection(connection).ready() is (
                incomplete is None
            )
        finally:
            await connection.rollback()
            await connection.close()

    asyncio.run(scenario())
