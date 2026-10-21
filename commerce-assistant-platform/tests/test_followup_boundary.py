"""Untrusted replay responses must cross the standard validation boundary."""

import asyncio

import pytest
from test_enterprise_contracts import context as context  # noqa: PLC0414
from test_language_fallback import resolved

from app.commerce_action_engine.application.followups import (
    resolve_recommendation_followup,
    resolve_reply,
)
from app.commerce_action_engine.application.interpretation import interpret_resolution
from app.commerce_action_engine.contracts.interpretation import InterpretationFailure
from app.commerce_action_engine.execution.language import gate
from app.commerce_resolution_engine.contracts import Message


@pytest.mark.parametrize("phase", ["original", "resumed"])
def test_slot_reply_cancellation_stops_language_work(monkeypatch, context, phase):
    async def scenario():
        started, stopped = asyncio.Event(), asyncio.Event()
        calls = []

        async def resolve(url, text, **kwargs):
            calls.append(text)
            if phase == "resumed" and len(calls) == 1:
                return resolved(
                    status="NEEDS_CONTEXT",
                    intent="ADD_TO_CART",
                    context={
                        "next": {
                            "pendingClarification": {
                                "text": "add to cart",
                                "intent": "ADD_TO_CART",
                                "slot": "product",
                            }
                        }
                    },
                )
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()

        monkeypatch.setattr(gate, "resolve", resolve)
        task = asyncio.create_task(
            resolve_reply("node", "add to cart", "shoes", context=context)
        )
        try:
            await asyncio.wait_for(started.wait(), 1)
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert stopped.is_set()
        assert calls == (
            ["add to cart", "shoes"] if phase == "resumed" else ["add to cart"]
        )

    asyncio.run(scenario())


@pytest.mark.parametrize("phase", ["original", "resumed", "history"])
def test_invalid_replay_blocks_admission(monkeypatch, context, phase):
    invalid = resolved(status="UNKNOWN").model_copy(
        update={"clarificationReply": "true"}
    )
    pending = resolved(
        status="NEEDS_CONTEXT",
        intent="ADD_TO_CART",
        context={
            "next": {
                "pendingClarification": {
                    "text": "add to cart",
                    "intent": "ADD_TO_CART",
                    "slot": "product",
                }
            }
        },
    )
    calls = []

    async def resolve(url, text, **kwargs):
        calls.append(text)
        return pending if phase == "resumed" and len(calls) == 1 else invalid

    monkeypatch.setattr(gate, "resolve", resolve)
    if phase == "history":
        answer = asyncio.run(
            resolve_recommendation_followup(
                "node",
                "something else",
                [
                    Message("user", "find shoes"),
                    Message(
                        "assistant", "/products/00000000-0000-0000-0000-000000000001"
                    ),
                ],
                interpret_resolution(
                    resolved(
                        intent="PRODUCT_RECOMMEND",
                        entities={"recommendationFollowup": "different"},
                    ),
                    context,
                ),
                context=context,
            )
        ).interpretation
    else:
        answer, _ = asyncio.run(
            resolve_reply("node", "add to cart", "shoes", context=context)
        )
    assert isinstance(answer.result, InterpretationFailure)
    assert answer.result.code == "invalid_response"
    assert not hasattr(answer, "resolution")
    assert len(calls) == (2 if phase == "resumed" else 1)


def test_missing_history_does_not_replay(monkeypatch, context):
    async def unexpected(*args, **kwargs):
        pytest.fail("Missing history must not call Node")

    monkeypatch.setattr(gate, "resolve", unexpected)
    answer = asyncio.run(
        resolve_recommendation_followup(
            "node",
            "cheaper options",
            [],
            interpret_resolution(
                resolved(
                    intent="PRODUCT_RECOMMEND",
                    entities={"recommendationFollowup": "cheaper"},
                ),
                context,
            ),
            context=context,
        )
    )
    assert answer.interpretation.result.status == "NEEDS_CONTEXT"
    assert answer.message == "cheaper options"
    assert answer.original_message is None


@pytest.mark.parametrize("failed", [False, True])
def test_replay_reuses_validated_initial_decision(monkeypatch, context, failed):
    from app.commerce_action_engine.application import followups, interpretation

    initial = interpret_resolution(None if failed else resolved(), context)

    def unexpected(*args, **kwargs):
        pytest.fail("Unchanged initial decision must not be revalidated or replayed")

    monkeypatch.setattr(interpretation, "interpret_resolution", unexpected)
    monkeypatch.setattr(followups, "interpret_resolution", unexpected)
    monkeypatch.setattr(gate, "resolve", unexpected)

    async def run():
        search, message = await interpretation.resolve_search_update(
            "node", "hello", [], initial, context=context
        )
        recommendation = await followups.resolve_recommendation_followup(
            "node", "hello", [], initial, context=context
        )
        assert search is initial
        assert recommendation.interpretation is initial
        assert message == recommendation.message == "hello"

    asyncio.run(run())


@pytest.mark.parametrize("status", ["RESOLVED", "DENIED", "UNSUPPORTED"])
def test_standard_followup_edit_applies_holds_without_wire(
    monkeypatch, context, status
):
    from app.commerce_action_engine.application import followups

    initial = interpret_resolution(resolved(status=status), context)
    before = initial.result.model_dump()

    def unexpected(*args, **kwargs):
        pytest.fail("Standard edit must not re-enter wire validation")

    monkeypatch.setattr(followups, "interpret_resolution", unexpected)
    result = followups._Interpreter("node", context).with_entities(
        initial, {"requestConstraints": []}
    )
    assert not hasattr(result, "resolution")
    assert result.result.status == ("NEEDS_CONTEXT" if status == "RESOLVED" else status)
    if status == "RESOLVED":
        assert result.result.confidence.raw == 0
        assert "requestConstraints" in result.result.missing
        assert result.route == "clarify"
    assert initial.result.model_dump() == before


@pytest.mark.parametrize(
    "entities", [{"items": "invalid"}, {"productText": "x" * 262144}]
)
def test_standard_followup_edit_rejects_invalid_items(context, entities):
    from app.commerce_action_engine.application.followups import _Interpreter

    initial = interpret_resolution(resolved(), context)
    result = _Interpreter("node", context).with_entities(initial, entities)
    assert isinstance(result.result, InterpretationFailure)
    assert result.result.code == "invalid_response"
    assert result.route == "unavailable"


def test_standard_clarification_preserves_identity_and_missing_fields(context):
    from app.commerce_action_engine.application.followups import _Interpreter

    initial = interpret_resolution(resolved(), context)
    result = _Interpreter("node", context).clarify(
        initial, "Which item?", missing=["product"]
    )
    assert result.result.request_id == context.actor.request_id
    assert result.result.status == "NEEDS_CONTEXT"
    assert result.result.message == "Which item?"
    assert result.result.missing == ["product"]
    assert result.result.confidence.raw == 0
    assert result.route == "clarify"
