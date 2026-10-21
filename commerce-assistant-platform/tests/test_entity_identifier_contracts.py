"""Numeric metadata stays compatible with UUID actions and historical assistant records."""

import pytest
from pydantic import ValidationError

from app.commerce_action_engine.contracts import (
    AssistantSavedLocation,
    AssistantTicket,
    AssistantTicketMessage,
)

ID = "00000000-0000-0000-0000-00000000002a"
CASES = [
    (
        AssistantSavedLocation,
        {
            "id": ID,
            "label": "Home",
            "formatted_address": "Private address",
            "is_default": True,
        },
    ),
    (
        AssistantTicket,
        {
            "id": ID,
            "number": 7,
            "subject": "Order question",
            "category": "order_issue",
            "status": "open",
            "priority": "normal",
            "order_id": None,
            "created_at": "2026-09-23T10:00:00Z",
        },
    ),
    (
        AssistantTicketMessage,
        {
            "id": ID,
            "sender": "admin",
            "body": "We are checking.",
            "created_at": "2026-09-23T10:05:00Z",
        },
    ),
]


@pytest.mark.parametrize("model,payload", CASES)
def test_numeric_metadata_preserves_uuid_identity(model, payload):
    stored = model.model_validate({**payload, "entity_id": 42})
    serialized = stored.model_dump(mode="json")
    assert serialized["entity_id"] == 42
    assert serialized["id"] == ID
    assert model.model_validate(serialized).entity_id == 42


@pytest.mark.parametrize("model,payload", CASES)
def test_historical_records_omit_missing_numeric_metadata(model, payload):
    historical = model.model_validate(payload)
    # Omit absent metadata when a historical record is serialized into SSE;
    # the frontend contract permits omission, but does not accept a null ID.
    assert "entity_id" not in historical.model_dump(mode="json")
    assert "entity_id" not in model.model_validate(
        {**payload, "entity_id": None}
    ).model_dump(mode="json")


@pytest.mark.parametrize("model,payload", CASES)
@pytest.mark.parametrize("invalid", [0, -1, 9007199254740992, True, "42", 1.5])
def test_numeric_metadata_rejects_invalid_identifiers(model, payload, invalid):
    with pytest.raises(ValidationError):
        model.model_validate({**payload, "entity_id": invalid})
