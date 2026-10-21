"""Conversation metadata cannot inherit unbounded diagnostic trace payloads."""

import json

from app.commerce_action_engine.platform.store import message_metadata


def test_large_diagnostics_preserve_complete_recovery_evidence():
    metadata = {
        "response_source": "L",
        "completion": {"version": 1, "status": "completed"},
        "compound_plan_id": "00000000-0000-0000-0000-000000000001",
        "compound_action_states": ["succeeded", "succeeded"],
        "route_reason": "compound_plan_recovery",
        "core": {"trace": "x" * 4000},
        "intent_retrieval": {"sources": ["x" * 4000]},
    }
    result = message_metadata(metadata)
    assert result == {
        k: v for k, v in metadata.items() if k not in {"core", "intent_retrieval"}
    }
    assert len(json.dumps(result).encode()) <= 2048
    assert len(metadata["core"]["trace"]) == 4000


def test_oversized_unicode_field_is_omitted_whole_without_losing_source():
    result = message_metadata({"response_source": "R", "route_reason": "ع" * 2048})
    assert result == {"response_source": "R"}
    assert message_metadata(None) == {}
