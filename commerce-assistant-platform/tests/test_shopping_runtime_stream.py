"""The turn retains SSE sequencing, error mapping and runtime/resource lifetime."""

import asyncio
import json
from dataclasses import replace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_compound_clarification import NoModel
from test_shopping_clarification_sse import Questions
from test_shopping_clarifications import question

from app.commerce_action_engine.application import bootstrap
from app.commerce_action_engine.application.handle_turn import HandleTurn
from app.commerce_action_engine.contracts import AssistantBlock
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.shared.errors import ToolUnavailable
from app.commerce_resolution_engine.contracts import Usage
from app.commerce_resolution_engine.runtime import AgentRuntime, Answer, RuntimeEvent


def application(identity, monkeypatch):
    config, request_id, headers = identity
    store = Questions()
    monkeypatch.setattr(bootstrap, "Store", lambda _: store)
    monkeypatch.setattr(bootstrap, "build_provider", lambda _: NoModel())
    monkeypatch.setattr(
        gate,
        "resolve",
        AsyncMock(
            return_value=gate.Resolution(
                status="RESOLVED",
                intent="PRODUCT_SEARCH",
                entities={"productText": "rings"},
                message="",
                confidence=1,
            )
        ),
    )
    app = bootstrap.create_app(
        replace(config, store_password_file="test-only"),
        transport=httpx.MockTransport(
            lambda _: pytest.fail("Unexpected commerce call")
        ),
    )
    return (
        app,
        store,
        {**headers(), "x-commerce-catalog-token": "test-scoped-read"},
        {
            "request_id": request_id,
            "conversation_id": request_id,
            "message": "find rings",
        },
    )


def events(response):
    assert response.status_code == 200
    result = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert [event["sequence"] for event in result] == list(range(len(result)))
    return result


def test_runtime_response_order_and_completion_metadata_reach_transcript(
    identity, monkeypatch
):
    app, store, headers, body = application(identity, monkeypatch)
    closed = []

    async def stream(self, **kwargs):
        try:
            yield RuntimeEvent("tool_started", "catalog")
            yield RuntimeEvent("tool_completed", "catalog")
            yield RuntimeEvent("text_delta", "Found rings")
            yield RuntimeEvent(
                "completed",
                answer=Answer(
                    "not another text delta",
                    ("source",),
                    Usage(3, 2, 5),
                    1,
                    "deterministic",
                    (AssistantBlock(kind="text", text="Ring details"),),
                    "read_result",
                ),
            )
        finally:
            closed.append(True)

    monkeypatch.setattr(AgentRuntime, "stream", stream)
    with TestClient(app) as client:
        result = events(client.post("/v1/chat", headers=headers, json=body))
    assert [event["type"] for event in result[-5:]] == [
        "progress",
        "progress",
        "message.delta",
        "content.blocks",
        "done",
    ]
    assert [event.get("stage") for event in result[-5:-3]] == ["catalog", "responding"]
    assert result[-3]["text"] == "Found rings"
    assert result[-2]["blocks"] == [{"kind": "text", "text": "Ring details"}]
    assert closed == [True] and len(store.saved) == 1
    assert "not another text delta" not in store.saved[0][5]
    metadata = store.saved[0][7]
    assert metadata["completion_evidence"] == "read_result"
    assert metadata["model"] == "deterministic" and metadata["retrieval_count"] == 1
    assert metadata["tools"] == ["catalog"]
    assert metadata["completion"]["status"] == "completed"
    assert metadata["completion"]["evidence"] == "read_result"


@pytest.mark.parametrize(
    "operation", ["publish_shopping_question", "save_active_shopping"]
)
def test_publication_error_closes_runtime_without_publishing_text_or_saving_transcript(
    identity, monkeypatch, operation
):
    app, store, headers, body = application(identity, monkeypatch)
    write = AsyncMock(side_effect=ToolUnavailable())
    monkeypatch.setattr(store, operation, write)
    closed = []

    async def stream(self, **kwargs):
        try:
            plan = question()
            yield RuntimeEvent(
                "text_delta",
                "Must not be emitted",
                **(
                    {"pending_shopping": plan}
                    if operation == "publish_shopping_question"
                    else {
                        "shopping_frame": plan.frame,
                        "shopping_revision": "catalog-v1",
                    }
                ),
            )
            pytest.fail("Runtime advanced after failed publication")
        finally:
            closed.append(True)

    monkeypatch.setattr(AgentRuntime, "stream", stream)
    with TestClient(app) as client:
        result = events(client.post("/v1/chat", headers=headers, json=body))
    assert [event["type"] for event in result[-2:]] == ["error", "done"]
    assert all(
        event.get("text") != "Must not be emitted" and not event.get("clarification")
        for event in result
    )
    assert not store.saved and closed == [True]
    write.assert_awaited_once()


def test_disconnect_closes_runtime_before_turn_resources_without_saving_transcript(
    identity, monkeypatch
):
    app, store, headers, body = application(identity, monkeypatch)
    closed = []
    original_init = HandleTurn.__init__

    def init(self, prepared, request):
        async def close_resource():
            closed.append("resource")

        prepared.lease.resources.push_async_callback(close_resource)
        original_init(self, prepared, request)

    monkeypatch.setattr(HandleTurn, "__init__", init)

    async def scenario():
        entered = asyncio.Event()

        async def stream(self, **kwargs):
            try:
                yield RuntimeEvent("text_delta", "First result")
                entered.set()
                await asyncio.Future()
            finally:
                closed.append("runtime")

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
    assert closed == ["runtime", "resource"]
    assert not store.saved
