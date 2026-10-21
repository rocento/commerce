"""Serial writes, policy gates, failure recovery and duplicate exclusion."""

import asyncio
import json
import time
from copy import deepcopy
from uuid import uuid4

import pytest
from test_compound_planning import WHO, Reader, interpreted, prepared, receipt
from test_language_understanding import interpret

from app.commerce_action_engine.execution.language.gate import Resolution
from app.commerce_action_engine.execution.planning import outcomes
from app.commerce_action_engine.execution.planning.compound_execution import (
    CompoundExecutionSession,
    executable,
)
from app.commerce_action_engine.shared.errors import ToolUnavailable
from app.commerce_orchestration_engine.journeys.compound import execute


@pytest.fixture(scope="module")
def language():
    return Resolution.model_validate(
        interpret(
            [{"messages": ["add 2 banana to cart then add 1 apples to wishlist"]}]
        )[0][0]
    )


@pytest.fixture
def ready(language):
    reader = Reader()
    plan = executable(prepared(reader, language), interpreted(language), WHO)
    reader.calls.clear()
    return plan, reader


class Memory:
    def __init__(self, plan):
        self.plan = plan
        self.active = True
        self.lock = asyncio.Lock()
        self.fail_receipt = False
        self.fail_claim = False

    async def get_compound_plan(self, scope, request, input_hash):
        assert (scope, request, input_hash) == (
            self.plan.scope,
            self.plan.request_id,
            self.plan.input_hash,
        )
        return self.plan if self.active else outcomes.supersede(self.plan)

    async def transition_compound(
        self, scope, request, action_id, *, transition, receipt=None
    ):
        async with self.lock:
            assert (scope, request) == (self.plan.scope, self.plan.request_id)
            if transition == "dispatch":
                if self.fail_claim:
                    raise OSError("claim unavailable")
                if not self.active or not self.plan.execution_enabled:
                    raise ValueError("superseded or review")
                self.plan = outcomes.claim(self.plan, action_id, now=int(time.time()))
            elif transition == "receipt":
                if self.fail_receipt:
                    raise OSError("receipt persistence unavailable")
                self.plan = outcomes.record(self.plan, receipt)
            elif transition == "uncertain":
                self.plan = outcomes.uncertain(self.plan, action_id)
            elif transition == "stop":
                self.plan = outcomes.stop(self.plan)
            else:
                raise AssertionError(transition)
            return self.plan if self.active else outcomes.supersede(self.plan)


class Writer:
    def __init__(self, plan, store):
        self.plan, self.store = plan, store
        self.calls = []
        self.fail_at = None
        self.business_failure = None
        self.supersede_at = None
        self.wrong_receipt = False
        self.hang = False
        self.started = asyncio.Event()

    async def apply(self, command, action_id):
        i = next(i for i, a in enumerate(command.actions) if a.action_id == action_id)
        assert self.store.plan.actions[i].state == "running"
        if i:
            assert self.store.plan.actions[0].state == "succeeded"
        self.calls.append(i)
        self.started.set()
        await asyncio.sleep(0)
        if self.hang:
            await asyncio.Event().wait()
        if self.fail_at == i:
            raise ToolUnavailable()
        if self.supersede_at == i:
            self.store.active = False
        proof = receipt(
            self.plan,
            i,
            outcome="failed" if self.business_failure == i else "succeeded",
        )
        return (
            proof.model_copy(update={"product_id": uuid4()})
            if self.wrong_receipt
            else proof
        )


def run_case(ready, *, customize=lambda s, w, r: None):
    plan, reader = ready
    store = Memory(plan)
    writer = Writer(plan, store)
    customize(store, writer, reader)
    session = CompoundExecutionSession(plan, WHO, write_capability=True)
    result = asyncio.run(execute(plan, session, reader, writer, store))
    return result, store, writer, session


def test_serial_success_rechecks_facts_and_persists_before_next_write(ready):
    result, store, writer, session = run_case(ready)
    assert [a.state for a in result.actions] == ["succeeded", "succeeded"]
    assert store.plan == result and writer.calls == [0, 1]
    assert session.plan.reserved.mutations == 2
    assert session.completed == {
        "facts1": 1,
        "facts2": 1,
        "write1": 1,
        "refresh2": 1,
        "write2": 1,
    }
    assert len(ready[1].calls) == 3


@pytest.mark.parametrize("index", [0, 1])
def test_authoritative_failure_stops_successors_without_undo(ready, index):
    result, _, writer, _ = run_case(
        ready, customize=lambda s, w, r: setattr(w, "business_failure", index)
    )
    assert writer.calls == list(range(index + 1))
    assert [a.state for a in result.actions] == (
        ["failed", "not_started"] if index == 0 else ["succeeded", "failed"]
    )


@pytest.mark.parametrize("index", [0, 1])
def test_lost_response_is_uncertain_and_never_retried(ready, index):
    result, store, writer, _ = run_case(
        ready, customize=lambda s, w, r: setattr(w, "fail_at", index)
    )
    assert writer.calls == list(range(index + 1))
    assert result.actions[index].state == "outcome_unknown"
    assert store.plan.actions[index].state == "outcome_unknown"
    if index == 0:
        assert result.actions[1].state == "not_started"


def test_mismatched_receipt_stops_without_claiming_success(ready):
    result, _, writer, _ = run_case(
        ready, customize=lambda s, w, r: setattr(w, "wrong_receipt", True)
    )
    assert writer.calls == [0]
    assert [a.state for a in result.actions] == ["outcome_unknown", "not_started"]


def test_failed_receipt_persistence_never_starts_successor(ready):
    result, store, writer, _ = run_case(
        ready, customize=lambda s, w, r: setattr(s, "fail_receipt", True)
    )
    assert writer.calls == [0]
    assert result.actions[0].state == "succeeded"
    assert result.actions[1].state == "not_started"
    assert store.plan.actions[0].state == "outcome_unknown"


def test_missing_claim_acknowledgement_never_dispatches(ready):
    result, _, writer, _ = run_case(
        ready, customize=lambda s, w, r: setattr(s, "fail_claim", True)
    )
    assert not writer.calls
    assert all(a.state == "ready" for a in result.actions)


@pytest.mark.parametrize("change", ["identity", "stock", "variant", "unavailable"])
def test_current_product_facts_can_stop_all_writes(ready, change):
    def customize(store, writer, reader):
        if change == "identity":
            reader.wrong_product = True
        elif change == "stock":
            reader.results["banana"][0]["in_stock"] = False
        elif change == "variant":
            reader.results["banana"][0]["product_type"] = "configurable"
        else:

            async def failed(_):
                raise ToolUnavailable()

            reader.product = failed

    result, _, writer, _ = run_case(ready, customize=customize)
    assert not writer.calls
    assert all(a.state == "not_started" for a in result.actions)


def test_concurrent_execution_claims_dispatch_each_action_once(ready):
    async def run():
        plan, reader = ready
        store = Memory(plan)
        writer = Writer(plan, store)
        await asyncio.gather(
            *[
                execute(
                    plan,
                    CompoundExecutionSession(plan, WHO, write_capability=True),
                    reader,
                    writer,
                    store,
                )
                for _ in range(2)
            ]
        )
        assert writer.calls == [0, 1]
        assert all(a.state == "succeeded" for a in store.plan.actions)

    asyncio.run(run())


def test_cancelled_dispatch_persists_uncertainty_and_stops_successor(ready):
    async def run():
        plan, reader = ready
        store = Memory(plan)
        writer = Writer(plan, store)
        writer.hang = True
        task = asyncio.create_task(
            execute(
                plan,
                CompoundExecutionSession(plan, WHO, write_capability=True),
                reader,
                writer,
                store,
            )
        )
        await writer.started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert writer.calls == [0]
        assert [a.state for a in store.plan.actions] == [
            "outcome_unknown",
            "not_started",
        ]

    asyncio.run(run())


def test_supersession_after_first_write_retains_receipt_and_stops_second(ready):
    result, _, writer, _ = run_case(
        ready, customize=lambda s, w, r: setattr(w, "supersede_at", 0)
    )
    assert writer.calls == [0]
    assert [a.state for a in result.actions] == ["succeeded", "superseded"]


def test_no_capability_or_stale_facts_cannot_compile(ready):
    plan, _ = ready
    with pytest.raises(ValueError, match="capability"):
        CompoundExecutionSession(plan, WHO, write_capability=False)
    data = plan.model_dump(mode="json")
    for a in data["actions"]:
        a["binding"].update(observed_at=1, expires_at=31)
    with pytest.raises(ValueError, match="policy_denied"):
        CompoundExecutionSession(
            type(plan).model_validate_json(json.dumps(data)), WHO, write_capability=True
        )


def test_unresolved_language_and_review_plans_cannot_execute(language):
    raw = language.model_dump()
    raw["status"] = "NEEDS_CONTEXT"
    with pytest.raises(ValueError, match="not_admitted"):
        executable(
            prepared(resolution=language),
            interpreted(Resolution.model_validate(raw)),
            WHO,
        )
    review = prepared(resolution=language)
    with pytest.raises(ValueError, match="capability"):
        CompoundExecutionSession(review, WHO, write_capability=True)
    changed = deepcopy(language)
    changed.requestedActions[0].items[0].quantity += 1
    with pytest.raises(ValueError, match="not_admitted|interpretation_changed"):
        executable(review, interpreted(changed), WHO)


def test_runtime_timeout_records_unknown_without_retry(ready):
    plan, reader = ready
    store = Memory(plan)
    writer = Writer(plan, store)
    writer.hang = True
    session = CompoundExecutionSession(plan, WHO, write_capability=True)
    session.operation_timeout = lambda: 0.01
    result = asyncio.run(execute(plan, session, reader, writer, store))
    assert writer.calls == [0]
    assert [a.state for a in result.actions] == ["outcome_unknown", "not_started"]


def test_changed_facts_between_actions_preserve_first_success(ready):
    plan, reader = ready
    store = Memory(plan)
    writer = Writer(plan, store)
    original = writer.apply

    async def change(command, action_id):
        proof = await original(command, action_id)
        reader.results["apples"][0]["sku"] = "CHANGED"
        return proof

    writer.apply = change
    result = asyncio.run(
        execute(
            plan,
            CompoundExecutionSession(plan, WHO, write_capability=True),
            reader,
            writer,
            store,
        )
    )
    assert writer.calls == [0]
    assert [a.state for a in result.actions] == ["succeeded", "not_started"]


def test_expired_policy_between_actions_stops_second(ready, monkeypatch):
    from types import SimpleNamespace

    from app.commerce_action_engine.execution.planning import compound_execution

    plan, reader = ready
    store = Memory(plan)
    writer = Writer(plan, store)
    original = writer.apply
    now = time.time()
    clock = SimpleNamespace(time=lambda: now)
    monkeypatch.setattr(compound_execution, "time", clock)

    async def expire(command, action_id):
        proof = await original(command, action_id)
        clock.time = lambda: now + 60
        return proof

    writer.apply = expire
    result = asyncio.run(
        execute(
            plan,
            CompoundExecutionSession(plan, WHO, write_capability=True),
            reader,
            writer,
            store,
        )
    )
    assert writer.calls == [0]
    assert [a.state for a in result.actions] == ["succeeded", "not_started"]


def test_reverse_destination_order_keeps_customer_sequence():
    language = Resolution.model_validate(
        interpret(
            [{"messages": ["add 1 apples to wishlist then add 2 banana to cart"]}]
        )[0][0]
    )
    reader = Reader()
    plan = executable(prepared(reader, language), interpreted(language), WHO)
    result, _, writer, _ = run_case((plan, reader))
    assert writer.calls == [0, 1]
    assert [a.destination for a in result.actions] == ["wishlist", "cart"]
    assert all(a.state == "succeeded" for a in result.actions)
