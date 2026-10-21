"""Admission preserves UNKNOWN permits, dependency order and partial progress."""

import asyncio
from dataclasses import replace
from unittest.mock import AsyncMock, Mock
from uuid import UUID

import pytest
from test_assistant import identity as identity  # noqa: PLC0414
from test_enterprise_contracts import context as context  # noqa: PLC0414
from test_language_fallback import proposal, resolved, unknown

from app.commerce_action_engine.application import language_admission as admission
from app.commerce_action_engine.application import language_proposals, semantic_recovery
from app.commerce_action_engine.application.interpretation import interpret_resolution
from app.commerce_action_engine.contracts import AssistantChatInput
from app.commerce_action_engine.execution.language import gate
from app.commerce_resolution_engine.admission import (
    install_permit,
    issue_unknown_permit,
    require_permit,
    reset_permit,
)
from app.commerce_resolution_engine.contracts import ModelError


def setup(identity, context, **config_changes):
    config = replace(identity[0], **config_changes)
    state = admission.LanguageAdmissionState(
        AssistantChatInput(
            request_id=context.actor.request_id, message="show my basket"
        )
    )
    model = Mock()
    ports = admission.LanguageAdmissionPorts(
        context=context,
        config=config,
        tenant_id=UUID(config.tenant_id),
        models={"default": model},
        budget=AsyncMock(),
        retrieve_intent_examples=AsyncMock(return_value=()),
        select_provider=Mock(return_value=model),
    )
    ports.budget.model_budget_available.return_value = True
    return state, ports


@pytest.mark.parametrize(
    "source",
    [None, resolved(), resolved(status="DENIED"), resolved(status="NEEDS_CONTEXT")],
)
def test_only_unknown_can_reach_budget_retrieval_or_model(
    identity, context, monkeypatch, source
):
    state, ports = setup(identity, context, intent_example_collection="examples")
    monkeypatch.setattr(gate, "resolve", AsyncMock(return_value=source))
    generate = AsyncMock()
    monkeypatch.setattr(admission, "propose_language", generate)

    async def scenario():
        try:
            assert (
                await admission.admit_language(
                    state, ports=ports, history=(), metadata={}
                )
                is None
            )
            with pytest.raises(PermissionError):
                require_permit(state.body.request_id)
        finally:
            state.close()

    asyncio.run(scenario())
    ports.budget.model_budget_available.assert_not_awaited()
    ports.retrieve_intent_examples.assert_not_awaited()
    ports.select_provider.assert_not_called()
    generate.assert_not_awaited()
    assert not state.language_fallback


def test_proposal_permission_is_revoked_before_revalidation_and_outer_context_restored(
    identity, context, monkeypatch
):
    state, ports = setup(identity, context)
    monkeypatch.setattr(gate, "resolve", AsyncMock(return_value=unknown()))
    order = []

    async def generate(*args, **kwargs):
        require_permit(state.body.request_id)
        order.append("proposal")
        return proposal()

    async def accept(*args, **kwargs):
        with pytest.raises(PermissionError):
            require_permit(state.body.request_id)
        order.append("revalidation")
        return interpret_resolution(resolved(), context)

    monkeypatch.setattr(admission, "propose_language", generate)
    monkeypatch.setattr(language_proposals, "accept_proposal", accept)
    metadata = {}

    async def scenario():
        parent_id = UUID(int=99)
        token = install_permit(issue_unknown_permit("UNKNOWN", parent_id))
        try:
            try:
                await admission.admit_language(
                    state, ports=ports, history=(), metadata=metadata
                )
                with pytest.raises(PermissionError):
                    require_permit(state.body.request_id)
            finally:
                state.close()
            require_permit(parent_id)
            state.close()  # Final cleanup is idempotent.
            require_permit(parent_id)
        finally:
            reset_permit(token)

    asyncio.run(scenario())
    assert order == ["proposal", "revalidation"]
    assert state.gate_route == "cart"
    assert metadata["language_fallback"]["outcome"] == "cart"
    ports.select_provider.assert_called_once_with(ports.models["default"])


def test_budget_stop_precedes_provider_binding_retrieval_and_generation(
    identity, context, monkeypatch
):
    state, ports = setup(identity, context, intent_example_collection="examples")
    ports.budget.model_budget_available.return_value = False
    monkeypatch.setattr(gate, "resolve", AsyncMock(return_value=unknown()))
    generate = AsyncMock()
    monkeypatch.setattr(admission, "propose_language", generate)
    metadata = {}

    async def scenario():
        try:
            result = await admission.admit_language(
                state, ports=ports, history=(), metadata=metadata
            )
            assert isinstance(result, admission.LanguageBudgetBlocked)
        finally:
            state.close()
        with pytest.raises(PermissionError):
            require_permit(state.body.request_id)

    asyncio.run(scenario())
    ports.budget.model_budget_available.assert_awaited_once_with(
        ports.tenant_id,
        None,
        ports.config.model_daily_token_budget,
        ports.config.model_session_token_budget,
    )
    ports.select_provider.assert_not_called()
    ports.retrieve_intent_examples.assert_not_awaited()
    generate.assert_not_awaited()
    assert metadata["budget_blocked"] and state.language_fallback


@pytest.mark.parametrize(
    "failure",
    [
        ModelError("invalid_response"),
        ModelError("unavailable"),
        asyncio.CancelledError(),
    ],
)
def test_proposal_failure_never_revalidates_or_retries_and_revokes_permit(
    identity, context, monkeypatch, failure
):
    state, ports = setup(identity, context)
    monkeypatch.setattr(gate, "resolve", AsyncMock(return_value=unknown()))

    async def fail(*args, **kwargs):
        require_permit(state.body.request_id)
        raise failure

    generate = AsyncMock(side_effect=fail)
    accept = AsyncMock()
    monkeypatch.setattr(admission, "propose_language", generate)
    monkeypatch.setattr(language_proposals, "accept_proposal", accept)
    metadata = {}

    async def scenario():
        try:
            if isinstance(failure, ModelError) and failure.code == "invalid_response":
                await admission.admit_language(
                    state, ports=ports, history=(), metadata=metadata
                )
                assert state.gate_route == "clarify"
                assert metadata["language_fallback"]["outcome"] == "invalid_response"
            else:
                with pytest.raises(type(failure)) as caught:
                    await admission.admit_language(
                        state, ports=ports, history=(), metadata=metadata
                    )
                assert caught.value is failure
            with pytest.raises(PermissionError):
                require_permit(state.body.request_id)
        finally:
            state.close()

    asyncio.run(scenario())
    generate.assert_awaited_once()
    accept.assert_not_awaited()


def test_cancellation_during_retrieval_preserves_clarification_progress_and_cleans_context(
    identity, context, monkeypatch
):
    state, ports = setup(identity, context, intent_example_collection="examples")
    state.body = AssistantChatInput(
        request_id=state.body.request_id,
        message="red",
        clarification={"original_message": "find a shirt", "question": "Which color?"},
    )
    interpreted = interpret_resolution(
        resolved(entities={"recommendationFollowup": "different"}), context
    )
    monkeypatch.setattr(
        admission.followups,
        "resolve_reply",
        AsyncMock(return_value=(interpreted, "find red shirts")),
    )
    recommendation = Mock(
        interpretation=interpret_resolution(unknown(), context),
        original_message="red",
        message="find other red shirts",
    )
    monkeypatch.setattr(
        admission.followups,
        "resolve_recommendation_followup",
        AsyncMock(return_value=recommendation),
    )
    generate = AsyncMock()
    monkeypatch.setattr(admission, "propose_language", generate)
    metadata = {}

    async def scenario():
        entered = asyncio.Event()

        async def retrieve(*args, **kwargs):
            entered.set()
            await asyncio.Future()

        monkeypatch.setattr(semantic_recovery, "retrieve_examples", retrieve)

        async def run():
            try:
                await admission.admit_language(
                    state, ports=ports, history=(), metadata=metadata
                )
            finally:
                state.close()
                with pytest.raises(PermissionError):
                    require_permit(state.body.request_id)

        task = asyncio.create_task(run())
        await asyncio.wait_for(entered.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    assert state.clarification_reply
    assert state.body.message == "find other red shirts"
    assert state.original_followup_message == "red"
    assert state.language_fallback and state.gate_route == "fallback"
    generate.assert_not_awaited()


def test_unconfigured_unknown_clarifies_without_budget_or_model(
    identity, context, monkeypatch
):
    state, ports = setup(identity, context)
    ports = replace(ports, models={})
    monkeypatch.setattr(gate, "resolve", AsyncMock(return_value=unknown()))
    metadata = {}

    async def scenario():
        try:
            await admission.admit_language(
                state, ports=ports, history=(), metadata=metadata
            )
            with pytest.raises(PermissionError):
                require_permit(state.body.request_id)
        finally:
            state.close()

    asyncio.run(scenario())
    assert state.gate_route == "clarify"
    assert metadata["language_fallback"]["outcome"] == "unconfigured"
    ports.select_provider.assert_not_called()
    ports.budget.model_budget_available.assert_not_awaited()
