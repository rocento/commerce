import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest

from app.commerce_action_engine.actions.policy import PolicyAnswers, load


def collection(tenant, now):
    return {
        "schema_version": "2",
        "tenant_id": str(tenant),
        "answers": [
            {
                "phrases": ["How do quotes work?"],
                "answer": "Review the current quote.",
                "source": {
                    "id": "guide:quotes",
                    "title": "Quote review",
                    "revision": 1,
                    "approved_at": now.isoformat(),
                    "valid_until": (now + timedelta(days=30)).isoformat(),
                },
            }
        ],
        "unknown_phrases": ["What is your refund policy?"],
    }


def test_exact_citations_stale_and_unknown_answers_do_not_guess(tmp_path):
    now = datetime.now(UTC)
    tenant = uuid4()
    file = tmp_path / "guides.json"
    file.write_text(json.dumps(collection(tenant, now)))
    guides = load(str(file), str(tenant))
    assert (
        guides.match("How do quotes work?", now)
        == "Review the current quote.\n\nSource: Quote review (guide:quotes@1; reviewed "
        + now.date().isoformat()
        + ")."
    )
    assert "awaiting review" in guides.match(
        "How do quotes work?", now + timedelta(days=30)
    )
    assert "Review the current quote." not in guides.match(
        "How do quotes work?", now - timedelta(seconds=1)
    )
    assert "do not have an approved answer" in guides.match(
        "What is your refund policy?", now
    )
    assert guides.match("Find apples", now) is None
    assert guides.current_count(now) == 1
    assert guides.current_count(now + timedelta(days=30)) == 0
    with pytest.raises(ValueError, match="Invalid AI exact policy"):
        load(str(file), str(uuid4()))


def test_version_one_remains_readable_but_does_not_claim_dated_approval():
    guides = PolicyAnswers.model_validate(
        {"answers": [{"phrases": ["Policy"], "answer": "Legacy answer"}]}
    )
    assert guides.match("policy") == "Legacy answer"
    assert guides.current_count() == 0


def test_version_two_rejects_missing_sources_and_ambiguous_answers():
    now = datetime.now(UTC)
    value = collection(uuid4(), now)
    value["answers"].append(value["answers"][0])
    with pytest.raises(ValueError, match="Ambiguous"):
        PolicyAnswers.model_validate(value)
    value["answers"] = [{"phrases": ["test"], "answer": "unapproved"}]
    with pytest.raises(ValueError, match="dated sources"):
        PolicyAnswers.model_validate(value)
