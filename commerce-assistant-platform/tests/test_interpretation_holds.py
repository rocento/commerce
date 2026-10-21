"""Semantic holds agree across ingress and standard inputs without mutating either."""

import pytest
from test_compound_admission import complete as complete  # noqa: PLC0414
from test_enterprise_contracts import context as context  # noqa: PLC0414

from app.commerce_action_engine.contracts.interpretation import (
    InterpretationFailure,
    InterpretedRequest,
)
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.execution.language.compatibility import (
    adapt_legacy_resolution,
)
from app.commerce_action_engine.execution.planning.interpretation_holds import (
    normalize_holds,
)


@pytest.mark.parametrize(
    "change",
    [
        {},
        {"entities": {"requestConstraints": []}},
        {"operations": []},
        {"status": "UNKNOWN"},
        {"compoundReply": "rejected"},
        {"status": "DENIED", "entities": {"requestConstraints": []}},
        {"status": "UNSUPPORTED", "operations": []},
    ],
)
def test_standard_and_wire_holds_match_without_mutation(complete, context, change):
    source = gate.Resolution.model_validate(complete).model_copy(update=change)
    payload = source.model_dump()
    standard = adapt_legacy_resolution(payload, context)
    if "entities" in change:
        # Entity replacement now leaves preserved action links dangling. Reject
        # this malformed interpretation before considering a clarification hold.
        assert isinstance(standard, InterpretationFailure)
        assert standard.code == "invalid_response"
        assert source.model_dump() == payload
        return
    assert isinstance(standard, InterpretedRequest)
    before = standard.model_dump()
    hold = normalize_holds(standard, standard.message)
    validated = gate.Resolution.model_validate(payload)
    assert (hold.status, hold.confidence, hold.message, hold.missing, hold.issues) == (
        validated.status,
        validated.confidence,
        validated.message,
        validated.missing,
        validated.requestedActionIssues,
    )
    assert source.model_dump() == payload
    assert standard.model_dump() == before
    if change.get("status") in {"DENIED", "UNSUPPORTED"}:
        assert hold.status == change["status"]
    elif change:
        assert hold.status == "NEEDS_CONTEXT"
