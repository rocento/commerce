"""Bind legacy storage implementations to explicit turn capabilities once.

Production storage implements every method. Small adapters may implement only
the operations they support; binding never infers write capability from a read.
The two dictionary-based continuation reads are projected into typed records.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol, runtime_checkable
from uuid import UUID

from app.commerce_action_engine.actions.shopping.continuation import ActiveShopping
from app.commerce_action_engine.actions.shopping.contracts import ShoppingClarification
from app.commerce_action_engine.application.persistence import (
    ActiveShoppingClaims,
    ActiveShoppingState,
    ActiveShoppingWriter,
    CompletionContextReader,
    CompoundOutcomes,
    CompoundPersistence,
    CompoundPlanReader,
    CompoundPlanWriter,
    QuestionPublisher,
    RequestRevisions,
    ShoppingPersistence,
    ShoppingQuestionClaims,
    ShoppingQuestionPublisher,
    ShoppingQuestionState,
    TrackingWriter,
    TurnPersistence,
)
from app.commerce_contracts.compound_plan import (
    CompoundPlan,
    CompoundReceipt,
    CompoundScope,
)


@runtime_checkable
class _ShoppingQuestionRecords(Protocol):
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
    ) -> Mapping[str, object] | None: ...


@runtime_checkable
class _ActiveShoppingRecords(Protocol):
    async def shopping_active(
        self,
        tenant: UUID,
        customer: UUID,
        conversation: UUID,
        *,
        store_id: UUID,
        session_id: UUID,
    ) -> Mapping[str, object] | None: ...


@dataclass(frozen=True)
class _ShoppingQuestions:
    source: _ShoppingQuestionRecords

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
    ) -> ShoppingQuestionState | None:
        record = await self.source.shopping_question(
            tenant,
            customer,
            conversation,
            store_id=store_id,
            session_id=session_id,
            revision=revision,
            original=original,
            question=question,
        )
        if record is None:
            return None
        saved_revision, saved_original, plan = (
            record["revision"],
            record["original_message"],
            record["plan"],
        )
        if not (
            isinstance(saved_revision, UUID)
            and isinstance(saved_original, str)
            and isinstance(plan, ShoppingClarification)
        ):
            raise TypeError("invalid_shopping_question_record")
        return ShoppingQuestionState(saved_revision, saved_original, plan)


@dataclass(frozen=True)
class _ActiveShopping:
    source: _ActiveShoppingRecords

    async def shopping_active(
        self,
        tenant: UUID,
        customer: UUID,
        conversation: UUID,
        *,
        store_id: UUID,
        session_id: UUID,
    ) -> ActiveShoppingState | None:
        record = await self.source.shopping_active(
            tenant,
            customer,
            conversation,
            store_id=store_id,
            session_id=session_id,
        )
        if record is None:
            return None
        revision, original, active = (
            record["revision"],
            record["original_message"],
            record["active"],
        )
        if not (
            isinstance(revision, UUID)
            and isinstance(original, str)
            and isinstance(active, ActiveShopping)
        ):
            raise TypeError("invalid_active_shopping_record")
        return ActiveShoppingState(revision, original, active)


@dataclass(frozen=True)
class _CompoundReads:
    reader: CompoundPlanReader | None

    async def get_compound_plan(
        self, scope: CompoundScope, request: UUID, input_hash: str
    ) -> CompoundPlan | None:
        if self.reader is None:
            # Fresh plan publication needs only save. On a failed dispatch claim,
            # the journey already handles an unavailable recovery read by stopping.
            raise RuntimeError("compound_read_unavailable")
        return await self.reader.get_compound_plan(scope, request, input_hash)


@dataclass(frozen=True)
class _CompoundPlans(_CompoundReads):
    writer: CompoundPlanWriter

    async def save_compound_plan(self, plan: CompoundPlan) -> CompoundPlan | None:
        return await self.writer.save_compound_plan(plan)


@dataclass(frozen=True)
class _CompoundExecution(_CompoundReads):
    outcomes: CompoundOutcomes

    async def transition_compound(
        self,
        scope: CompoundScope,
        request: UUID,
        action_id: UUID,
        *,
        transition: str,
        receipt: CompoundReceipt | None = None,
    ) -> CompoundPlan:
        return await self.outcomes.transition_compound(
            scope, request, action_id, transition=transition, receipt=receipt
        )


def bind_persistence(store: object | None) -> TurnPersistence:
    """Inspect declared, callable operations at composition, never inside a turn."""
    reader = (
        store
        if isinstance(store, CompoundPlanReader) and callable(store.get_compound_plan)
        else None
    )
    writer = (
        store
        if isinstance(store, CompoundPlanWriter) and callable(store.save_compound_plan)
        else None
    )
    outcomes = (
        store
        if isinstance(store, CompoundOutcomes) and callable(store.transition_compound)
        else None
    )
    return TurnPersistence(
        revisions=store
        if isinstance(store, RequestRevisions) and callable(store.begin_request)
        else None,
        questions=store
        if isinstance(store, QuestionPublisher) and callable(store.publish_question)
        else None,
        shopping=ShoppingPersistence(
            questions=_ShoppingQuestions(store)
            if isinstance(store, _ShoppingQuestionRecords)
            and callable(store.shopping_question)
            else None,
            question_claims=store
            if isinstance(store, ShoppingQuestionClaims)
            and callable(store.claim_shopping_question)
            else None,
            publication=store
            if isinstance(store, ShoppingQuestionPublisher)
            and callable(store.publish_shopping_question)
            else None,
            active=_ActiveShopping(store)
            if isinstance(store, _ActiveShoppingRecords)
            and callable(store.shopping_active)
            else None,
            active_claims=store
            if isinstance(store, ActiveShoppingClaims)
            and callable(store.claim_active_shopping)
            else None,
            active_publication=store
            if isinstance(store, ActiveShoppingWriter)
            and callable(store.save_active_shopping)
            else None,
        ),
        compound=CompoundPersistence(
            reader=reader,
            plans=_CompoundPlans(reader, writer) if writer is not None else None,
            outcomes=outcomes,
            execution=_CompoundExecution(reader, outcomes)
            if outcomes is not None
            else None,
        ),
        completion=store
        if isinstance(store, CompletionContextReader)
        and callable(store.completion_context)
        else None,
        tracking=store
        if isinstance(store, TrackingWriter) and callable(store.save_tracking)
        else None,
    )
