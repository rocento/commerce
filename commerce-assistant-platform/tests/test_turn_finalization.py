"""Finalization ordering and failure propagation at persistence boundaries."""

import asyncio
from types import SimpleNamespace as NS
from unittest.mock import Mock
from uuid import UUID

import pytest

from app.commerce_action_engine.application import turn_finalization as module
from app.commerce_action_engine.application.turn_finalization import TurnFinalization


@pytest.fixture
def setup(monkeypatch):
    calls = []

    def sync(name, result=None):
        def call(*args, **kwargs):
            calls.append(name)
            return result

        return call

    def async_call(name):
        async def call(*args, **kwargs):
            calls.append(name)

        return call

    store = NS(save=async_call("save"))
    trace = NS(planning={}, summary=sync("summary", {}), emit=sync("emit"))
    output = NS(
        metadata={},
        answer=["answer"],
        blocks=[],
        trace=trace,
        usage_metadata=sync("usage", {}),
        record_completion=sync("completion"),
        diagnostic_evidence=dict,
    )
    prepared = NS(
        store=store,
        caller=NS(tenant=UUID(int=1), subject=UUID(int=2)),
        config=NS(intent_tracking_enabled=True),
        tracked={"default": NS(attempts=0)},
        persistence=NS(tracking=NS(save_tracking=async_call("tracking"))),
        lease=NS(aclose=async_call("close")),
        record_trace=async_call("metric"),
    )
    body = NS(conversation_id=UUID(int=3), request_id=UUID(int=4), message="question")
    context = Mock()
    context.__exit__ = Mock(side_effect=sync("exit"))
    monkeypatch.setattr(module.personalization, "flush", async_call("flush"))
    monkeypatch.setattr(module, "debug_record", sync("debug"))
    monkeypatch.setattr(
        module, "finish_debug", sync("finish_debug", {"captured": True})
    )
    coordinator = TurnFinalization(
        prepared,
        body,
        output,
        NS(decision_trace=object()),
        started=0,
        trace_context=context,
        debug_token=None,
    )
    return coordinator, calls


@pytest.mark.parametrize("failure", [None, "save", "flush"])
def test_persistence_precedes_flush_and_propagates_failure(setup, monkeypatch, failure):
    coordinator, calls = setup
    if failure:

        async def fail(*args):
            calls.append(failure)
            raise RuntimeError(failure)

        if failure == "save":
            coordinator.prepared.store.save = fail
        else:
            monkeypatch.setattr(module.personalization, "flush", fail)

    async def run():
        return await coordinator.persist(
            question="original followup",
            outcome="completed",
            clarification_reply=False,
            prior_completion=None,
            fallback_model_used=False,
        )

    if failure:
        with pytest.raises(RuntimeError, match=failure):
            asyncio.run(run())
    else:
        assert asyncio.run(run()) is True
    assert calls == ["usage", "completion", "save"] + (
        [] if failure == "save" else ["flush"]
    )


@pytest.mark.parametrize("failure", [None, "close", "emit", "tracking", "metric"])
def test_cleanup_preserves_nested_finally_and_best_effort_telemetry(setup, failure):
    coordinator, calls = setup
    if failure:

        def fail(*args):
            calls.append(failure)
            raise RuntimeError(failure)

        async def async_fail(*args):
            fail(*args)

        if failure == "emit":
            coordinator.output.trace.emit = fail
        elif failure == "close":
            coordinator.prepared.lease.aclose = async_fail
        elif failure == "tracking":
            coordinator.prepared.persistence.tracking.save_tracking = async_fail
        else:
            coordinator.prepared.record_trace = async_fail

    async def run():
        await coordinator.finish(
            outcome="disconnected", clarification_reply=False, prior_completion=None
        )

    if failure in {"close", "emit"}:
        with pytest.raises(RuntimeError, match=failure):
            asyncio.run(run())
    else:
        asyncio.run(run())
    expected = [
        "usage",
        "completion",
        "close",
        "summary",
        "emit",
        "exit",
        "debug",
        "finish_debug",
    ]
    if failure not in {"close", "emit"}:
        expected += ["tracking", "metric"]
    assert calls == expected


def test_recovery_saves_without_flushing_or_recomputing_completion(setup):
    coordinator, calls = setup
    asyncio.run(coordinator.save_recovery("recovered", []))
    assert calls == ["save"]


def test_tracking_is_shielded_but_route_metrics_remain_cancellable(setup):
    import anyio

    coordinator, calls = setup

    async def tracking(*args):
        await anyio.lowlevel.checkpoint()
        calls.append("tracking_saved")

    async def metric(*args):
        await anyio.lowlevel.checkpoint()
        calls.append("metric_saved")

    coordinator.prepared.persistence.tracking.save_tracking = tracking
    coordinator.prepared.record_trace = metric

    async def run():
        with anyio.CancelScope() as scope:
            scope.cancel()
            await coordinator.finish(
                outcome="disconnected", clarification_reply=False, prior_completion=None
            )
            calls.append("finished")

    anyio.run(run)
    assert "tracking_saved" in calls
    assert "metric_saved" not in calls
    assert "finished" not in calls


def test_without_transcript_storage_memory_is_still_flushed(setup):
    coordinator, calls = setup
    coordinator.prepared.store = None
    saved = asyncio.run(
        coordinator.persist(
            question="question",
            outcome="completed",
            clarification_reply=False,
            prior_completion=None,
            fallback_model_used=False,
        )
    )
    assert saved is False
    assert calls == ["usage", "completion", "flush"]
