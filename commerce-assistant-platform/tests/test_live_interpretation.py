"""Typed interpretation at live action dispatch and UNKNOWN admission boundaries."""

import json
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient
from interpretation_helpers import standard_route
from test_assistant import identity as identity  # noqa: PLC0414
from test_enterprise_contracts import context as context  # noqa: PLC0414
from test_language_fallback import install_provider, resolved, unknown
from test_requested_actions_contract import (
    interpretations as interpretations,  # noqa: PLC0414
)

from app.commerce_action_engine.application import (
    language_admission,
    language_proposals,
)
from app.commerce_action_engine.application.interpretation import interpret_resolution
from app.commerce_action_engine.contracts.interpretation import (
    InterpretationFailure,
    InterpretedRequest,
)
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.execution.language.compatibility import (
    adapt_legacy_resolution,
)
from app.commerce_resolution_engine.admission import require_permit
from app.main import create_app


@pytest.mark.parametrize(
    "status,route",
    [
        ("RESOLVED", "cart"),
        ("NEEDS_CONTEXT", "clarify"),
        ("AMBIGUOUS", "clarify"),
        ("UNKNOWN", "fallback"),
        ("UNSUPPORTED", "unsupported"),
        ("DENIED", "denied"),
    ],
)
def test_standard_contract_preserves_status_route_and_confirmation(
    context, status, route
):
    source = resolved(status=status, requiresConfirmation=True, missing=[])
    decision = interpret_resolution(source, context)
    assert isinstance(decision.result, InterpretedRequest)
    assert decision.result.request_id == context.actor.request_id
    assert decision.result.status == status
    assert decision.result.requires_confirmation
    assert decision.result == adapt_legacy_resolution(source.model_dump(), context)
    assert decision.route == route == standard_route(source)
    assert decision.allows_fallback is (status == "UNKNOWN")


@pytest.mark.parametrize("change", [{"confidence": 0.4}, {"missing": ["product"]}])
def test_resolved_uncertainty_keeps_clarification_route(context, change):
    decision = interpret_resolution(resolved(**change), context)
    assert decision.route == "clarify"
    assert not decision.allows_fallback


def test_real_engine_controls_survive_the_standard_projection(context, interpretations):
    for message, payload in interpretations.items():
        source = gate.Resolution.model_validate(payload)
        decision = interpret_resolution(source, context)
        assert isinstance(decision.result, InterpretedRequest), message
        assert decision.result == adapt_legacy_resolution(
            source.model_dump(), context
        ), message
        assert decision.result.entities == source.entities
        assert decision.result.operations == source.operations
        assert decision.result.context_next == source.context.get("next", {})
        assert decision.route == standard_route(source)
        assert decision.allows_fallback == (source.status == "UNKNOWN")


def test_local_copy_with_invalid_action_metadata_fails_closed(context):
    source = unknown().model_copy(update={"requestedActionsVersion": 99})
    decision = interpret_resolution(source, context)
    assert isinstance(decision.result, InterpretationFailure)
    assert decision.result.code == "invalid_response"
    assert not hasattr(decision, "resolution") and decision.route == "unavailable"
    assert not decision.allows_fallback


@pytest.mark.parametrize(
    "source", [None, unknown().model_copy(update={"entities": {"items": "invalid"}})]
)
def test_failure_has_no_status_or_actionable_resolution(context, source):
    decision = interpret_resolution(source, context)
    assert isinstance(decision.result, InterpretationFailure)
    assert decision.result.request_id == context.actor.request_id
    assert decision.result.code == (
        "unavailable" if source is None else "invalid_response"
    )
    assert "status" not in decision.result.model_dump()
    assert not hasattr(decision, "resolution")
    assert decision.route == "unavailable" and not decision.allows_fallback


@pytest.mark.parametrize("after_proposal", [False, True])
def test_live_invalid_interpretation_never_reaches_commerce_or_another_model(
    identity, monkeypatch, after_proposal
):
    config, request_id, headers = identity
    provider = install_provider(monkeypatch)
    attempts = []
    decisions = []
    boundary = interpret_resolution

    def observe(source, context):
        decision = boundary(source, context)
        decisions.append(decision)
        if isinstance(decision.result, InterpretationFailure):
            with pytest.raises(PermissionError):
                require_permit(UUID(request_id))
        return decision

    async def resolve(url, text):
        attempts.append(text)
        if after_proposal and len(attempts) == 1:
            return unknown()
        # Resolution's legacy shape allows this, but the standard contract
        # rejects an invalid semantic item collection before dispatch.
        return resolved(entities={"items": "invalid"})

    monkeypatch.setattr(gate, "resolve", resolve)
    monkeypatch.setattr(language_admission, "interpret_resolution", observe)
    monkeypatch.setattr(language_proposals, "interpret_resolution", observe)
    with TestClient(
        create_app(
            config,
            transport=httpx.MockTransport(
                lambda _: pytest.fail("Invalid interpretation reached commerce")
            ),
        )
    ) as client:
        response = client.post(
            "/v1/chat",
            headers=headers(),
            json={"request_id": request_id, "message": "Let me peek at my basket"},
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert response.status_code == 200
    assert events[-1]["type"] == "done"
    assert [e["sequence"] for e in events] == list(range(len(events)))
    assert any(e.get("code") == "unavailable" for e in events)
    assert len(provider.requests) == int(after_proposal)
    assert len(attempts) == 1 + int(after_proposal)
    assert len(decisions) == 1 + int(after_proposal)
    assert isinstance(decisions[-1].result, InterpretationFailure)
    assert provider.closed
    assert not hasattr(gate, "current")
