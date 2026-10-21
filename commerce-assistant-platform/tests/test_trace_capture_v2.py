"""M2 identity, bounded terminal evidence and real adapter dispatch semantics."""

import asyncio
import json
from contextlib import aclosing
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import httpx
import pytest
from test_assistant_tracking import Scope
from test_model_provider import REQUEST, Chunks, provider, result, sse, streaming

from app.commerce_action_engine.application.turn_output import TurnOutput
from app.commerce_action_engine.platform.live_tracking import LiveFeed
from app.commerce_action_engine.platform.telemetry import TurnTrace
from app.commerce_action_engine.platform.tracking import TrackingStore
from app.commerce_resolution_engine.contracts import ModelError, ModelRequest
from app.commerce_resolution_engine.diagnostics import (
    MAX_BYTES,
    MAX_EVENTS,
    begin_debug,
    debug_record,
    finish_debug,
    provider_totals,
    traced,
)


def test_nested_concurrent_and_cancelled_spans_keep_explicit_parents():
    @traced
    def leaf():
        debug_record("leaf_decision", {"status": "checked"})

    @traced
    async def child(cancel=False):
        leaf()
        await asyncio.sleep(0)
        if cancel:
            raise asyncio.CancelledError()

    @traced
    async def parent():
        await asyncio.gather(child(), child(True), return_exceptions=True)

    async def run():
        token = begin_debug(str(uuid4()), "hello", enabled=True)
        await parent()
        leaf()  # Must not inherit a completed child/parent scope.
        return finish_debug(token)

    report = asyncio.run(run())
    assert report["version"] == 2
    events = report["events"]
    assert len({e["data"]["_journey"]["eventId"] for e in events}) == len(events)
    calls = [e["data"] for e in events if e["stage"] == "python_function"]
    parent_call = next(c for c in calls if c["function"].endswith(".parent"))
    children = [c for c in calls if c["function"].endswith(".child")]
    assert len({c["_journey"]["spanId"] for c in children}) == 2
    assert all(
        c["_journey"]["parentSpanId"] == parent_call["_journey"]["spanId"]
        for c in children
    )
    assert {c["outcome"] for c in children} == {"returned", "cancelled"}
    assert calls[-1]["_journey"]["parentSpanId"] is None
    for c in children:
        assert any(
            x["_journey"]["parentSpanId"] == c["_journey"]["spanId"] for x in calls
        )
    assert all(
        e["data"]["_journey"]["clockDomain"] == "python-perf-counter" for e in events
    )


def test_child_finishing_after_capture_close_cannot_mutate_saved_report():
    @traced
    async def late(ready, release):
        ready.set()
        await release.wait()
        debug_record("late", {"secret": "not captured"})

    async def run():
        token = begin_debug(str(uuid4()), "hello", enabled=True)
        ready, release = asyncio.Event(), asyncio.Event()
        task = asyncio.create_task(late(ready, release))
        await ready.wait()
        report = finish_debug(token)
        before = json.dumps(report)
        release.set()
        await task
        assert json.dumps(report) == before

    asyncio.run(run())


def test_terminal_survives_event_and_byte_pressure_within_original_budget():
    for mode in ["events", "bytes"]:
        token = begin_debug(str(uuid4()), "hello", enabled=True)
        for i in range(120 if mode == "events" else 20):
            debug_record(
                "noise", {"n": i, "text": "x" * (60000 if mode == "bytes" else 2)}
            )
        debug_record(
            "final_result",
            {
                "outcome": "completed",
                "completion": {"version": 1, "status": "unverified"},
                "language_gate": {"intent": "PRODUCT_SEARCH", "status": "RESOLVED"},
                "answer": "x" * 1_000_000,
                "response_blocks": [{"text": "x" * 100000}],
            },
        )
        report = finish_debug(token)
        assert report["truncated"] and len(report["events"]) <= MAX_EVENTS
        final = report["events"][-1]
        assert final["stage"] == "final_result"
        assert final["data"]["completion"]["status"] == "unverified"
        assert final["data"]["language_gate"]["intent"] == "PRODUCT_SEARCH"
        assert final["data"]["terminal_details_truncated"] is True
        assert len(json.dumps(report).encode()) < MAX_BYTES


def test_dispatches_are_counted_once_with_usage_and_prepared_input_correlation():
    responses = iter([httpx.Response(429), httpx.Response(200, json=result())])

    async def run():
        token = begin_debug(str(uuid4()), "hello", enabled=True)
        model = provider(lambda _: next(responses))
        try:
            with pytest.raises(ModelError):
                await model.generate(REQUEST)
            response = await model.generate(REQUEST)
            assert response.text == "hello"
            totals = provider_totals()
        finally:
            await model.aclose()
            report = finish_debug(token)
        return report, totals

    report, totals = asyncio.run(run())
    attempts = [e["data"] for e in report["events"] if e["stage"] == "provider_attempt"]
    payloads = [
        e["data"] for e in report["events"] if e["stage"] == "provider_wire_payload"
    ]
    assert [a["outcome"] for a in attempts] == ["failed", "completed"]
    assert attempts[0]["input_tokens"] is None
    assert attempts[1]["input_tokens"] == 10 and attempts[1]["output_tokens"] == 2
    assert [a["attempt_id"] for a in attempts] == [
        p["_journey"]["spanId"] for p in payloads
    ]
    assert all(a["_journey"]["startMs"] <= a["_journey"]["atMs"] for a in attempts)
    assert len(attempts[0]["prompt_fingerprint"]) == 64
    assert attempts[0]["prompt_fingerprint"] == attempts[1]["prompt_fingerprint"]
    assert totals["attempts"] == 2 and totals["completed"] == 1
    assert totals["input_tokens"] == 10 and totals["usage_complete"] is False
    assert "secret-canary" not in json.dumps(report)


def test_pre_dispatch_rejection_is_not_a_provider_attempt():
    async def run():
        token = begin_debug(str(uuid4()), "hello", enabled=True)
        model = provider(lambda _: pytest.fail("Invalid request dispatched"))
        try:
            with pytest.raises(ModelError):
                await model.generate(ModelRequest(()))
            assert provider_totals()["attempts"] == 0
        finally:
            await model.aclose()
            report = finish_debug(token)
        assert not any(e["stage"] == "provider_attempt" for e in report["events"])

    asyncio.run(run())


def test_stream_close_preserves_cancellation_and_does_not_invent_usage():
    async def run():
        token = begin_debug(str(uuid4()), "hello", enabled=True)
        chunks = Chunks(
            [sse({"type": "response.output_text.delta", "delta": "hello"})], pause=True
        )
        model = provider(lambda _: streaming(chunks))
        try:
            async with aclosing(model.stream(REQUEST)) as events:
                await anext(events)
            debug_record("after_stream", {})
            assert provider_totals()["completed"] == 0
        finally:
            await model.aclose()
            report = finish_debug(token)
        attempt = next(
            e["data"] for e in report["events"] if e["stage"] == "provider_attempt"
        )
        assert attempt["outcome"] == "cancelled" and attempt["input_tokens"] is None
        assert report["events"][-1]["data"]["_journey"]["spanId"] is None
        assert chunks.closed

    asyncio.run(run())


def test_terminal_reuses_completion_policy_and_names_clock_boundaries():
    ident = UUID(int=42)
    token = begin_debug(str(ident), "hello", enabled=True)
    output = TurnOutput(ident, SimpleNamespace(), SimpleNamespace(), {}, TurnTrace())
    output.metadata.update(
        {
            "completion_evidence": "action_receipt",
            "completion_disposition": "clarification",
        }
    )
    output.record_completion(
        outcome="completed", clarification_reply=False, prior_completion=None
    )
    output.trace.mark()
    evidence = output.diagnostic_evidence()
    debug_record("final_result", {"outcome": "completed", **evidence})
    report = finish_debug(token)
    assert evidence["completion"]["status"] == "clarification"
    assert evidence["completion"]["task_completed"] is False
    times = evidence["measurements"]
    assert 0 <= times["first_text_ms"] <= times["request_duration_ms"]
    assert times["first_text_boundary"] == "server_text_event_created"
    assert times["clock_domain"] == "python-turn-monotonic"
    assert times["trace_id"] == str(ident)
    assert report["events"][-1]["data"]["provider_totals"]["attempts"] == 0
    assert output.diagnostic_evidence() == {}


def test_v2_evidence_survives_storage_and_live_redaction():
    tenant, request = uuid4(), UUID(int=42)
    feed = LiveFeed()
    cursor = feed.read(str(tenant))["cursor"]
    token = begin_debug(
        str(request),
        "test@example.com",
        enabled=True,
        publish=lambda r, kind, data: feed.publish(str(tenant), r, kind, data),
    )
    debug_record(
        "final_result",
        {
            "outcome": "completed",
            "password": "secret-canary",
            "measurements": {
                "version": 1,
                "trace_id": str(request),
                "clock_domain": "python-turn-monotonic",
                "request_duration_ms": 12,
            },
        },
    )
    report = finish_debug(token)
    connection = SimpleNamespace(execute=AsyncMock(), transaction=lambda: Scope(None))
    store = TrackingStore()
    store.pool = SimpleNamespace(connection=lambda: Scope(connection))
    asyncio.run(store.save_tracking(tenant, request, report))
    stored = connection.execute.await_args_list[1].args[1][3].obj
    live = feed.read(str(tenant), cursor)
    for value in [stored, live]:
        serialized = json.dumps(value)
        assert (
            "secret-canary" not in serialized and "test@example.com" not in serialized
        )
        assert "python-turn-monotonic" in serialized
    assert stored["version"] == 2
    assert stored["events"][-1]["data"]["measurements"]["request_duration_ms"] == 12
    assert stored["events"][-1]["data"]["_journey"]["traceId"] == str(request)


def test_disabled_capture_does_not_compute_provider_fingerprint(monkeypatch):
    from app.commerce_resolution_engine.providers import diagnostics

    monkeypatch.setattr(
        diagnostics.hashlib,
        "sha256",
        lambda _: pytest.fail("disabled capture hashed prompt"),
    )

    async def run():
        token = begin_debug(str(uuid4()), "private", enabled=True, allowed=False)
        model = provider(lambda _: httpx.Response(200, json=result()))
        try:
            assert (await model.generate(REQUEST)).text == "hello"
            assert provider_totals() is None
        finally:
            await model.aclose()
        assert finish_debug(token) is None

    asyncio.run(run())


def test_requirement_counts_reuse_real_verification_and_preserve_results():
    from test_shopping import product

    from app.commerce_action_engine.actions.catalog import Product
    from app.commerce_action_engine.actions.shopping.meaning import verified_products
    from app.commerce_action_engine.execution.core.meaning import (
        ConstraintFrame,
        Requirement,
        Value,
    )

    products = [
        Product(**product(i + 1, price="10" if i < 3 else "100", in_stock=i >= 3))
        for i in range(12)
    ]
    frame = ConstraintFrame(
        requirements=(
            Requirement(
                field="price",
                operator="lte",
                value=Value(kind="money", number="20", unit="USD"),
                strength="hard",
                source="current_customer",
                confidence=1,
            ),
            Requirement(
                field="in_stock",
                operator="eq",
                value=Value(kind="boolean", boolean=True),
                strength="hard",
                source="current_customer",
                confidence=1,
            ),
        )
    )
    observed = []
    captured = verified_products(products, frame, on_checks=observed.extend)
    assert captured == verified_products(products, frame) == []
    assert [(r["before"], r["after"]) for r in observed] == [(12, 3), (3, 0)]
    assert all(r["effect"] == "ordered_verification_results" for r in observed)
    assert "Stock" in observed[1]["check"]


def test_concurrent_provider_calls_keep_attempt_identity_and_prompt_evidence():
    from app.commerce_resolution_engine.contracts import Message

    async def handle(request):
        await asyncio.sleep(0)
        data = json.loads(request.content)
        return httpx.Response(200, json=result(model=data["model"]))

    async def run():
        token = begin_debug(str(uuid4()), "hello", enabled=True)
        models = [provider(handle), provider(handle)]
        models[1].model = "second-model"
        try:
            await asyncio.gather(
                *[
                    model.generate(
                        ModelRequest(
                            (Message("user", "hello"),), instructions=f"prompt {i}"
                        )
                    )
                    for i, model in enumerate(models)
                ]
            )
            totals = provider_totals()
        finally:
            for model in models:
                await model.aclose()
            report = finish_debug(token)
        attempts = [
            e["data"] for e in report["events"] if e["stage"] == "provider_attempt"
        ]
        assert len({a["attempt_id"] for a in attempts}) == 2
        assert len({a["prompt_fingerprint"] for a in attempts}) == 2
        assert {a["requested_model"] for a in attempts} == {
            "configured-model",
            "second-model",
        }
        assert all(a["_journey"]["parentSpanId"] is None for a in attempts)
        for attempt in attempts:
            payload = next(
                e["data"]
                for e in report["events"]
                if e["stage"] == "provider_wire_payload"
                and e["data"]["_journey"]["spanId"] == attempt["attempt_id"]
            )
            assert (
                attempt["_journey"]["startMs"]
                <= payload["_journey"]["atMs"]
                <= attempt["_journey"]["atMs"]
            )
            assert attempt["dispatch_start_ms"] >= attempt["_journey"]["startMs"]
        assert totals["attempts"] == totals["completed"] == 2
        assert totals["input_tokens"] == 20 and totals["usage_complete"]

    asyncio.run(run())


def test_completed_stream_records_usage_once_even_when_consumer_closes():
    async def run():
        token = begin_debug(str(uuid4()), "hello", enabled=True)
        chunks = Chunks(
            [
                sse({"type": "response.output_text.delta", "delta": "hello"}),
                sse({"type": "response.completed", "response": result()}),
            ]
        )
        model = provider(lambda _: streaming(chunks))
        try:
            async with aclosing(model.stream(REQUEST)) as events:
                await anext(events)
                assert (await anext(events)).type == "completed"
            assert provider_totals()["completed"] == 1
            assert provider_totals()["input_tokens"] == 10
        finally:
            await model.aclose()
            report = finish_debug(token)
        attempt = next(
            e["data"] for e in report["events"] if e["stage"] == "provider_attempt"
        )
        assert attempt["outcome"] == "completed"
        assert attempt["adapter_validation"] == "accepted"

    asyncio.run(run())
