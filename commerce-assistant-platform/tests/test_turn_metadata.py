"""Saved completion, final diagnostics and trace records share one turn state."""

import asyncio
from copy import deepcopy
from dataclasses import replace
from types import SimpleNamespace
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_shopping_clarifications import question
from test_shopping_runtime_stream import application, events

from app.commerce_action_engine.application import turn_finalization, turn_output
from app.commerce_action_engine.application.handle_turn import HandleTurn
from app.commerce_action_engine.application.shopping_runtime_responses import (
    ShoppingRuntimeResponses,
)
from app.commerce_action_engine.application.turn_output import TurnOutput
from app.commerce_action_engine.application.turn_routing import TurnRouting
from app.commerce_action_engine.contracts import AssistantBlock
from app.commerce_action_engine.platform import TurnTrace
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable
from app.commerce_resolution_engine.contracts import Usage
from app.commerce_resolution_engine.runtime import AgentRuntime, Answer, RuntimeEvent


def capture_turn(monkeypatch, store):
    outputs, traces, diagnostics = [], [], []
    original_output_init = TurnOutput.__init__
    original_turn_init = HandleTurn.__init__
    original_save = store.save

    def output_init(self, *args, **kwargs):
        original_output_init(self, *args, **kwargs)
        outputs.append(self)

    async def record_trace(decision, outcome, duration, metadata):
        traces.append((outcome, deepcopy(metadata)))

    def turn_init(self, prepared, body):
        original_turn_init(self, replace(prepared, record_trace=record_trace), body)

    async def save(*args):
        # Model serialization at the actual write, not a mutable fake-store alias.
        await original_save(*deepcopy(args))

    def debug_record(kind, data):
        if kind == "final_result":
            diagnostics.append(deepcopy(data))

    monkeypatch.setattr(TurnOutput, "__init__", output_init)
    monkeypatch.setattr(HandleTurn, "__init__", turn_init)
    monkeypatch.setattr(turn_output, "capture_enabled", lambda: True)
    monkeypatch.setattr(turn_finalization, "debug_record", debug_record)
    monkeypatch.setattr(store, "save", save)
    return outputs, traces, diagnostics


def assert_consistent(outputs, traces, diagnostics, expected):
    assert len(outputs) == len(traces) == len(diagnostics) == 1
    completion = outputs[0].metadata["completion"]
    assert completion["status"] == expected
    assert traces[0][1]["completion"] == completion
    # Diagnostics intentionally publish only their documented completion subset.
    assert diagnostics[0]["completion"] == {
        key: completion[key] for key in diagnostics[0]["completion"]
    }
    assert diagnostics[0]["completion"]["status"] == expected
    return completion


@pytest.mark.parametrize(
    "mode",
    [
        "completed",
        "clarification",
        "unverified",
        "invalid_blocks",
        "unavailable",
        "denied",
    ],
)
def test_runtime_completion_agrees_across_saved_transcript_trace_and_diagnostics(
    identity, monkeypatch, mode
):
    app, store, headers, body = application(identity, monkeypatch)
    outputs, traces, diagnostics = capture_turn(monkeypatch, store)

    async def stream(self, **kwargs):
        yield RuntimeEvent("tool_started", "catalog")
        if mode == "clarification":
            yield RuntimeEvent(
                "text_delta", question().question, pending_shopping=question()
            )
        else:
            yield RuntimeEvent("text_delta", "Results")
        block = AssistantBlock(kind="text", text="Details")
        yield RuntimeEvent(
            "completed",
            answer=Answer(
                "",
                ("source",),
                Usage(3, 2, 5),
                1,
                "deterministic",
                (block,) * (9 if mode == "invalid_blocks" else 1),
                None if mode in {"clarification", "unverified"} else "read_result",
            ),
        )
        if mode == "unavailable":
            raise ToolUnavailable()
        if mode == "denied":
            raise ToolDenied()

    monkeypatch.setattr(AgentRuntime, "stream", stream)
    with TestClient(app) as client:
        result = events(client.post("/v1/chat", headers=headers, json=body))
    assert result[-1]["type"] == "done"
    expected = "unavailable" if mode == "invalid_blocks" else mode
    completion = assert_consistent(outputs, traces, diagnostics, expected)
    assert traces[0][1]["model"] == "deterministic"
    assert traces[0][1]["tool_calls"] == 1
    if mode in {"completed", "clarification", "unverified"}:
        assert len(store.saved) == 1
        assert store.saved[0][7]["completion"] == completion
        assert store.saved[0][7]["model"] == "deterministic"
    else:
        assert not store.saved
        assert completion["task_completed"] is False
        assert completion["evidence"] is None
    if mode == "completed":
        assert completion["evidence"] == "read_result"
    if mode == "clarification":
        assert any(event.get("clarification") for event in result)


def test_disconnect_after_runtime_completion_updates_all_final_observers(
    identity, monkeypatch
):
    app, store, headers, body = application(identity, monkeypatch)
    outputs, traces, diagnostics = capture_turn(monkeypatch, store)

    async def scenario():
        entered = asyncio.Event()

        async def stream(self, **kwargs):
            yield RuntimeEvent(
                "completed",
                answer=Answer(
                    "",
                    (),
                    Usage(0, 0, 0),
                    0,
                    "deterministic",
                    completion_evidence="read_result",
                ),
            )
            yield RuntimeEvent("text_delta", "First result")
            entered.set()
            await asyncio.Future()

        monkeypatch.setattr(AgentRuntime, "stream", stream)
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://test"
            ) as client,
        ):
            task = asyncio.create_task(
                client.post("/v1/chat", headers=headers, json=body)
            )
            try:
                await asyncio.wait_for(entered.wait(), 3)
            finally:
                task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    asyncio.run(scenario())
    completion = assert_consistent(outputs, traces, diagnostics, "disconnected")
    assert completion["task_completed"] is False and completion["evidence"] is None
    assert not store.saved


def test_metadata_views_cannot_be_replaced_but_share_mutations(identity):
    config = identity[0]
    output = TurnOutput(UUID(identity[1]), config, config, {}, TurnTrace())
    routing = TurnRouting(SimpleNamespace(runtime=None), TurnTrace(), output.metadata)
    responses = ShoppingRuntimeResponses(
        scope=None,
        active_writer=None,
        question_publisher=None,
        metadata=output.metadata,
        model_provider="test",
    )
    for view in (output, routing, responses):
        with pytest.raises(AttributeError):
            view.metadata = {}
    routing.metadata["route_reason"] = "language_engine_search"
    responses.metadata["completion_evidence"] = "read_result"
    output.event("message.delta", text="Unavailable", code="unavailable")
    assert output.metadata is routing.metadata is responses.metadata
    assert responses.metadata["completion_disposition"] == "unavailable"
