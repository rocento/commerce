"""Phase-0 compatibility guardrails; no network, model or commerce writes."""

import json
from copy import deepcopy
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.commerce_action_engine.application.context import TurnContext
from app.commerce_action_engine.contracts.action import ActorContext
from app.commerce_action_engine.contracts.interpretation import (
    InterpretationFailure,
    InterpretedRequest,
)
from app.commerce_action_engine.execution.language.compatibility import (
    adapt_legacy_resolution,
)

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = Path(__file__).resolve().parent / "fixtures/enterprise_contracts"
FIXTURES = json.loads((CONTRACTS / "legacy-engine-fixtures.json").read_text())
ID = "00000000-0000-0000-0000-000000000001"


@pytest.fixture
def context():
    return TurnContext(
        actor=ActorContext(
            tenant_id=ID,
            store_id=ID,
            session_id=ID,
            request_id=ID,
            channel="evaluation",
        )
    )


@pytest.mark.parametrize(
    "fixture",
    FIXTURES,
    ids=lambda fixture: fixture["name"],
)
def test_real_engine_fixtures_preserve_meaning(context, fixture):
    wire = fixture["response"]
    result = adapt_legacy_resolution(wire, context)
    assert isinstance(result, InterpretedRequest)
    assert result.status == wire["status"]
    assert result.entities == wire["entities"]
    assert result.operations == wire.get("operations", [])
    assert result.context_next == wire["context"]["next"]
    assert result.request_id == context.actor.request_id
    assert result.confidence.calibrated is None
    assert result.provenance.dictionary_version is None
    assert [action.model_dump() for action in result.actions] == [
        {"itemIndexes": [], **action} for action in wire.get("actions", [])
    ]
    assert [
        relation.model_dump(by_alias=True) for relation in result.relationships
    ] == wire.get("relationships", [])
    assert [r.model_dump(exclude_unset=True) for r in result.references] == wire.get(
        "references", []
    )
    assert result.allows_fallback == (wire["status"] == "UNKNOWN")


@pytest.mark.parametrize("name", ["needs_context", "address_reference"])
def test_legacy_reference_shape_preserves_clarification(context, name):
    # Older deployments may omit the additive reference metadata.
    wire = deepcopy(next(f["response"] for f in FIXTURES if f["name"] == name))
    for reference in wire["references"]:
        reference.pop("state", None)
        reference.pop("selectionStrategy", None)
    result = adapt_legacy_resolution(wire, context)
    assert isinstance(result, InterpretedRequest)
    assert result.status == "NEEDS_CONTEXT"
    assert result.needs_clarification
    assert not result.allows_fallback
    assert result.entities == wire["entities"]
    assert result.context_next == wire["context"]["next"]


@pytest.mark.parametrize(
    "model", [TurnContext, InterpretedRequest, InterpretationFailure]
)
def test_versioned_internal_contract_snapshot(model):
    saved = json.loads((CONTRACTS / f"{model.__name__}.schema.json").read_text())
    assert model.model_json_schema(by_alias=True) == saved


def _public_assistant_schemas():
    schemas = json.loads((ROOT / "commerce-api/rocento-api/openapi.json").read_text())["components"][
        "schemas"
    ]
    return {k: v for k, v in schemas.items() if k.startswith("Assistant")}


def _assert_reviewed_public_contract_changes(current):
    """Keep v1 frozen; only the explicitly reviewed release deltas are allowed."""
    baseline = json.loads((CONTRACTS / "public-assistant-v1.json").read_text())
    tracking_additions = json.loads(
        (CONTRACTS / "public-assistant-tracking-additions-v1.json").read_text()
    )
    assert set(current) == set(baseline) | set(tracking_additions)
    for name, schema in tracking_additions.items():
        assert current[name] == schema
    clarification = current["AssistantClarification"]
    prior = baseline["AssistantClarification"]
    assert clarification["required"] == prior["required"]
    additions = {
        "kind": {"type": "string", "enum": ["shopping"]},
        "choices": {
            "type": "array",
            "items": {"type": "string", "maxLength": 120, "minLength": 1},
            "maxItems": 8,
            "minItems": 0,
        },
        "optional": {"type": "boolean"},
    }
    assert set(clarification["properties"]) - set(prior["properties"]) == set(additions)
    for name, schema in additions.items():
        assert (
            name not in clarification["required"]
            and clarification["properties"][name] == schema
        )
    compatible = deepcopy(current)
    for name in additions:
        compatible["AssistantClarification"]["properties"].pop(name)
    for name in tracking_additions:
        compatible.pop(name)
    # Operator reports now capture up to 96 stages. This is an explicit response
    # limit change, not an optional-field addition: clients enforcing v1's 32
    # stage limit must update with the service. All other report fields stay v1.
    prior_events = baseline["AssistantTrackingReport"]["properties"]["events"]
    events = compatible["AssistantTrackingReport"]["properties"]["events"]
    assert prior_events["maxItems"] == 32
    assert events["maxItems"] == 96
    events["maxItems"] = prior_events["maxItems"]
    assert compatible == baseline


def test_public_contracts_match_v1_except_reviewed_clarification_and_tracking_changes():
    _assert_reviewed_public_contract_changes(_public_assistant_schemas())


@pytest.mark.parametrize(
    "mutation",
    [
        "removed_schema",
        "unreviewed_schema",
        "removed_field",
        "changed_field_type",
        "new_required_field",
        "unreviewed_optional_field",
        "unreviewed_tracking_limit",
        "changed_tracking_addition",
    ],
)
def test_public_contract_guard_rejects_unreviewed_changes(mutation):
    current = _public_assistant_schemas()
    clarification = current["AssistantClarification"]
    if mutation == "removed_schema":
        current.pop("AssistantTrackingStage")
    elif mutation == "unreviewed_schema":
        current["AssistantUnreviewed"] = {"type": "object"}
    elif mutation == "removed_field":
        clarification["properties"].pop("original_message")
    elif mutation == "changed_field_type":
        clarification["properties"]["original_message"]["type"] = "integer"
    elif mutation == "new_required_field":
        clarification["required"].append("optional")
    elif mutation == "unreviewed_optional_field":
        clarification["properties"]["unreviewed"] = {"type": "boolean"}
    elif mutation == "unreviewed_tracking_limit":
        current["AssistantTrackingReport"]["properties"]["events"]["maxItems"] = 97
    else:
        current["AssistantLiveEvent"]["properties"]["kind"]["enum"].append("raw")
    with pytest.raises(AssertionError):
        _assert_reviewed_public_contract_changes(current)


@pytest.mark.parametrize("event_count", [32, 96, 97])
def test_runtime_tracking_report_enforces_reviewed_limit(event_count):
    from app.commerce_action_engine.contracts import AssistantTrackingReport

    report = {
        "version": 1,
        "request_id": ID,
        "truncated": False,
        "redacted": True,
        "events": [{"stage": "language_route", "data": {}}] * event_count,
    }
    if event_count <= 96:
        assert len(AssistantTrackingReport.model_validate(report).events) == event_count
    else:
        with pytest.raises(ValidationError):
            AssistantTrackingReport.model_validate(report)


@pytest.mark.parametrize(
    "payload,code",
    [
        (None, "unavailable"),
        ({}, "invalid_response"),
        ({"schema_version": "2.0"}, "incompatible_version"),
        (
            {"status": "UNKNOWN", "confidence": float("nan"), "message": "Unknown"},
            "invalid_response",
        ),
    ],
)
def test_failure_is_never_unknown(context, payload, code):
    result = adapt_legacy_resolution(payload, context)
    assert isinstance(result, InterpretationFailure)
    assert result.code == code
    assert "status" not in result.model_dump()


def test_unknown_wire_version_fails_closed(context):
    result = adapt_legacy_resolution(
        FIXTURES[0]["response"], context, wire_contract="v2"
    )
    assert isinstance(result, InterpretationFailure)
    assert result.code == "incompatible_version"


def test_payload_cannot_supply_authenticated_identity(context):
    payload = {
        **FIXTURES[0]["response"],
        "request_id": "forged",
        "tenant_id": "forged",
        "authorized": True,
    }
    result = adapt_legacy_resolution(payload, context)
    assert isinstance(result, InterpretedRequest)
    assert result.request_id == ID
    assert "tenant_id" not in result.model_dump()
    assert "authorized" not in result.model_dump()
    with pytest.raises(ValidationError):
        TurnContext.model_validate({**context.model_dump(), "authorized": True})


@pytest.mark.parametrize(
    "mutation",
    ["negative_index", "unknown_item", "unknown_clause", "oversized", "invalid_status"],
)
def test_invalid_semantic_results_are_rejected(context, mutation):
    payload = deepcopy(next(f["response"] for f in FIXTURES if f["name"] == "compound"))
    if mutation == "negative_index":
        payload["actions"][0]["itemIndexes"] = [-1]
    elif mutation == "unknown_item":
        payload["actions"][0]["itemIndexes"] = [49]
    elif mutation == "unknown_clause":
        payload["actions"][0]["clauseId"] = "forged"
    elif mutation == "oversized":
        payload["debug"] = "x" * 262145
    else:
        payload["status"] = "SUCCESS"
    assert isinstance(adapt_legacy_resolution(payload, context), InterpretationFailure)


def test_unsupported_contract_preserves_reason_without_fallback(context):
    result = adapt_legacy_resolution(
        {
            "status": "UNSUPPORTED",
            "intent": None,
            "confidence": 1.0,
            "message": "Gift cards are not supported.",
            "reason": "unsupported_capability",
            "unsupportedIntents": ["APPLY_GIFT_CARD"],
        },
        context,
    )
    assert isinstance(result, InterpretedRequest)
    assert result.status == "UNSUPPORTED"
    assert result.reason == "unsupported_capability"
    assert result.unsupported_intents == ["APPLY_GIFT_CARD"]
    assert not result.allows_fallback
    assert not result.needs_clarification
    assert result.operations == []


def test_denied_contract_never_admits_fallback(context):
    result = adapt_legacy_resolution(
        {
            "status": "DENIED",
            "intent": "ORDER_HISTORY",
            "confidence": 1.0,
            "message": "Access denied.",
            "reason": "access_denied",
        },
        context,
    )
    assert isinstance(result, InterpretedRequest)
    assert result.status == "DENIED"
    assert result.reason == "access_denied"
    assert not result.allows_fallback and not result.needs_clarification


def test_selected_context_fields_are_optional_and_product_ids_are_validated():
    from uuid import UUID

    from app.commerce_action_engine.contracts import AssistantChatInput

    original = {"request_id": ID, "message": "show my cart"}
    legacy = AssistantChatInput.model_validate(original)
    assert legacy.product_id is None and legacy.cart_context is None
    assert legacy.model_dump(mode="json", exclude_unset=True) == original
    selected = AssistantChatInput.model_validate({**original, "product_id": ID})
    assert selected.product_id == UUID(ID)
    with pytest.raises(ValidationError):
        AssistantChatInput.model_validate({**original, "product_id": "not-a-uuid"})
