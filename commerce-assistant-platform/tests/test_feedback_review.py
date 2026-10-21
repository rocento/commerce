from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from pydantic import ValidationError

from app.commerce_action_engine.application.feedback_review import (
    FailureRecord,
    ReviewEvent,
    ReviewQueue,
)

NOW = datetime(2026, 10, 2, tzinfo=UTC)
TENANT = UUID(int=1)


def record(**changes):
    return FailureRecord(
        tenant_id=TENANT,
        fingerprint="a" * 64,
        status="UNKNOWN",
        evidence_sha256="b" * 64,
        expires_at=NOW + timedelta(days=30),
        **changes,
    )


def event(key, decision, **changes):
    return ReviewEvent(
        record_key=key, reviewer_id=UUID(int=2), at=NOW, decision=decision, **changes
    )


def test_dedup_review_proposal_and_no_publication_state():
    r = record()
    q = ReviewQueue(tenant_id=TENANT).update(now=NOW, records=[r, r])
    assert len(q.records) == 1
    q = q.update(now=NOW, events=[event(r.key, "approved")])
    q = q.update(
        now=NOW,
        events=[
            event(
                r.key, "proposed", artifact_sha256="c" * 64, regression_sha256="d" * 64
            )
        ],
    )
    assert [e.decision for e in q.events] == ["approved", "proposed"]
    assert "published" not in q.model_dump_json()


def test_reject_unreviewed_promotion_foreign_tenant_and_raw_text():
    r = record()
    q = ReviewQueue(tenant_id=TENANT, records=(r,))
    with pytest.raises(ValueError):
        q.update(
            now=NOW,
            events=[
                event(
                    r.key,
                    "proposed",
                    artifact_sha256="c" * 64,
                    regression_sha256="d" * 64,
                )
            ],
        )
    with pytest.raises(ValueError):
        q.update(now=NOW, records=[r.model_copy(update={"tenant_id": UUID(int=3)})])
    with pytest.raises(ValidationError):
        record(utterance="customer private text")
    with pytest.raises(ValidationError):
        event(r.key, "proposed")


def test_expiry_deletion_and_reimport_cannot_extend_retention():
    r = record()
    q = ReviewQueue(tenant_id=TENANT, records=(r,), events=(event(r.key, "rejected"),))
    assert not q.update(now=NOW + timedelta(days=31)).events
    assert not q.update(now=NOW, delete=[r.key]).records
    duplicate = r.model_copy(update={"expires_at": NOW + timedelta(days=60)})
    assert q.update(now=NOW, records=[duplicate]).records[0].expires_at == r.expires_at
    with pytest.raises(ValueError):
        q.update(now=NOW, events=[event(r.key, "approved")])
