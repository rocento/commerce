"""Task achievement requires evidence; clarification recovery requires continuity."""

from uuid import UUID

import pytest

from app.commerce_action_engine.platform.completion import (
    completion_context,
    completion_metadata,
)


def result(metadata=None, **kwargs):
    return completion_metadata(metadata or {}, outcome="completed", **kwargs)[
        "completion"
    ]


def prior(*, mode="deterministic", matches=True, intent="PRODUCT_SEARCH"):
    return completion_context(
        {"version": 1, "status": "clarification", "mode": mode, "intent": intent},
        request_id=UUID(int=1),
        matches_original=matches,
    )


def test_a_finished_request_resolved_intent_or_displayed_products_is_not_task_evidence():
    measured = result(
        {
            "route_reason": "language_engine_search",
            "language_gate": {"status": "RESOLVED", "intent": "PRODUCT_SEARCH"},
            "tool_calls": 3,
        },
        blocks=[{"kind": "product_list", "products": [{"id": "example"}]}],
    )
    assert measured["request_completed"] is True
    assert measured["task_completed"] is False
    assert measured["status"] == "unverified"


@pytest.mark.parametrize(
    ("metadata", "status"),
    [
        ({"route_reason": "language_engine_clarify"}, "clarification"),
        ({"language_gate": {"status": "NEEDS_CONTEXT"}}, "clarification"),
        ({"route_reason": "product_action_choice"}, "clarification"),
        ({"route_reason": "language_engine_handoff"}, "handoff"),
        ({"route_reason": "language_engine_guided_action"}, "handoff"),
        ({"route_reason": "unsupported_capability"}, "unsupported"),
        ({"route_reason": "resolved_intent_without_capability"}, "unsupported"),
        ({"route_reason": "language_engine_unavailable"}, "unavailable"),
        ({"route_reason": "model_budget_exhausted"}, "unavailable"),
        ({"route_reason": "login_required"}, "denied"),
        ({"completion_disposition": "unverified"}, "unverified"),
    ],
)
def test_pending_or_failed_work_outranks_a_success_marker(metadata, status):
    measured = result({**metadata, "completion_evidence": "read_result"})
    assert measured["status"] == status
    assert measured["task_completed"] is False
    assert measured["evidence"] is None


@pytest.mark.parametrize("outcome", ["unavailable", "denied", "disconnected"])
def test_lifecycle_failure_cannot_be_counted_as_task_completion(outcome):
    measured = completion_metadata(
        {"completion_evidence": "action_receipt"}, outcome=outcome
    )["completion"]
    assert measured["status"] == outcome
    assert measured["request_completed"] is False
    assert measured["task_completed"] is False


def test_a_product_selection_prompt_is_a_question_not_a_completed_cart_action():
    measured = result(
        {"completion_evidence": "action_receipt", "route_reason": "cart_action"},
        blocks=[{"kind": "product_prompt", "product_prompt": {"query": "rings"}}],
    )
    assert measured["status"] == "clarification"


@pytest.mark.parametrize("evidence", ["read_result", "action_receipt", "policy_answer"])
def test_authoritative_handler_evidence_completes_a_deterministic_task(evidence):
    measured = result({"completion_evidence": evidence})
    assert measured["status"] == "completed"
    assert measured["evidence"] == evidence
    assert measured["mode"] == "deterministic"
    assert measured["model_attempted"] is False


@pytest.mark.parametrize(
    "usage",
    [
        {"model_attempts": 1, "model_calls": 0},
        {"model_calls": 1},
        {"response_source": "L"},
    ],
)
def test_model_attempts_are_distinct_from_model_completion(usage):
    attempted = result(usage)
    assert attempted["model_attempted"] is True
    assert attempted["mode"] == "model_assisted"
    assert attempted["task_completed"] is False
    completed = result({**usage, "completion_evidence": "read_result"})
    assert completed["task_completed"] is True
    assert completed["mode"] == "model_assisted"


def test_only_a_bound_same_intent_reply_with_final_evidence_recovers_clarification():
    metadata = {
        "language_gate": {"status": "RESOLVED", "intent": "PRODUCT_SEARCH"},
        "completion_evidence": "read_result",
    }
    recovered = result(metadata, clarification_reply=True, prior_completion=prior())
    assert recovered["clarification_recovered"] is True
    assert recovered["clarification_source_request_id"] == str(UUID(int=1))
    for context, validated in [
        (None, True),
        (prior(), False),
        (prior(matches=False), True),
        (prior(intent="ADD_TO_CART"), True),
    ]:
        measured = result(
            metadata, clarification_reply=validated, prior_completion=context
        )
        assert measured["task_completed"] is True
        assert measured["clarification_reply"] is False
        assert measured["clarification_recovered"] is False
        assert "clarification_source_request_id" not in measured


def test_a_resolved_followup_and_a_repeated_question_do_not_prove_recovery():
    for metadata in [
        {"language_gate": {"intent": "PRODUCT_SEARCH", "status": "RESOLVED"}},
        {"language_gate": {"intent": "PRODUCT_SEARCH", "status": "NEEDS_CONTEXT"}},
        {
            "language_gate": {"intent": "PRODUCT_SEARCH", "status": "RESOLVED"},
            "route_reason": "language_engine_handoff",
        },
    ]:
        measured = result(metadata, clarification_reply=True, prior_completion=prior())
        assert measured["clarification_reply"] is True
        assert measured["clarification_recovered"] is False


def test_a_model_assisted_clarification_chain_is_not_reclassified_deterministic():
    measured = result(
        {
            "language_gate": {"intent": "PRODUCT_SEARCH", "status": "RESOLVED"},
            "completion_evidence": "read_result",
        },
        clarification_reply=True,
        prior_completion=prior(mode="model_assisted"),
    )
    assert measured["model_attempted"] is False
    assert measured["mode"] == "model_assisted"
    assert measured["clarification_recovered"] is True


def test_unknown_evidence_and_unbounded_content_are_never_copied_into_metrics():
    secret = "private-shopper-message user@example.test"
    measured = result(
        {
            "completion_evidence": secret,
            "route_reason": secret,
            "language_gate": {"intent": secret},
            "text": secret,
        },
        blocks=[{"kind": "text", "text": secret}],
    )
    assert measured["status"] == "unverified"
    assert secret not in repr(measured)
    context = completion_context(
        {
            "version": 1,
            "status": "clarification",
            "mode": "deterministic",
            "intent": "PRODUCT_SEARCH",
            "text": secret,
        },
        request_id=UUID(int=1),
        matches_original=True,
    )
    assert secret not in repr(context)
    assert completion_context({}, request_id=UUID(int=1), matches_original=True) is None
    assert completion_context([], request_id=UUID(int=1), matches_original=True) is None
