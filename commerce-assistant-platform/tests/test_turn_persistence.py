"""Prepared persistence capabilities retain independent admission and scoped IO."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import pytest
from test_active_shopping import state
from test_compound_planning import prepared as compound_plan
from test_shopping_clarifications import question

from app.commerce_action_engine.application.persistence import TurnPersistence
from app.commerce_action_engine.application.persistence_binding import bind_persistence
from app.commerce_action_engine.application.turn_dependencies import PreparedTurn
from app.commerce_action_engine.platform.store import Store

SCOPE = tuple(UUID(int=i) for i in range(1, 4))
STORE, SESSION, REVISION = (UUID(int=i) for i in range(4, 7))


def prepare_with(store, persistence=None):
    # Unused turn services remain placeholders: preparation must not call them.
    return PreparedTurn(
        context=None,
        config=None,
        active_config=None,
        caller=None,
        runtime=None,
        has_catalog=False,
        provider=None,
        fallback_model_configured=False,
        tracked={},
        store=store,
        core_facade=None,
        policy_answers=None,
        intent_frame=None,
        address_request=False,
        commerce_tools=None,
        begin_memory=None,
        bind_runtime=None,
        record_trace=None,
        lease=None,
        persistence=persistence,
    )


def test_direct_turn_preparation_binds_legacy_partial_storage():
    store = SimpleNamespace(begin_request=AsyncMock())
    prepared = prepare_with(store)
    assert prepared.persistence.revisions is store
    assert prepared.persistence.shopping == TurnPersistence().shopping
    store.begin_request.assert_not_awaited()


def test_explicit_turn_capabilities_are_not_replaced_by_legacy_storage():
    store = SimpleNamespace(begin_request=AsyncMock())
    disabled = TurnPersistence()
    prepared = prepare_with(store, disabled)
    assert prepared.persistence is disabled
    assert prepared.persistence.revisions is None
    store.begin_request.assert_not_awaited()


@pytest.mark.parametrize("store", [None, object(), SimpleNamespace()])
def test_absent_optional_storage_does_not_create_capabilities(store):
    assert bind_persistence(store) == TurnPersistence()


def test_production_store_binds_all_capabilities_without_opening_database():
    # Binding inspects interfaces only; an uninitialized instance has no pool.
    store = object.__new__(Store)
    bound = bind_persistence(store)
    assert bound.revisions is store and bound.questions is store
    assert bound.completion is store and bound.tracking is store
    assert bound.shopping.questions is not None
    assert bound.shopping.active is not None
    assert bound.shopping.question_claims is store
    assert bound.shopping.publication is store
    assert bound.shopping.active_claims is store
    assert bound.shopping.active_publication is store
    assert bound.compound.reader is store and bound.compound.outcomes is store
    assert bound.compound.plans is not None and bound.compound.execution is not None


def test_partial_publication_adapter_does_not_require_reader_or_claims():
    store = SimpleNamespace(publish_shopping_question=AsyncMock(return_value=True))
    bound = bind_persistence(store)
    assert bound.shopping.publication is store
    assert bound.shopping.questions is None
    assert bound.shopping.question_claims is None
    assert bound.revisions is None
    store.publish_shopping_question.assert_not_awaited()


def test_disabled_noncallable_operations_are_not_admitted():
    store = SimpleNamespace(
        shopping_question=None,
        claim_shopping_question=False,
        publish_shopping_question=42,
        shopping_active=None,
        begin_request=None,
        get_compound_plan=False,
        transition_compound=None,
    )
    assert bind_persistence(store) == TurnPersistence()


def test_pending_read_retains_scope_and_typed_frame_without_claiming():
    plan = question()
    store = SimpleNamespace(
        shopping_question=AsyncMock(
            return_value={
                "revision": REVISION,
                "original_message": "find rings",
                "plan": plan,
            }
        ),
        claim_shopping_question=AsyncMock(),
    )
    bound = bind_persistence(store)
    result = asyncio.run(
        bound.shopping.questions.shopping_question(
            *SCOPE,
            store_id=STORE,
            session_id=SESSION,
            revision=REVISION,
            original="find rings",
            question=plan.question,
        )
    )
    assert result.revision == REVISION
    assert result.original_message == "find rings" and result.plan is plan
    store.shopping_question.assert_awaited_once_with(
        *SCOPE,
        store_id=STORE,
        session_id=SESSION,
        revision=REVISION,
        original="find rings",
        question=plan.question,
    )
    store.claim_shopping_question.assert_not_awaited()


def test_active_read_retains_scope_revision_and_original_frame():
    active = state()
    store = SimpleNamespace(
        shopping_active=AsyncMock(
            return_value={
                "revision": REVISION,
                "original_message": "find rings",
                "active": active,
            }
        )
    )
    result = asyncio.run(
        bind_persistence(store).shopping.active.shopping_active(
            *SCOPE,
            store_id=STORE,
            session_id=SESSION,
        )
    )
    assert result.revision == REVISION and result.active is active
    assert result.original_message == "find rings"
    store.shopping_active.assert_awaited_once_with(
        *SCOPE,
        store_id=STORE,
        session_id=SESSION,
    )


@pytest.mark.parametrize("missing", [False, True])
def test_missing_or_invalid_pending_state_never_becomes_a_continuation(missing):
    store = SimpleNamespace(
        shopping_question=AsyncMock(
            return_value=None
            if missing
            else {
                "revision": str(REVISION),
                "original_message": "find rings",
                "plan": question(),
            }
        )
    )
    read = bind_persistence(store).shopping.questions.shopping_question
    operation = read(*SCOPE, store_id=STORE, session_id=SESSION)
    if missing:
        assert asyncio.run(operation) is None
    else:
        with pytest.raises(TypeError, match="invalid_shopping_question_record"):
            asyncio.run(operation)
    store.shopping_question.assert_awaited_once()


def test_question_read_cancellation_propagates_without_retry():
    async def scenario():
        entered, stopped = asyncio.Event(), asyncio.Event()

        async def read(*args, **kwargs):
            entered.set()
            try:
                await asyncio.Future()
            finally:
                stopped.set()

        store = SimpleNamespace(shopping_question=AsyncMock(side_effect=read))
        bound = bind_persistence(store)
        task = asyncio.create_task(
            bound.shopping.questions.shopping_question(
                *SCOPE,
                store_id=STORE,
                session_id=SESSION,
            )
        )
        await asyncio.wait_for(entered.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert stopped.is_set()
        store.shopping_question.assert_awaited_once()

    asyncio.run(scenario())


def test_save_only_compound_adapter_can_publish_without_recovery_or_execution():
    plan = compound_plan()
    store = SimpleNamespace(save_compound_plan=AsyncMock(return_value=plan))
    bound = bind_persistence(store)
    assert bound.compound.reader is None
    assert bound.compound.execution is None
    assert asyncio.run(bound.compound.plans.save_compound_plan(plan)) is plan
    store.save_compound_plan.assert_awaited_once_with(plan)


def test_transition_only_compound_adapter_preserves_receipt_arguments():
    plan = compound_plan()
    store = SimpleNamespace(transition_compound=AsyncMock(return_value=plan))
    bound = bind_persistence(store)
    assert bound.compound.reader is None and bound.compound.plans is None
    result = asyncio.run(
        bound.compound.execution.transition_compound(
            plan.scope, plan.request_id, plan.actions[0].id, transition="stop"
        )
    )
    assert result is plan
    store.transition_compound.assert_awaited_once_with(
        plan.scope, plan.request_id, plan.actions[0].id, transition="stop", receipt=None
    )
    with pytest.raises(RuntimeError, match="compound_read_unavailable"):
        asyncio.run(
            bound.compound.execution.get_compound_plan(
                plan.scope, plan.request_id, plan.input_hash
            )
        )
    store.transition_compound.assert_awaited_once()
