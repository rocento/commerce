"""Compound semantic projection is lossless, strict, and cannot authorize writes."""

from copy import deepcopy

import pytest
from pydantic import ValidationError
from test_compound_admission import complete as complete  # noqa: PLC0414
from test_compound_planning import WHO, interpreted, prepared
from test_enterprise_contracts import context as context  # noqa: PLC0414

from app.commerce_action_engine.contracts.interpretation import (
    InterpretationFailure,
    InterpretedRequest,
)
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.execution.language.compatibility import (
    adapt_legacy_resolution,
)
from app.commerce_action_engine.execution.planning import compound_review as policy
from app.commerce_action_engine.execution.planning.compound_execution import executable


@pytest.mark.parametrize("reply", [None, "filled", "replaced", "cancelled", "rejected"])
@pytest.mark.parametrize(
    "status", ["RESOLVED", "NEEDS_CONTEXT", "AMBIGUOUS", "DENIED", "UNSUPPORTED"]
)
def test_review_and_admission_survive_standard_roundtrip(complete, reply, status):
    source = gate.Resolution.model_validate(
        {**complete, "compoundReply": reply, "status": status}
    )
    result = interpreted(source)
    restored = InterpretedRequest.model_validate_json(result.model_dump_json())
    assert restored == result
    assert result.compound_reply == source.compoundReply
    assert (
        result.compound_interpretation_version == source.compoundInterpretationVersion
    )
    assert result.interpretation_text == source.interpretationText
    assert result.requires_confirmation == source.requiresConfirmation
    assert result.requested_actions.model_dump() == {
        name: source.model_dump()[name]
        for name in type(result.requested_actions).model_fields
    }
    assert policy.review(restored) == policy.review(source.review_input())
    assert policy.admitted_pair(restored) == policy.admitted_pair(source.review_input())
    assert [a.model_dump() for a in restored.requested_actions.requestedActions] == [
        a.model_dump() for a in source.requestedActions
    ]


@pytest.mark.parametrize(
    "change",
    [
        {"status": "NEEDS_CONTEXT"},
        {"confidence": {"raw": 0.64, "calibrated": 1.0}},
        {"requires_confirmation": False},
        {"compound_interpretation_version": None},
        {"compound_reply": "cancelled"},
        {"request_type": "COMPOUND"},
        {"primary_intent": "ADD_TO_CART"},
        {"legacy_intent": "ADD_TO_CART"},
        {"missing": ["product"]},
        {"operations": ["ADD_ITEM"]},
    ],
)
def test_standard_metadata_cannot_upgrade_execution(complete, change):
    source = gate.Resolution.model_validate(complete)
    original = interpreted(source)
    changed = InterpretedRequest.model_validate(original.model_dump() | change)
    assert not policy.admitted_pair(changed)
    with pytest.raises(ValueError, match="not_admitted"):
        executable(prepared(resolution=source), changed, WHO)


def test_removing_items_invalidates_preserved_action_links(complete):
    original = interpreted(gate.Resolution.model_validate(complete))
    with pytest.raises(ValidationError, match="unknown item"):
        InterpretedRequest.model_validate(
            original.model_dump() | {"entities": {"items": []}}
        )


@pytest.mark.parametrize(
    "field,value",
    [
        ("compoundInterpretationVersion", True),
        ("compoundInterpretationVersion", "1"),
        ("compoundInterpretationVersion", 2),
        ("compoundReply", "execute"),
        ("interpretationText", "x" * 4001),
        ("intentCount", 99),
        ("requestedActionsVersion", 2),
    ],
)
def test_adapter_rejects_invalid_compound_metadata(complete, context, field, value):
    result = adapt_legacy_resolution({**complete, field: value}, context)
    assert isinstance(result, InterpretationFailure)
    assert result.code == "invalid_response"


def test_missing_counts_and_forward_dependencies_cannot_be_projected(complete, context):
    missing = deepcopy(complete)
    del missing["intentCount"]
    absent = {
        key: value
        for key, value in complete.items()
        if key
        not in {
            "requestedActionsVersion",
            "requestedActions",
            "requestedActionIssues",
            "intentCount",
            "uniqueIntentCount",
            "intentCountStatus",
        }
    }
    invalid_order = deepcopy(complete)
    invalid_order["requestedActions"][0]["after"] = "request2"
    for payload in (missing, absent, invalid_order):
        assert isinstance(
            adapt_legacy_resolution(payload, context), InterpretationFailure
        )


def test_requested_actions_reject_unknown_authority_fields(complete):
    result = interpreted(gate.Resolution.model_validate(complete))
    data = result.model_dump()
    data["requested_actions"]["execution_enabled"] = True
    with pytest.raises(ValidationError):
        InterpretedRequest.model_validate(data)
