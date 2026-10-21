"""The extracted journey returns domain outcomes through canonical entry points."""

import asyncio
from uuid import uuid4

from test_compound_planning import CONVERSATION, WHO, Reader, interpreted, resolved

from app.commerce_action_engine.application.handlers import compound
from app.commerce_orchestration_engine.journeys.compound import (
    prepare_journey,
    reconcile,
)


class PlanStore:
    def __init__(self, *, superseded=False):
        self.saved = []
        self.superseded = superseded

    async def save_compound_plan(self, plan):
        self.saved.append(plan)
        return None if self.superseded else plan


def run(result, reader, store, **kwargs):
    return asyncio.run(
        prepare_journey(
            interpreted(result),
            WHO,
            reader,
            store,
            conversation=CONVERSATION,
            request=uuid4(),
            revision=uuid4(),
            fingerprint="a" * 64,
            **kwargs,
        )
    )


def test_supported_review_is_saved_without_enabling_execution():
    store = PlanStore()
    result = run(resolved(), Reader(), store)
    assert result.status == "saved"
    assert result.plan == store.saved[0]
    assert result.plan.execution_enabled is False
    assert all(action.state == "ready" for action in result.plan.actions)
    assert "No changes have been made" in compound.describe(result.plan)


def test_superseded_preparation_returns_no_executable_plan():
    store = PlanStore(superseded=True)
    result = run(resolved(), Reader(), store)
    assert len(store.saved) == 1
    assert result.status == "superseded"
    assert result.plan is None


def test_cancelled_request_never_reads_or_saves():
    reader, store = Reader(), PlanStore()
    result = run(
        resolved().model_copy(update={"compoundReply": "cancelled"}), reader, store
    )
    assert result.status == "unsupported"
    assert result.plan is None
    assert reader.calls == []
    assert store.saved == []


def test_invalid_preparation_returns_unavailable_without_saving():
    reader, store = Reader(), PlanStore()
    result = asyncio.run(
        prepare_journey(
            interpreted(resolved()),
            WHO.model_copy(update={"subject": None}),
            reader,
            store,
            conversation=CONVERSATION,
            request=uuid4(),
            revision=uuid4(),
            fingerprint="a" * 64,
        )
    )
    assert result.status == "unavailable"
    assert result.plan is None
    assert reader.calls == []
    assert store.saved == []


def test_application_uses_canonical_reconciliation():
    assert compound.reconcile is reconcile
