"""Coordinate compound review and saved-plan recovery through scoped ports.

The turn owns streaming, transcript persistence and metadata. Existing compound
journeys retain preparation, action claims, receipt reconciliation and dispatch.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal, Protocol
from uuid import UUID

from app.commerce_action_engine.actions.catalog.bindings import ProductReader
from app.commerce_action_engine.actions.shopping.compound import CompoundWriter
from app.commerce_action_engine.application.handlers import (
    compound as compound_presenter,
)
from app.commerce_action_engine.application.persistence import (
    CompoundPersistence,
    QuestionPublisher,
)
from app.commerce_action_engine.contracts import AssistantBlock
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.planning import compound_review as policy
from app.commerce_action_engine.execution.planning.compound_review import Review
from app.commerce_contracts.agents import Principal
from app.commerce_contracts.compound_plan import CompoundPlan, CompoundScope


class ReceiptedCompoundPort(CompoundWriter, Protocol):
    @property
    def read_token(self) -> str: ...

    @property
    def write_token(self) -> str: ...


class CompoundCommercePort(ProductReader, Protocol):
    @property
    def catalog_capability(self) -> str: ...

    @property
    def compound(self) -> ReceiptedCompoundPort: ...


@dataclass(frozen=True)
class CompoundRequest:
    request_id: UUID
    conversation_id: UUID | None
    revision: UUID | None
    original_input_hash: str
    message: str


@dataclass(frozen=True)
class CompoundPlanView:
    text: str
    plan_id: UUID
    action_states: tuple[str, ...]
    verified_receipts: bool
    choice: AssistantBlock | None


@dataclass(frozen=True)
class NoCompoundRecovery:
    status: Literal["not_recovered"] = field(default="not_recovered", init=False)


@dataclass(frozen=True)
class RecoveredCompound:
    plan: CompoundPlanView
    status: Literal["recovered"] = field(default="recovered", init=False)


@dataclass(frozen=True)
class CompoundReviewOnly:
    status: Literal["review_only"] = field(default="review_only", init=False)


@dataclass(frozen=True)
class PreparedCompound:
    plan: CompoundPlanView
    status: Literal["prepared"] = field(default="prepared", init=False)


@dataclass(frozen=True)
class CompoundPreparationFailed:
    text: str
    status: Literal["preparation_failed"] = field(
        default="preparation_failed", init=False
    )


@dataclass(frozen=True)
class CompoundClarification:
    original_message: str
    question: str
    revision: UUID


type CompoundRecovery = NoCompoundRecovery | RecoveredCompound
type CompoundPreparation = (
    CompoundReviewOnly | PreparedCompound | CompoundPreparationFailed
)


def _plan_view(plan: CompoundPlan, text: str) -> CompoundPlanView:
    return CompoundPlanView(
        text=text,
        plan_id=plan.id,
        action_states=tuple(action.state for action in plan.actions),
        verified_receipts=all(
            action.state == "succeeded" and action.receipt for action in plan.actions
        ),
        choice=compound_presenter.product_choices(plan),
    )


async def recover_compound(
    principal: Principal,
    request: CompoundRequest,
    *,
    storage: CompoundPersistence,
    commerce_tools: Callable[[], CompoundCommercePort],
    store_present: bool,
) -> CompoundRecovery:
    if not (
        store_present
        and storage.reader is not None
        and principal.subject
        and request.conversation_id
    ):
        return NoCompoundRecovery()
    recovered = await storage.reader.get_compound_plan(
        CompoundScope(
            tenant_id=principal.tenant,
            customer_id=principal.subject,
            conversation_id=request.conversation_id,
        ),
        request.request_id,
        request.original_input_hash,
    )
    if recovered is None:
        return NoCompoundRecovery()
    if storage.outcomes is not None and commerce_tools().compound.read_token:
        recovered = await compound_presenter.reconcile(
            recovered, commerce_tools().compound, storage.outcomes
        )
    return RecoveredCompound(
        _plan_view(recovered, compound_presenter.describe(recovered))
    )


def review_compound(request: InterpretedRequest | None) -> Review | None:
    return policy.review(request) if request is not None else None


async def prepare_compound_review(
    review: Review,
    interpretation: InterpretedRequest,
    principal: Principal,
    request: CompoundRequest,
    *,
    storage: CompoundPersistence,
    commerce_tools: Callable[[], CompoundCommercePort],
    store_available: bool,
    planning_enabled: bool,
    execution_enabled: bool,
) -> CompoundPreparation:
    if not (
        review.state == "understood"
        and policy.is_reviewed_pair(interpretation)
        and planning_enabled
        and store_available
        and storage.plans is not None
        and request.revision
        and request.conversation_id
        and commerce_tools().catalog_capability
    ):
        return CompoundReviewOnly()
    text, plan = await compound_presenter.prepare_response(
        interpretation,
        principal,
        commerce_tools(),
        storage.plans,
        conversation=request.conversation_id,
        request=request.request_id,
        revision=request.revision,
        fingerprint=request.original_input_hash,
        writer=commerce_tools().compound
        if (
            execution_enabled
            and commerce_tools().compound.write_token
            and commerce_tools().compound.read_token
            and storage.execution is not None
        )
        else None,
        execution_store=storage.execution,
    )
    if plan is None:
        return CompoundPreparationFailed(text)
    return PreparedCompound(_plan_view(plan, text))


async def publish_compound_clarification(
    review: Review,
    principal: Principal,
    request: CompoundRequest,
    *,
    publisher: QuestionPublisher | None,
    store_available: bool,
) -> CompoundClarification | None:
    if not (
        review.needs_reply
        and request.revision
        and store_available
        and publisher is not None
        and principal.subject
        and request.conversation_id
    ):
        return None
    published = await publisher.publish_question(
        principal.tenant,
        principal.subject,
        request.conversation_id,
        request.revision,
        request.message,
        review.message,
    )
    if not published:
        return None
    return CompoundClarification(request.message, review.message, request.revision)
