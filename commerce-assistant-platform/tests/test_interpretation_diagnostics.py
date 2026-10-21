"""Diagnostic summaries consume standard metadata and never expose request content."""

import json
from uuid import uuid4

import pytest
from test_enterprise_contracts import context as context  # noqa: PLC0414
from test_language_fallback import resolved

from app.commerce_action_engine.application.followups import _Interpreter
from app.commerce_action_engine.application.interpretation import interpret_resolution
from app.commerce_action_engine.application.interpretation_diagnostics import (
    diagnostic_summary,
)
from app.commerce_action_engine.contracts.interpretation import InterpretationFailure
from app.commerce_action_engine.execution.language.routing import route
from app.commerce_resolution_engine.diagnostics import begin_debug, finish_debug


@pytest.mark.parametrize(
    "code",
    ["unavailable", "invalid_response", "incompatible_version", "incompatible_release"],
)
def test_failed_summary_matches_existing_unavailable_shape(context, code):
    failure = InterpretationFailure(request_id=context.actor.request_id, code=code)
    assert diagnostic_summary(failure, "unavailable") == {
        "status": "UNAVAILABLE",
        "intent": None,
        "route": "unavailable",
        "requested_actions": {"metadata": "unavailable"},
        "failure_code": code,
    }


def test_diagnostics_use_route_intent_and_omit_entity_content(context):
    request = interpret_resolution(
        resolved(
            intent="PRODUCT_SEARCH",
            entities={"productText": "private product"},
            message="private message",
        ),
        context,
    ).result
    request = request.model_copy(update={"primary_intent": "VIEW_CART"})
    summary = diagnostic_summary(request, "search")
    assert summary["intent"] == "PRODUCT_SEARCH"
    assert "private" not in str(summary)
    assert context.actor.request_id not in str(summary)


def test_live_and_followup_routing_preserve_opt_in_source_timing(context, monkeypatch):
    monkeypatch.delenv("AI_INTENT_DEBUG_DIR", raising=False)
    token = begin_debug(str(uuid4()), "hello", enabled=True)
    try:
        decision = interpret_resolution(
            resolved(
                intent="PRODUCT_SEARCH", entities={"productText": "private-canary"}
            ),
            context,
        )
        followup = _Interpreter("unused", context).with_entities(
            decision, {"productText": "private-followup-canary"}
        )
        assert decision.route == followup.route == "search"
    finally:
        report = finish_debug(token)
    events = [
        event["data"]
        for event in report["events"]
        if event["stage"] == "python_function" and event["data"]["function"] == "route"
    ]
    assert len(events) == 2
    first, second = [event["_journey"] for event in events]
    assert first["function"]["file"] == (
        "app/commerce_action_engine/execution/language/routing.py"
    )
    assert "def route(" in first["function"]["source"]
    assert first["sourceId"] == second["sourceId"]
    assert all(event["_journey"]["durationMs"] >= 0 for event in events)
    assert all(event["outcome"] == "returned" for event in events)
    assert "private-canary" not in json.dumps(report)
    assert "private-followup-canary" not in json.dumps(report)


def test_policy_routing_has_no_diagnostic_side_effects(context, monkeypatch):
    monkeypatch.delenv("AI_INTENT_DEBUG_DIR", raising=False)
    request = interpret_resolution(resolved(intent="PRODUCT_SEARCH"), context).result
    token = begin_debug(str(uuid4()), "hello", enabled=True)
    try:
        assert route(request) == "search"
    finally:
        report = finish_debug(token)
    assert [event["stage"] for event in report["events"]] == ["customer_request"]
