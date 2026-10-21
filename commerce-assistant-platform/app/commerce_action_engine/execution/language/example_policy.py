"""Stable semantic fingerprinting of validated language examples."""

import hashlib
import json

from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.language.routing import route


def resolution_fingerprint(result: InterpretedRequest) -> str:
    """Pin example semantics and routing, independent of heuristic confidence."""
    value = {
        "intent": result.legacy_intent,
        "entities": result.entities,
        "route": route(result),
        "requires_confirmation": result.requires_confirmation,
        "request_type": result.request_type,
        "operations": result.operations,
    }
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
