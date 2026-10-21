"""Completion queries retain tenant ownership and newest-turn binding."""

import asyncio
from contextlib import asynccontextmanager
from uuid import UUID

from app.commerce_action_engine.platform.store import Store


class Connection:
    def __init__(self, row):
        self.row, self.calls = row, []

    @asynccontextmanager
    async def transaction(self):
        yield self

    async def execute(self, sql, params):
        self.calls.append((sql, params))
        return self

    async def fetchone(self):
        return self.row


class Pool:
    def __init__(self, connection):
        self.current = connection

    @asynccontextmanager
    async def connection(self):
        yield self.current


def store_for(row):
    store = object.__new__(Store)
    connection = Connection(row)
    store.pool = Pool(connection)
    return store, connection


def test_recovery_context_binds_owner_latest_turn_and_original_question():
    tenant, customer, conversation, request = [UUID(int=i) for i in range(1, 5)]
    store, connection = store_for(
        {
            "request_id": request,
            "matches_original": True,
            "completion": {
                "version": 1,
                "status": "clarification",
                "mode": "deterministic",
                "intent": "PRODUCT_SEARCH",
            },
        }
    )
    context = asyncio.run(
        store.completion_context(
            tenant, customer, conversation, expected_question="find rings under 100"
        )
    )
    assert context["matches_original"] is True
    sql, params = connection.calls[-1]
    assert params == ("find rings under 100", tenant, customer, conversation)
    assert (
        "t.customer_id=%s" in sql
        and "t.tenant_id=%s" in sql
        and "t.conversation_id=%s" in sql
    )
    assert "interval '15 minutes'" in sql and "LIMIT 1" in sql
    assert "find rings under 100" not in repr(context)


def test_missing_history_cannot_create_recovery_credit():
    store, _connection = store_for(None)
    assert (
        asyncio.run(store.completion_context(UUID(int=1), UUID(int=2), UUID(int=3)))
        is None
    )


def test_aggregates_keep_unmeasured_and_unverified_counts():
    store, connection = store_for(
        {
            "turns": 4,
            "measured_turns": 3,
            "unmeasured_turns": 1,
            "tasks_completed": 1,
            "unverified": 2,
        }
    )
    result = asyncio.run(store.completion_insights(UUID(int=1)))
    assert result["tasks_completed"] == 1 and result["unmeasured_turns"] == 1
    sql, params = connection.calls[-1]
    assert params == (UUID(int=1),)
    assert "WHERE tenant_id=%s" in sql and "clarification_recovered" in sql
