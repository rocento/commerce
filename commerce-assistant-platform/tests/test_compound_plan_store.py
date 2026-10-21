"""Durable identity, scope, CAS publication and locked state transitions."""

import asyncio
from uuid import uuid4

import pytest
from test_completion_store import Connection, Pool
from test_compound_planning import prepared, receipt

from app.commerce_action_engine.platform.store import Store


class ScriptedConnection(Connection):
    def __init__(self, rows):
        super().__init__(None)
        self.rows = list(rows)

    async def fetchone(self):
        return self.rows.pop(0)


def store_for(*rows):
    store = object.__new__(Store)
    connection = ScriptedConnection(rows)
    store.pool = Pool(connection)
    return store, connection


def row(plan, revision=None):
    return {
        "payload": plan.model_dump(mode="json"),
        "active_revision": revision or plan.revision,
    }


def test_persist_full_plan_only_for_current_scope_revision():
    plan = prepared()
    store, connection = store_for(None, {"revision": plan.revision})
    assert asyncio.run(store.save_compound_plan(plan)) == plan
    lock = connection.calls[1]
    assert "FOR UPDATE" in lock[0]
    assert lock[1] == (
        plan.scope.tenant_id,
        plan.scope.customer_id,
        plan.scope.conversation_id,
    )
    sql, args = connection.calls[-1]
    assert "INSERT INTO assistant.compound_plans" in sql and args[4] == plan.id
    assert args[-1].obj == plan.model_dump(mode="json")
    store, connection = store_for(None, {"revision": uuid4()})
    assert asyncio.run(store.save_compound_plan(plan)) is None
    assert not any(
        "INSERT INTO assistant.compound_plans" in sql for sql, _ in connection.calls
    )


def test_request_replay_recovers_same_ids_and_different_input_rejected():
    plan = prepared()
    store, connection = store_for(row(plan))
    assert (
        asyncio.run(
            store.get_compound_plan(plan.scope, plan.request_id, plan.input_hash)
        )
        == plan
    )
    sql, params = connection.calls[-1]
    assert (
        "p.tenant_id=%s" in sql
        and "p.customer_id=%s" in sql
        and "p.conversation_id=%s" in sql
    )
    assert params == (
        plan.scope.tenant_id,
        plan.scope.customer_id,
        plan.scope.conversation_id,
        plan.request_id,
    )
    store, _ = store_for(row(plan))
    with pytest.raises(ValueError, match="different_input"):
        asyncio.run(store.get_compound_plan(plan.scope, plan.request_id, "b" * 64))
    store, _ = store_for(row(plan))
    assert asyncio.run(store.save_compound_plan(plan)) == plan


def test_missing_or_superseded_plan_cannot_claim_or_replay():
    plan = prepared()
    store, _ = store_for(None)
    assert (
        asyncio.run(
            store.get_compound_plan(plan.scope, plan.request_id, plan.input_hash)
        )
        is None
    )
    store, _ = store_for(row(plan, uuid4()))
    recovered = asyncio.run(
        store.get_compound_plan(plan.scope, plan.request_id, plan.input_hash)
    )
    assert all(a.state == "superseded" for a in recovered.actions)
    store, _ = store_for(row(plan, uuid4()))
    with pytest.raises(ValueError, match="superseded"):
        asyncio.run(
            store.transition_compound(
                plan.scope, plan.request_id, plan.actions[0].id, transition="claim"
            )
        )


def test_claim_and_receipt_are_persisted_under_same_conversation_lock():
    plan = prepared()
    store, connection = store_for(row(plan))
    running = asyncio.run(
        store.transition_compound(
            plan.scope, plan.request_id, plan.actions[0].id, transition="claim"
        )
    )
    assert running.actions[0].state == "running"
    sql, params = connection.calls[-1]
    assert sql.startswith("UPDATE assistant.compound_plans")
    assert params[0].obj["actions"][0]["state"] == "running"
    store, _ = store_for(row(running))
    done = asyncio.run(
        store.transition_compound(
            plan.scope,
            plan.request_id,
            plan.actions[0].id,
            transition="receipt",
            receipt=receipt(running, 0),
        )
    )
    assert done.actions[0].state == "succeeded"
    store, _ = store_for(row(done))
    with pytest.raises(ValueError):
        asyncio.run(
            store.transition_compound(
                plan.scope, plan.request_id, plan.actions[0].id, transition="claim"
            )
        )


def test_success_cannot_be_inserted_without_outcome_transition():
    plan = prepared()
    store, _ = store_for(row(plan))
    running = asyncio.run(
        store.transition_compound(
            plan.scope, plan.request_id, plan.actions[0].id, transition="claim"
        )
    )
    with pytest.raises(ValueError, match="initial_compound_outcome_forbidden"):
        asyncio.run(store.save_compound_plan(running))


def test_future_receipt_cannot_be_saved_as_a_verified_outcome():
    import time

    plan = prepared()
    store, _ = store_for(row(plan))
    running = asyncio.run(
        store.transition_compound(
            plan.scope, plan.request_id, plan.actions[0].id, transition="claim"
        )
    )
    evidence = receipt(running, 0, observed_at=int(time.time()) + 1000)
    store, connection = store_for(row(running))
    with pytest.raises(ValueError, match="receipt_time_invalid"):
        asyncio.run(
            store.transition_compound(
                plan.scope,
                plan.request_id,
                plan.actions[0].id,
                transition="receipt",
                receipt=evidence,
            )
        )
    assert not any(
        sql.startswith("UPDATE assistant.compound_plans") for sql, _ in connection.calls
    )
