"""Continuation coordination preserves scoped claims before ordinary turn admission."""

import asyncio
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import pytest
from test_active_shopping import state
from test_shopping_clarifications import question

from app.commerce_action_engine.application.persistence import (
    ActiveShoppingState,
    ShoppingPersistence,
    ShoppingQuestionState,
)
from app.commerce_action_engine.application.shopping_continuation import (
    ShoppingContinuationScope,
    ShoppingFresh,
    ShoppingResume,
    ShoppingStop,
    resolve_shopping_continuation,
)
from app.commerce_action_engine.contracts import AssistantChatInput

TENANT, OWNER, CONVERSATION, STORE, SESSION, REVISION, CLAIM = (
    UUID(int=i) for i in range(1, 8)
)
SCOPE = ShoppingContinuationScope(TENANT, OWNER, STORE, SESSION)
ORIGINAL = "find luxury rings"


def body(message="Classic", *, explicit=True, **updates):
    return AssistantChatInput.model_validate(
        {
            "request_id": UUID(int=10),
            "message": message,
            "conversation_id": CONVERSATION,
            "clarification": {
                "kind": "shopping",
                "revision": REVISION,
                "original_message": ORIGINAL,
                "question": question().question,
                "choices": ["untrusted browser choice"],
            }
            if explicit
            else None,
            **updates,
        }
    )


def storage(*, pending=True, active=False):
    ports = SimpleNamespace(
        shopping_question=AsyncMock(
            return_value=ShoppingQuestionState(REVISION, ORIGINAL, question())
            if pending
            else None
        ),
        claim_shopping_question=AsyncMock(return_value=CLAIM),
        shopping_active=AsyncMock(
            return_value=ActiveShoppingState(REVISION, ORIGINAL, state())
            if active
            else None
        ),
        claim_active_shopping=AsyncMock(return_value=CLAIM),
        publish_shopping_question=AsyncMock(return_value=True),
    )
    return (
        ShoppingPersistence(
            questions=ports,
            question_claims=ports,
            publication=ports,
            active=ports,
            active_claims=ports,
        ),
        ports,
    )


def resolve(request, persistence, *, scope=SCOPE, has_catalog=True):
    return asyncio.run(
        resolve_shopping_continuation(
            request, scope=scope, storage=persistence, has_catalog=has_catalog
        )
    )


@pytest.mark.parametrize("owner", [OWNER, SESSION])
def test_pending_question_wins_and_claims_exact_owner_bound_server_state(owner):
    persistence, ports = storage(active=True)
    scope = replace(SCOPE, owner_id=owner)
    request = body()
    result = resolve(request, persistence, scope=scope)
    assert isinstance(result, ShoppingResume)
    assert result.request_revision == CLAIM and result.clear_clarification
    assert (
        result.original_message == ORIGINAL
        and result.descriptor_revision == "catalog-v1"
    )
    assert result.route_reason == "shopping_clarification_reply"
    assert result.frame.attributes[-1].value == "classic"
    assert request.message == "Classic" and request.clarification is not None
    ports.shopping_question.assert_awaited_once_with(
        TENANT,
        owner,
        CONVERSATION,
        store_id=STORE,
        session_id=SESSION,
        revision=REVISION,
        original=ORIGINAL,
        question=question().question,
    )
    ports.claim_shopping_question.assert_awaited_once_with(
        TENANT,
        owner,
        CONVERSATION,
        store_id=STORE,
        session_id=SESSION,
        revision=REVISION,
        original=ORIGINAL,
        question=question().question,
    )
    ports.shopping_active.assert_not_awaited()
    ports.claim_active_shopping.assert_not_awaited()
    ports.publish_shopping_question.assert_not_awaited()


@pytest.mark.parametrize(
    "missing", ["reader", "conversation", "catalog", "product", "revision", "pending"]
)
def test_explicit_stale_context_never_falls_through_to_active_search(missing):
    persistence, ports = storage(pending=missing != "pending", active=True)
    request = body()
    if missing == "reader":
        persistence = replace(persistence, questions=None)
    if missing == "conversation":
        request.conversation_id = None
    if missing == "product":
        request.product_id = UUID(int=20)
    if missing == "revision":
        request.clarification.revision = None
    result = resolve(request, persistence, has_catalog=missing != "catalog")
    assert isinstance(result, ShoppingStop)
    assert result.route_reason == "stale_shopping_clarification"
    assert result.disposition == "unverified" and result.prompt is None
    ports.claim_shopping_question.assert_not_awaited()
    ports.shopping_active.assert_not_awaited()
    ports.claim_active_shopping.assert_not_awaited()


@pytest.mark.parametrize("available", [False, True])
def test_question_without_successful_claim_cannot_resume_or_fall_back(available):
    persistence, ports = storage(active=True)
    if available:
        ports.claim_shopping_question.return_value = None
    else:
        persistence = replace(persistence, question_claims=None)
    result = resolve(body(), persistence)
    assert isinstance(result, ShoppingStop)
    assert result.route_reason == "stale_shopping_clarification"
    assert ports.claim_shopping_question.await_count == int(available)
    ports.shopping_active.assert_not_awaited()


@pytest.mark.parametrize(
    "message,explicit",
    [("unknown value", True), ("unknown value", False), ("add a ring to cart", True)],
)
def test_invalid_and_fresh_replies_do_not_consume_the_issued_question(
    message, explicit
):
    persistence, ports = storage()
    result = resolve(body(message, explicit=explicit), persistence)
    if explicit and message == "unknown value":
        assert isinstance(result, ShoppingStop)
        assert result.route_reason == "shopping_clarification_invalid_reply"
        assert result.disposition == "clarification" and result.prompt is not None
        assert (
            result.prompt.revision == REVISION
            and result.prompt.original_message == ORIGINAL
        )
        assert result.prompt.plan.question in result.text
    else:
        assert isinstance(result, ShoppingFresh) and result.clear_clarification
    ports.claim_shopping_question.assert_not_awaited()
    ports.shopping_active.assert_not_awaited()


@pytest.mark.parametrize("publication", ["missing", "rejected", "published"])
def test_ambiguous_active_facet_claims_once_and_exposes_only_published_question(
    publication,
):
    persistence, ports = storage(pending=False, active=True)
    if publication == "missing":
        persistence = replace(persistence, publication=None)
    ports.publish_shopping_question.return_value = publication == "published"
    result = resolve(body("Gold", explicit=False), persistence)
    assert isinstance(result, ShoppingStop)
    assert result.route_reason == "active_shopping_ambiguous_facet"
    assert result.disposition == "clarification"
    assert (result.prompt is not None) == (publication == "published")
    ports.claim_active_shopping.assert_awaited_once_with(
        TENANT,
        OWNER,
        CONVERSATION,
        store_id=STORE,
        session_id=SESSION,
        revision=REVISION,
    )
    assert ports.publish_shopping_question.await_count == int(publication != "missing")
    if publication != "missing":
        args, kwargs = ports.publish_shopping_question.await_args
        assert args[:5] == (TENANT, OWNER, CONVERSATION, CLAIM, ORIGINAL)
        assert args[5].question == result.text
        assert kwargs == {"store_id": STORE, "session_id": SESSION}
    if result.prompt:
        assert result.prompt.revision == CLAIM
        assert [choice.field for choice in result.prompt.plan.choices] == [
            "metal",
            "color",
        ]
    ports.claim_shopping_question.assert_not_awaited()


def test_active_search_can_resume_without_question_reader_or_publisher():
    persistence, ports = storage(pending=False, active=True)
    persistence = replace(persistence, questions=None, publication=None)
    result = resolve(body("Titanium", explicit=False), persistence)
    assert isinstance(result, ShoppingResume)
    assert (
        result.route_reason == "active_shopping_reply"
        and not result.clear_clarification
    )
    assert (
        result.request_revision == CLAIM and result.descriptor_revision == "schema-v1"
    )
    assert result.frame.attributes[-1].name == "material"
    ports.shopping_question.assert_not_awaited()
    ports.shopping_active.assert_awaited_once_with(
        TENANT,
        OWNER,
        CONVERSATION,
        store_id=STORE,
        session_id=SESSION,
    )
    ports.claim_active_shopping.assert_awaited_once()
    ports.publish_shopping_question.assert_not_awaited()


def test_active_conflict_does_not_consume_or_replace_existing_search():
    persistence, ports = storage(pending=False, active=True)
    result = resolve(body("under $50", explicit=False), persistence)
    assert isinstance(result, ShoppingStop)
    assert result.route_reason == "active_shopping_conflicting_reply"
    assert result.disposition == "unverified" and result.prompt is None
    ports.claim_active_shopping.assert_not_awaited()
    ports.publish_shopping_question.assert_not_awaited()


@pytest.mark.parametrize("available", [False, True])
def test_active_reply_requires_successful_claim_before_publication(available):
    persistence, ports = storage(pending=False, active=True)
    if available:
        ports.claim_active_shopping.return_value = None
    else:
        persistence = replace(persistence, active_claims=None)
    result = resolve(body("Gold", explicit=False), persistence)
    assert (
        isinstance(result, ShoppingStop)
        and result.route_reason == "stale_active_shopping"
    )
    assert ports.claim_active_shopping.await_count == int(available)
    ports.publish_shopping_question.assert_not_awaited()


@pytest.mark.parametrize(
    "step",
    [
        "shopping_question",
        "claim_shopping_question",
        "shopping_active",
        "claim_active_shopping",
        "publish_shopping_question",
    ],
)
def test_cancellation_propagates_at_each_storage_boundary_without_retry(step):
    async def run():
        active_path = step in {
            "shopping_active",
            "claim_active_shopping",
            "publish_shopping_question",
        }
        persistence, ports = storage(pending=not active_path, active=active_path)
        request = body("Gold" if active_path else "Classic", explicit=not active_path)
        entered, closed = asyncio.Event(), asyncio.Event()

        async def blocked(*args, **kwargs):
            entered.set()
            try:
                await asyncio.Future()
            finally:
                closed.set()

        getattr(ports, step).side_effect = blocked
        task = asyncio.create_task(
            resolve_shopping_continuation(
                request,
                scope=SCOPE,
                storage=persistence,
                has_catalog=True,
            )
        )
        await asyncio.wait_for(entered.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert closed.is_set()
        assert all(operation.await_count <= 1 for operation in vars(ports).values())
        if step != "publish_shopping_question":
            ports.publish_shopping_question.assert_not_awaited()
        if step == "shopping_question":
            ports.claim_shopping_question.assert_not_awaited()
            ports.shopping_active.assert_not_awaited()
        if step == "shopping_active":
            ports.claim_active_shopping.assert_not_awaited()

    asyncio.run(run())
