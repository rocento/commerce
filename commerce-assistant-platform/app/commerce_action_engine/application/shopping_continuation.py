"""Resolve one server-owned shopping continuation before ordinary turn admission.

Reads, claims and publication stay independently optional. A successful claim is
never repeated, including when publication fails or the request is cancelled.
The caller owns request replacement, output metadata and streaming lifetime.
"""

from dataclasses import dataclass, field
from typing import Literal
from uuid import UUID

from app.commerce_action_engine.actions.shopping.continuation import (
    resolve_active_reply,
)
from app.commerce_action_engine.actions.shopping.contracts import (
    ShoppingClarification,
    ShoppingIntent,
)
from app.commerce_action_engine.application.persistence import (
    ActiveShoppingState,
    ShoppingPersistence,
    ShoppingQuestionState,
)
from app.commerce_action_engine.contracts import AssistantChatInput
from app.commerce_action_engine.execution.language.shopping_reply import (
    resolve_shopping_reply,
)


@dataclass(frozen=True)
class ShoppingContinuationScope:
    tenant_id: UUID
    owner_id: UUID
    store_id: UUID
    session_id: UUID


@dataclass(frozen=True)
class ShoppingPrompt:
    original_message: str
    revision: UUID
    plan: ShoppingClarification


@dataclass(frozen=True)
class ShoppingFresh:
    clear_clarification: bool = False
    status: Literal["fresh"] = field(default="fresh", init=False)


@dataclass(frozen=True)
class ShoppingResume:
    original_message: str
    frame: ShoppingIntent
    descriptor_revision: str
    question: ShoppingClarification
    request_revision: UUID
    route_reason: Literal["active_shopping_reply", "shopping_clarification_reply"]
    clear_clarification: bool
    status: Literal["resume"] = field(default="resume", init=False)


@dataclass(frozen=True)
class ShoppingStop:
    text: str
    route_reason: Literal[
        "stale_shopping_clarification",
        "active_shopping_conflicting_reply",
        "stale_active_shopping",
        "active_shopping_ambiguous_facet",
        "shopping_clarification_invalid_reply",
    ]
    disposition: Literal["unverified", "clarification"]
    prompt: ShoppingPrompt | None = None
    status: Literal["stop"] = field(default="stop", init=False)


type ShoppingContinuation = ShoppingFresh | ShoppingResume | ShoppingStop


def _stale_question() -> ShoppingStop:
    return ShoppingStop(
        "These product choices have expired or were replaced. Please send the complete product request again.",
        "stale_shopping_clarification",
        "unverified",
    )


async def _resume_question(
    pending: ShoppingQuestionState,
    message: str,
    conversation_id: UUID,
    *,
    explicit: bool,
    scope: ShoppingContinuationScope,
    storage: ShoppingPersistence,
) -> ShoppingContinuation:
    reply = resolve_shopping_reply(pending.plan, message)
    if reply.frame is not None:
        revision = (
            await storage.question_claims.claim_shopping_question(
                scope.tenant_id,
                scope.owner_id,
                conversation_id,
                store_id=scope.store_id,
                session_id=scope.session_id,
                revision=pending.revision,
                original=pending.original_message,
                question=pending.plan.question,
            )
            if storage.question_claims is not None
            else None
        )
        if revision is None:
            return _stale_question()
        return ShoppingResume(
            original_message=pending.original_message,
            frame=reply.frame,
            descriptor_revision=pending.plan.descriptor_revision,
            question=pending.plan,
            request_revision=revision,
            route_reason="shopping_clarification_reply",
            clear_clarification=True,
        )
    if reply.fresh_request or not explicit:
        return ShoppingFresh(clear_clarification=True)
    return ShoppingStop(
        (reply.error or "Please choose an available option.")
        + " "
        + pending.plan.question,
        "shopping_clarification_invalid_reply",
        "clarification",
        ShoppingPrompt(pending.original_message, pending.revision, pending.plan),
    )


async def _resume_active(
    active: ActiveShoppingState,
    message: str,
    conversation_id: UUID,
    *,
    scope: ShoppingContinuationScope,
    storage: ShoppingPersistence,
) -> ShoppingContinuation:
    reply = resolve_active_reply(active.active, message)
    if reply.error:
        return ShoppingStop(
            reply.error, "active_shopping_conflicting_reply", "unverified"
        )
    if reply.frame is None and reply.question is None:
        return ShoppingFresh()
    revision = (
        await storage.active_claims.claim_active_shopping(
            scope.tenant_id,
            scope.owner_id,
            conversation_id,
            store_id=scope.store_id,
            session_id=scope.session_id,
            revision=active.revision,
        )
        if storage.active_claims is not None
        else None
    )
    if revision is None:
        return ShoppingStop(
            "The previous search has expired or changed. Please send the complete product request again.",
            "stale_active_shopping",
            "unverified",
        )
    if reply.question is not None:
        published = (
            storage.publication is not None
            and await storage.publication.publish_shopping_question(
                scope.tenant_id,
                scope.owner_id,
                conversation_id,
                revision,
                active.original_message,
                reply.question,
                store_id=scope.store_id,
                session_id=scope.session_id,
            )
        )
        return ShoppingStop(
            reply.question.question,
            "active_shopping_ambiguous_facet",
            "clarification",
            ShoppingPrompt(active.original_message, revision, reply.question)
            if published
            else None,
        )
    assert reply.frame is not None and reply.plan is not None
    return ShoppingResume(
        original_message=active.original_message,
        frame=reply.frame,
        descriptor_revision=active.active.descriptor_revision,
        question=reply.plan,
        request_revision=revision,
        route_reason="active_shopping_reply",
        clear_clarification=False,
    )


async def resolve_shopping_continuation(
    body: AssistantChatInput,
    *,
    scope: ShoppingContinuationScope,
    storage: ShoppingPersistence,
    has_catalog: bool,
) -> ShoppingContinuation:
    context = (
        body.clarification
        if body.clarification and body.clarification.kind == "shopping"
        else None
    )
    explicit = context is not None
    eligible = has_catalog and not (
        body.ticket or body.product_id or body.order_id or body.cart_context
    )
    pending = None
    if (
        storage.questions is not None
        and body.conversation_id
        and eligible
        and (explicit or body.clarification is None)
    ):
        pending = await storage.questions.shopping_question(
            scope.tenant_id,
            scope.owner_id,
            body.conversation_id,
            store_id=scope.store_id,
            session_id=scope.session_id,
            revision=context.revision if context else None,
            original=context.original_message if context else None,
            question=context.question if context else None,
        )
    if context and (not context.revision or pending is None):
        return _stale_question()
    if pending is not None and body.conversation_id is not None:
        return await _resume_question(
            pending,
            body.message,
            body.conversation_id,
            explicit=explicit,
            scope=scope,
            storage=storage,
        )
    if (
        not explicit
        and body.clarification is None
        and body.conversation_id
        and eligible
        and storage.active is not None
    ):
        active = await storage.active.shopping_active(
            scope.tenant_id,
            scope.owner_id,
            body.conversation_id,
            store_id=scope.store_id,
            session_id=scope.session_id,
        )
        if active is not None:
            return await _resume_active(
                active,
                body.message,
                body.conversation_id,
                scope=scope,
                storage=storage,
            )
    return ShoppingFresh()
