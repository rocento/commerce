"""Explicit storage capabilities available to an admitted turn.

Read, claim and publication ports remain independent: a read-only adapter must
never appear to claim a revision, and a publisher need not implement retrieval.
"""

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable
from uuid import UUID

from app.commerce_action_engine.actions.shopping.continuation import ActiveShopping
from app.commerce_action_engine.actions.shopping.contracts import ShoppingClarification
from app.commerce_contracts.compound_plan import CompoundPlan, CompoundScope
from app.commerce_orchestration_engine.journeys.compound import (
    ExecutionStore,
    OutcomeStore,
    PlanStore,
)


@runtime_checkable
class RequestRevisions(Protocol):
    async def begin_request(
        self,
        tenant: UUID,
        customer: UUID,
        conversation: UUID,
        *,
        expected_revision: UUID | None = None,
        original: str = "",
        question: str = "",
    ) -> UUID | None: ...


@runtime_checkable
class QuestionPublisher(Protocol):
    async def publish_question(
        self,
        tenant: UUID,
        customer: UUID,
        conversation: UUID,
        revision: UUID,
        original: str,
        question: str,
    ) -> bool: ...


@dataclass(frozen=True)
class ShoppingQuestionState:
    revision: UUID
    original_message: str
    plan: ShoppingClarification


@dataclass(frozen=True)
class ActiveShoppingState:
    revision: UUID
    original_message: str
    active: ActiveShopping


class ShoppingQuestionReader(Protocol):
    async def shopping_question(
        self,
        tenant: UUID,
        customer: UUID,
        conversation: UUID,
        *,
        store_id: UUID,
        session_id: UUID,
        revision: UUID | None = None,
        original: str | None = None,
        question: str | None = None,
    ) -> ShoppingQuestionState | None: ...


@runtime_checkable
class ShoppingQuestionClaims(Protocol):
    async def claim_shopping_question(
        self,
        tenant: UUID,
        customer: UUID,
        conversation: UUID,
        *,
        store_id: UUID,
        session_id: UUID,
        revision: UUID,
        original: str,
        question: str,
    ) -> UUID | None: ...


@runtime_checkable
class ShoppingQuestionPublisher(Protocol):
    async def publish_shopping_question(
        self,
        tenant: UUID,
        customer: UUID,
        conversation: UUID,
        revision: UUID,
        original: str,
        plan: ShoppingClarification,
        *,
        store_id: UUID,
        session_id: UUID,
    ) -> bool: ...


class ActiveShoppingReader(Protocol):
    async def shopping_active(
        self,
        tenant: UUID,
        customer: UUID,
        conversation: UUID,
        *,
        store_id: UUID,
        session_id: UUID,
    ) -> ActiveShoppingState | None: ...


@runtime_checkable
class ActiveShoppingClaims(Protocol):
    async def claim_active_shopping(
        self,
        tenant: UUID,
        customer: UUID,
        conversation: UUID,
        *,
        store_id: UUID,
        session_id: UUID,
        revision: UUID,
    ) -> UUID | None: ...


@runtime_checkable
class ActiveShoppingWriter(Protocol):
    async def save_active_shopping(
        self,
        tenant: UUID,
        customer: UUID,
        conversation: UUID,
        revision: UUID,
        original: str,
        active: ActiveShopping,
        *,
        store_id: UUID,
        session_id: UUID,
    ) -> bool: ...


@runtime_checkable
class CompletionContextReader(Protocol):
    async def completion_context(
        self,
        tenant: UUID,
        customer: UUID,
        conversation: UUID,
        *,
        expected_question: str | None = None,
    ) -> dict[str, object] | None: ...


@runtime_checkable
class TrackingWriter(Protocol):
    async def save_tracking(
        self, tenant: UUID, request: UUID, document: dict[str, object]
    ) -> None: ...


@runtime_checkable
class CompoundPlanReader(Protocol):
    async def get_compound_plan(
        self, scope: CompoundScope, request: UUID, input_hash: str
    ) -> CompoundPlan | None: ...


@runtime_checkable
class CompoundPlanWriter(Protocol):
    async def save_compound_plan(self, plan: CompoundPlan) -> CompoundPlan | None: ...


@runtime_checkable
class CompoundOutcomes(OutcomeStore, Protocol):
    """Receipt transitions, independently available from fresh plan publication."""


@dataclass(frozen=True)
class ShoppingPersistence:
    questions: ShoppingQuestionReader | None = None
    question_claims: ShoppingQuestionClaims | None = None
    publication: ShoppingQuestionPublisher | None = None
    active: ActiveShoppingReader | None = None
    active_claims: ActiveShoppingClaims | None = None
    active_publication: ActiveShoppingWriter | None = None


@dataclass(frozen=True)
class CompoundPersistence:
    reader: CompoundPlanReader | None = None
    plans: PlanStore | None = None
    outcomes: OutcomeStore | None = None
    execution: ExecutionStore | None = None


@dataclass(frozen=True)
class TurnPersistence:
    revisions: RequestRevisions | None = None
    questions: QuestionPublisher | None = None
    shopping: ShoppingPersistence = field(default_factory=ShoppingPersistence)
    compound: CompoundPersistence = field(default_factory=CompoundPersistence)
    completion: CompletionContextReader | None = None
    tracking: TrackingWriter | None = None
