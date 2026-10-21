"""Runtime response translation preserves scope, publication and failure ordering."""

import asyncio
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import pytest
from test_shopping_clarifications import question

from app.commerce_action_engine.application.shopping_runtime_responses import (
    RuntimeResponse,
    ShoppingResponseScope,
    ShoppingRuntimeResponses,
)
from app.commerce_action_engine.contracts import AssistantBlock
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable
from app.commerce_resolution_engine.contracts import Usage
from app.commerce_resolution_engine.runtime import Answer, RuntimeEvent

SCOPE = ShoppingResponseScope(
    *(UUID(int=i) for i in range(1, 7)), message="find luxury rings"
)


def coordinator(*, scope=SCOPE, publisher=True, writer=True, metadata=None):
    ports = SimpleNamespace(
        publish_shopping_question=AsyncMock(return_value=True),
        save_active_shopping=AsyncMock(return_value=True),
    )
    return (
        ShoppingRuntimeResponses(
            scope=scope,
            active_writer=ports if writer else None,
            question_publisher=ports if publisher else None,
            metadata={} if metadata is None else metadata,
            model_provider="test-provider",
        ),
        ports,
    )


def test_progress_and_text_keep_order_and_duplicate_tool_count():
    response, ports = coordinator()

    async def scenario():
        return [
            await response.handle(event)
            for event in (
                RuntimeEvent("tool_started", "catalog"),
                RuntimeEvent("tool_completed", "catalog"),
                RuntimeEvent("tool_started", "catalog"),
                RuntimeEvent("tool_started", "details"),
                RuntimeEvent("text_delta", "Here are your rings."),
                RuntimeEvent("completed"),
            )
        ]

    assert asyncio.run(scenario()) == [
        RuntimeResponse("progress", {"stage": "catalog"}),
        RuntimeResponse("progress", {"stage": "responding"}),
        RuntimeResponse("progress", {"stage": "catalog"}),
        RuntimeResponse("progress", {"stage": "catalog"}),
        RuntimeResponse("message.delta", {"text": "Here are your rings."}),
        None,
    ]
    assert response.metadata == {"tool_calls": 3, "tools": ["catalog", "details"]}
    ports.publish_shopping_question.assert_not_awaited()
    ports.save_active_shopping.assert_not_awaited()


@pytest.mark.parametrize(
    "blocks", [(), (AssistantBlock(kind="text", text="Found rings"),)]
)
def test_completion_updates_the_shared_metadata_without_replacing_it(blocks):
    original = {"route_reason": "language_engine_search"}
    response, _ = coordinator(metadata=original)
    result = asyncio.run(
        response.handle(
            RuntimeEvent(
                "completed",
                answer=Answer(
                    "ignored completed text",
                    ("source",),
                    Usage(4, 2, 6),
                    3,
                    "m" * 120,
                    blocks,
                    "read_result",
                ),
            )
        )
    )
    assert response.metadata is original
    assert response.metadata == {
        "route_reason": "language_engine_search",
        "completion_evidence": "read_result",
        "model": "m" * 100,
        "provider": "test-provider",
        "input_tokens": 4,
        "output_tokens": 2,
        "tool_calls": 3,
        "retrieval_count": 1,
    }
    assert result == (
        RuntimeResponse(
            "content.blocks", {"blocks": [{"kind": "text", "text": "Found rings"}]}
        )
        if blocks
        else None
    )


def test_invalid_blocks_fail_after_completion_metadata_without_a_response():
    response, _ = coordinator()
    with pytest.raises(ValueError, match="Invalid block count"):
        asyncio.run(
            response.handle(
                RuntimeEvent(
                    "completed",
                    answer=Answer(
                        "",
                        (),
                        Usage(0, 0, 0),
                        0,
                        "model",
                        (AssistantBlock(kind="text", text="x"),) * 9,
                        "read_result",
                    ),
                )
            )
        )
    assert response.metadata["completion_evidence"] == "read_result"
    assert response.metadata["model"] == "model"


def test_text_limit_is_cumulative_characters_and_precedes_publication():
    response, ports = coordinator()

    async def scenario():
        for text in ("é" * 4000, "x" * 4000):
            assert await response.handle(
                RuntimeEvent("text_delta", text)
            ) == RuntimeResponse("message.delta", {"text": text})
            await response.handle(RuntimeEvent("tool_completed"))
        with pytest.raises(ToolUnavailable):
            await response.handle(
                RuntimeEvent("text_delta", "x", pending_shopping=question())
            )

    asyncio.run(scenario())
    ports.publish_shopping_question.assert_not_awaited()
    assert "completion_disposition" not in response.metadata


@pytest.mark.parametrize("owner", [SCOPE.owner_id, SCOPE.session_id])
@pytest.mark.parametrize(
    "mode", ["published", "rejected", "missing", "no_conversation", "no_revision"]
)
def test_question_is_resumable_only_after_successful_scoped_publication(owner, mode):
    scope = replace(SCOPE, owner_id=owner)
    if mode == "no_conversation":
        scope = replace(scope, conversation_id=None)
    if mode == "no_revision":
        scope = replace(scope, request_revision=None)
    response, ports = coordinator(scope=scope, publisher=mode != "missing")
    ports.publish_shopping_question.return_value = mode == "published"
    plan = question()
    result = asyncio.run(
        response.handle(
            RuntimeEvent(
                "text_delta",
                plan.question,
                pending_shopping=plan,
                shopping_frame=plan.frame,
                shopping_revision="catalog-v1",
                clarification="legacy",
            )
        )
    )
    assert result.kind == "message.delta" and result.fields["text"] == plan.question
    assert ("clarification" in result.fields) is (mode == "published")
    assert response.metadata == {
        "completion_disposition": "clarification",
        "clarification_slot": "style",
    }
    if mode in {"published", "rejected"}:
        ports.publish_shopping_question.assert_awaited_once_with(
            scope.tenant_id,
            owner,
            scope.conversation_id,
            scope.request_revision,
            scope.message,
            plan,
            store_id=scope.store_id,
            session_id=scope.session_id,
        )
    else:
        ports.publish_shopping_question.assert_not_awaited()
    ports.save_active_shopping.assert_not_awaited()  # Pending question takes precedence.
    if mode == "published":
        assert result.fields["clarification"] == {
            "original_message": scope.message,
            "question": plan.question,
            "revision": scope.request_revision,
            "kind": "shopping",
            "choices": ["Classic", "Statement"],
            "optional": True,
        }


@pytest.mark.parametrize(
    "mode",
    ["saved", "rejected", "missing", "no_conversation", "no_revision", "no_descriptor"],
)
def test_active_search_save_uses_exact_scope_and_does_not_suppress_text_on_rejection(
    mode,
):
    scope = (
        replace(SCOPE, conversation_id=None)
        if mode == "no_conversation"
        else replace(SCOPE, request_revision=None)
        if mode == "no_revision"
        else SCOPE
    )
    response, ports = coordinator(scope=scope, writer=mode != "missing")
    ports.save_active_shopping.return_value = mode == "saved"
    plan = question()
    result = asyncio.run(
        response.handle(
            RuntimeEvent(
                "text_delta",
                "Results",
                shopping_frame=plan.frame,
                shopping_revision=None if mode == "no_descriptor" else "catalog-v1",
            )
        )
    )
    assert result == RuntimeResponse("message.delta", {"text": "Results"})
    if mode in {"saved", "rejected"}:
        args, kwargs = ports.save_active_shopping.await_args
        assert args[:5] == (
            scope.tenant_id,
            scope.owner_id,
            scope.conversation_id,
            scope.request_revision,
            scope.message,
        )
        assert (
            args[5].frame == plan.frame and args[5].descriptor_revision == "catalog-v1"
        )
        assert kwargs == {"store_id": scope.store_id, "session_id": scope.session_id}
        ports.save_active_shopping.assert_awaited_once()
    else:
        ports.save_active_shopping.assert_not_awaited()
    ports.publish_shopping_question.assert_not_awaited()


def test_legacy_clarification_keeps_ordinary_fields_without_publication():
    response, ports = coordinator()
    result = asyncio.run(
        response.handle(
            RuntimeEvent("text_delta", "Which color?", clarification="color")
        )
    )
    assert result == RuntimeResponse(
        "message.delta",
        {
            "text": "Which color?",
            "clarification": {
                "original_message": SCOPE.message,
                "question": "Which color?",
            },
        },
    )
    assert response.metadata == {
        "completion_disposition": "clarification",
        "clarification_slot": "color",
    }
    ports.publish_shopping_question.assert_not_awaited()


@pytest.mark.parametrize(
    "operation", ["publish_shopping_question", "save_active_shopping"]
)
@pytest.mark.parametrize("failure_type", [ToolUnavailable, ToolDenied])
def test_publication_failure_propagates_before_text_or_clarification_metadata(
    operation, failure_type
):
    response, ports = coordinator(metadata={"previous": True})
    failure = failure_type()
    getattr(ports, operation).side_effect = failure
    plan = question()
    event = (
        RuntimeEvent("text_delta", "Reply", pending_shopping=plan)
        if operation == "publish_shopping_question"
        else RuntimeEvent(
            "text_delta",
            "Reply",
            shopping_frame=plan.frame,
            shopping_revision="catalog-v1",
        )
    )
    with pytest.raises(failure_type) as caught:
        asyncio.run(response.handle(event))
    assert caught.value is failure
    getattr(ports, operation).assert_awaited_once()
    assert response.metadata == {"previous": True}


def test_cancellation_waiting_for_publication_never_produces_a_response_or_retry():
    response, ports = coordinator()

    async def scenario():
        entered, stopped = asyncio.Event(), asyncio.Event()

        async def publish(*args, **kwargs):
            entered.set()
            try:
                await asyncio.Future()
            finally:
                stopped.set()

        ports.publish_shopping_question.side_effect = publish
        task = asyncio.create_task(
            response.handle(
                RuntimeEvent("text_delta", "Question", pending_shopping=question())
            )
        )
        await asyncio.wait_for(entered.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert stopped.is_set()

    asyncio.run(scenario())
    ports.publish_shopping_question.assert_awaited_once()
    ports.save_active_shopping.assert_not_awaited()
    assert response.metadata == {}
