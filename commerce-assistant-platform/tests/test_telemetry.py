import asyncio
import json
import logging

import pytest
from test_runtime import FakeProvider, final

from app.commerce_action_engine.platform.costs import estimated_micros
from app.commerce_action_engine.platform.telemetry import (
    TurnTrace,
    mark_provider_token,
    phase,
    trace_turn,
)
from app.commerce_resolution_engine.contracts import Message, ModelError, ModelRequest
from app.commerce_resolution_engine.providers.usage import CallBudget, UsageProvider


def test_trace_is_bounded_and_never_records_exception_payload(caplog):
    trace = TurnTrace()
    with trace_turn(trace):
        for _ in range(40):
            with phase("tool"):
                pass
        with pytest.raises(ModelError), phase("provider"):
            raise ModelError("rate_limit")
        trace.mark()
    logger = logging.getLogger("assistant.performance")
    logger.addHandler(caplog.handler)
    try:
        trace.emit("test-request", "unavailable")
    finally:
        logger.removeHandler(caplog.handler)
    data = json.loads(caplog.records[-1].message)
    assert len(data["spans"]) == 32
    assert data["timings"]["tool_count"] == 40
    assert data["timings"]["provider_rate_limits"] == 1
    assert data["timings"]["first_text_ms"] is not None
    assert set(data) == {"event", "trace_id", "outcome", "timings", "spans"}


def test_concurrent_traces_do_not_mix_and_provider_usage_stays_correct():
    async def run():
        async def turn(count):
            trace = TurnTrace()
            with trace_turn(trace):
                provider = UsageProvider(
                    FakeProvider([final()] * count),
                    trace_phase=phase,
                    on_token=mark_provider_token,
                )
                for _ in range(count):
                    async for _ in provider.stream(
                        ModelRequest((Message("user", "private-canary"),))
                    ):
                        await asyncio.sleep(0)
            assert trace.totals["provider_count"] == count
            assert trace.provider_first_token_ms is not None
            assert provider.calls == count
            assert "private-canary" not in repr(trace)
            return trace

        traces = await asyncio.gather(turn(1), turn(3))
        with phase("tool"):
            pass
        assert all("tool_count" not in trace.totals for trace in traces)

    asyncio.run(run())


def test_usage_provider_stops_a_turn_after_its_model_call_budget():
    async def run():
        provider = UsageProvider(FakeProvider([final(), final()]), max_calls=1)
        request = ModelRequest((Message("user", "question"),))
        assert len([event async for event in provider.stream(request)]) == 2
        with pytest.raises(ModelError, match="budget_exceeded") as error:
            await provider.generate(request)
        assert error.value.code == "budget_exceeded"
        assert (provider.calls, provider.attempts) == (1, 1)

    asyncio.run(run())


def test_cost_estimate_uses_configured_integer_pricing():
    assert estimated_micros(1250, 500, 2000, 8000) == 6500
    with pytest.raises(ValueError):
        estimated_micros(-1, 0, 0, 0)


def test_model_profiles_share_budget_and_failures_count():
    async def run():
        budget = CallBudget(1)
        failing = UsageProvider(
            FakeProvider([ModelError("unavailable")]), budget=budget
        )
        other = UsageProvider(FakeProvider([final()]), budget=budget)
        request = ModelRequest((Message("user", "question"),))
        with pytest.raises(ModelError, match="unavailable"):
            _ = [event async for event in failing.stream(request)]
        with pytest.raises(ModelError, match="budget_exceeded"):
            _ = [event async for event in other.stream(request)]
        assert failing.attempts == 1 and failing.calls == 0 and other.attempts == 0

    asyncio.run(run())


def test_injected_trace_records_generate_failures_and_excludes_budget_rejections():
    class Provider:
        async def generate(self, request):
            raise ModelError("rate_limit")

    async def run():
        trace = TurnTrace()
        provider = UsageProvider(Provider(), max_calls=1, trace_phase=phase)
        request = ModelRequest((Message("user", "private-canary"),))
        with trace_turn(trace):
            with pytest.raises(ModelError, match="rate_limit"):
                await provider.generate(request)
            with pytest.raises(ModelError, match="budget_exceeded"):
                await provider.generate(request)
        assert provider.attempts == 1 and provider.calls == 0
        assert trace.totals["provider_count"] == 1
        assert trace.totals["provider_rate_limits"] == 1
        assert trace.spans[0]["outcome"] == "failed"
        assert "private-canary" not in repr(trace)

    asyncio.run(run())


def test_early_stream_close_finishes_trace_without_closing_shared_provider():
    class Provider(FakeProvider):
        closed = False

        async def aclose(self):
            self.closed = True

    async def run():
        trace = TurnTrace()
        inner = Provider([final()])
        provider = UsageProvider(inner, trace_phase=phase, on_token=mark_provider_token)
        with trace_turn(trace):
            stream = provider.stream(ModelRequest((Message("user", "question"),)))
            assert (await anext(stream)).type == "text_delta"
            await stream.aclose()
            await provider.aclose()
        assert inner.closed_streams == 1 and not inner.closed
        assert trace.provider_first_token_ms is not None
        assert trace.totals["provider_count"] == 1
        assert (provider.attempts, provider.calls, provider.output_tokens) == (1, 0, 0)

    asyncio.run(run())
