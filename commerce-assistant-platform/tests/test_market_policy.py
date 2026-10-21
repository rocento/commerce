from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from pydantic import ValidationError

from app.commerce_action_engine.actions.policy import (
    PolicyAnswer,
    PolicyAnswers,
    PolicySource,
)
from app.commerce_knowledge_rag import Chunk, Hit, Source, evidence

NOW = datetime.now(UTC)


def source(**overrides):
    return Source.model_validate(
        dict(
            id=UUID(int=1),
            tenant=UUID(int=2),
            title="Store terms",
            revision=2,
            kind="policy",
            collection="policies",
            approved=True,
            effective_from=NOW - timedelta(days=1),
            valid_until=NOW + timedelta(days=1),
            **overrides,
        )
    )


def test_policy_lifecycle_requires_dates_and_rejects_withdrawal():
    current = source()
    assert current.current(NOW)
    for patch in (
        {"valid_until": NOW},
        {"effective_from": NOW + timedelta(hours=1)},
        {"withdrawn_at": NOW},
        {"approved": False},
        {"effective_from": None, "valid_until": None},
    ):
        assert not current.model_copy(update=patch).current(NOW)
    with pytest.raises(ValidationError):
        Source.model_validate(
            {**current.model_dump(), "valid_until": NOW - timedelta(days=2)}
        )
    citation = evidence(Hit(current, Chunk("a", 1, 0, "Terms"), 0.9))
    assert (
        citation["revision"] == 2
        and citation["effective_from"]
        and citation["valid_until"]
    )


def test_exact_policy_withdrawal_and_future_effective_date_are_unknown():
    base = PolicySource(
        id="guide:returns",
        title="Returns",
        revision=3,
        approved_at=NOW - timedelta(days=2),
        effective_from=NOW - timedelta(days=1),
        valid_until=NOW + timedelta(days=2),
    )

    def answer(src):
        return PolicyAnswers(
            schema_version="2",
            tenant_id=UUID(int=2),
            answers=(
                PolicyAnswer(
                    phrases=frozenset({"returns"}),
                    answer="Reviewed store terms",
                    source=src,
                ),
            ),
        )

    assert "guide:returns@3" in answer(base).match("returns", NOW)
    for patch in (
        {"withdrawn_at": NOW},
        {"effective_from": NOW + timedelta(days=1)},
        {"valid_until": NOW},
    ):
        value = answer(base.model_copy(update=patch))
        assert value.current_count(NOW) == 0
        assert "awaiting review" in value.match("returns", NOW)
