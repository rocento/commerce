"""Whole-request interpretation is necessary for admission, never write authority."""

import asyncio
from copy import deepcopy

import pytest
from interpretation_helpers import standard_route
from pydantic import ValidationError
from test_compound_planning import Reader, prepared
from test_enterprise_contracts import context as context  # noqa: PLC0414
from test_language_understanding import interpret, real_resolve
from test_shopping import interpreted

from app.commerce_action_engine.application.followups import resume_compound
from app.commerce_action_engine.application.interpretation import shopping_plan
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.execution.planning import compound_review


@pytest.fixture(scope="module")
def complete():
    return interpret(
        [{"messages": ["add 2 banana to cart then add 1 apples to wishlist"]}]
    )[0][0]


def test_real_complete_interpretation_reaches_read_only_planner(complete):
    result = gate.Resolution.model_validate(complete)
    assert compound_review.admitted_pair(result.review_input())
    assert standard_route(result) == "clarify"
    assert shopping_plan(interpreted(result), complete["text"]) is None
    reader = Reader()
    plan = prepared(reader, result)
    assert plan.language_status == "RESOLVED"
    assert plan.interpretation_issues == ()
    assert [a.quantity for a in plan.actions] == [2, 1]
    assert [a.destination for a in plan.actions] == ["cart", "wishlist"]
    assert plan.actions[1].customer_after == plan.actions[0].id
    assert plan.execution_enabled is False
    assert len(reader.calls) == 4
    assert gate.Resolution.model_validate_json(result.model_dump_json()) == result


@pytest.mark.parametrize(
    "status", ["NEEDS_CONTEXT", "AMBIGUOUS", "UNKNOWN", "DENIED", "UNSUPPORTED"]
)
def test_marker_and_exact_count_never_upgrade_a_held_status(complete, status):
    result = gate.Resolution.model_validate({**complete, "status": status})
    assert not compound_review.admitted_pair(result.review_input())
    assert result.status != "RESOLVED"
    assert standard_route(result) in {"clarify", "denied", "unsupported"}


@pytest.mark.parametrize(
    "field,value",
    [
        ("intent", "ADD_TO_CART"),
        ("requiresConfirmation", False),
        ("primaryIntent", "ADD_TO_CART"),
        ("requestType", "COMPOUND"),
        ("operations", ["ADD_ITEM"]),
        ("missing", ["product"]),
        ("entities", {"items": [{"productText": "banana", "quantity": 999}]}),
        ("requestedActionIssues", ["INTERPRETATION_CONFLICT"]),
        ("compoundReply", "rejected"),
        ("unsupportedIntents", ["START_CHECKOUT"]),
    ],
)
def test_inconsistent_projection_stops_for_clarification(complete, field, value):
    result = gate.Resolution.model_validate({**complete, field: value})
    assert result.status == "NEEDS_CONTEXT"
    assert not compound_review.admitted_pair(result.review_input())
    assert "INTERPRETATION_CONFLICT" in result.requestedActionIssues
    review = compound_review.review(result.review_input())
    assert review.needs_reply and review.state == "needs_request"


def test_marker_without_complete_metadata_is_rejected(complete):
    raw = deepcopy(complete)
    for field in [
        "requestedActionsVersion",
        "requestedActions",
        "requestedActionIssues",
        "intentCount",
        "uniqueIntentCount",
        "intentCountStatus",
    ]:
        del raw[field]
    with pytest.raises(ValidationError):
        gate.Resolution.model_validate(raw)


@pytest.mark.parametrize("version", [True, "1", 0, 2])
def test_marker_is_strictly_versioned(complete, version):
    with pytest.raises(ValidationError):
        gate.Resolution.model_validate(
            {**complete, "compoundInterpretationVersion": version}
        )


def test_old_resolved_metadata_cannot_gain_new_admission(complete):
    raw = deepcopy(complete)
    del raw["compoundInterpretationVersion"]
    result = gate.Resolution.model_validate(raw)
    assert result.status == "NEEDS_CONTEXT"
    assert not compound_review.admitted_pair(result.review_input())


def test_extra_constraints_and_authority_fields_cannot_hide_in_entities(complete):
    for field, value in [
        ("requestConstraints", []),
        ("product_id", "forged"),
        ("execution_enabled", True),
    ]:
        raw = deepcopy(complete)
        raw["entities"][field] = value
        result = gate.Resolution.model_validate(raw)
        assert result.status == "NEEDS_CONTEXT"
        assert not compound_review.admitted_pair(result.review_input())


def test_low_confidence_cannot_gain_admission(complete):
    result = gate.Resolution.model_validate({**complete, "confidence": 0.1})
    assert not compound_review.admitted_pair(result.review_input())
    assert result.status == "NEEDS_CONTEXT"


def test_product_reply_reparses_full_request_and_preserves_admission(
    monkeypatch, context
):
    monkeypatch.setattr(gate, "resolve", real_resolve)
    result, source = asyncio.run(
        resume_compound(
            "http://engine",
            "add it to cart then also to wishlist",
            "banana",
            context=context,
        )
    )
    result = result.result
    assert result.compound_reply == "filled"
    assert compound_review.admitted_pair(result)
    assert "banana" in source
    assert result.requested_actions.requestedActions[1].after == "request1"
