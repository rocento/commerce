"""Conservative, content-free task outcomes, separate from the SSE lifecycle.

Only application-owned handlers may attach ``completion_evidence`` after checking
an authoritative result. Neither a resolved intent, a tool attempt, a response
block nor a normally ended request is evidence that the shopper's task succeeded.
"""

import re
from collections.abc import Iterable, Mapping
from uuid import UUID

EVIDENCE = frozenset(
    {"read_result", "action_receipt", "policy_answer", "conversation_reply"}
)
STATUSES = frozenset(
    {
        "completed",
        "clarification",
        "handoff",
        "unsupported",
        "unavailable",
        "denied",
        "disconnected",
        "unverified",
    }
)
_CLARIFICATION_ROUTES = frozenset(
    {
        "language_engine_clarify",
        "language_engine_context",
        "product_action_choice",
        "delivery_location_required",
        "reorder_review",
    }
)
_HANDOFF_ROUTES = frozenset(
    {
        "language_engine_handoff",
        "language_engine_guided_action",
        "order_guidance",
        "saved_addresses",
        "new_address_form",
    }
)
_UNAVAILABLE_ROUTES = frozenset(
    {
        "language_engine_unavailable",
        "catalog_unavailable",
        "model_budget_exhausted",
        "unconfigured_model",
    }
)
_CHOICE_BLOCKS = frozenset(
    {"product_prompt", "cart_removal_choice", "order_confirmation", "address_form"}
)


def _intent(value: object) -> str | None:
    return (
        value
        if isinstance(value, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", value)
        else None
    )


def _positive_count(value: object) -> bool:
    return type(value) is int and value > 0


def completion_context(
    value: object, *, request_id: object, matches_original: bool
) -> dict[str, object] | None:
    """Project stored metadata into a bounded, content-free recovery context."""
    if not isinstance(value, Mapping) or value.get("version") != 1:
        return None
    status, mode = value.get("status"), value.get("mode")
    if (
        not isinstance(status, str)
        or status not in STATUSES
        or not isinstance(mode, str)
        or mode not in {"deterministic", "model_assisted"}
    ):
        return None
    try:
        source_request = str(UUID(str(request_id)))
    except (ValueError, TypeError, AttributeError):
        return None
    return {
        "request_id": source_request,
        "matches_original": matches_original is True,
        "completion": {
            "version": 1,
            "status": status,
            "mode": mode,
            "intent": _intent(value.get("intent")),
        },
    }


def completion_metadata(
    metadata: Mapping[str, object],
    *,
    outcome: str,
    blocks: Iterable[Mapping[str, object]] = (),
    clarification_reply: bool = False,
    prior_completion: Mapping[str, object] | None = None,
) -> dict[str, object]:
    """Return ``{'completion': ...}`` for message persistence and metrics.

    ``clarification_reply`` means the application revalidated the original request
    with the reply. A client clarification payload alone must not set it. The
    supplied prior context must come from the scoped, expiring store query; exact
    original-question binding and matching intent are required in addition.
    """
    gate_value = metadata.get("language_gate")
    gate = gate_value if isinstance(gate_value, Mapping) else {}
    intent = _intent(gate.get("intent"))
    route_value = metadata.get("route_reason")
    route = route_value if isinstance(route_value, str) else ""
    gate_status_value = gate.get("status")
    gate_status = gate_status_value if isinstance(gate_status_value, str) else ""
    evidence = metadata.get("completion_evidence")
    evidence = evidence if isinstance(evidence, str) and evidence in EVIDENCE else None
    disposition = metadata.get("completion_disposition")
    disposition = (
        disposition
        if isinstance(disposition, str)
        and disposition in STATUSES - {"completed", "disconnected"}
        else None
    )
    current_model_attempted = (
        _positive_count(metadata.get("model_attempts"))
        or _positive_count(metadata.get("model_calls"))
        or metadata.get("response_source") == "L"
    )

    # Failure and pending-work evidence always outrank a success marker.
    if outcome == "disconnected":
        status = "disconnected"
    elif (
        outcome == "denied"
        or metadata.get("resolution_status") == "DENIED"
        or route in {"access_denied", "login_required"}
    ):
        status = "denied"
    elif (
        outcome != "completed"
        or metadata.get("failure_code")
        or route in _UNAVAILABLE_ROUTES
        or gate_status == "UNAVAILABLE"
    ):
        status = "unavailable"
    elif disposition is not None:
        status = disposition
    elif gate_status == "UNSUPPORTED" or route in {
        "unsupported_capability",
        "resolved_intent_without_capability",
    }:
        status = "unsupported"
    elif (
        gate_status in {"NEEDS_CONTEXT", "AMBIGUOUS"}
        or route in _CLARIFICATION_ROUTES
        or any(
            isinstance(block.get("kind"), str) and block.get("kind") in _CHOICE_BLOCKS
            for block in blocks
        )
    ):
        status = "clarification"
    elif route in _HANDOFF_ROUTES:
        status = "handoff"
    elif evidence is not None:
        status = "completed"
    else:
        status = "unverified"

    previous = prior_completion or {}
    previous_value = previous.get("completion")
    previous_result = previous_value if isinstance(previous_value, Mapping) else {}
    linked = bool(
        clarification_reply
        and previous.get("matches_original") is True
        and previous_result.get("version") == 1
        and previous_result.get("status") == "clarification"
        and intent is not None
        and intent == _intent(previous_result.get("intent"))
    )
    mode = (
        "model_assisted"
        if current_model_attempted
        or (linked and previous_result.get("mode") == "model_assisted")
        else "deterministic"
    )
    result: dict[str, object] = {
        "version": 1,
        "request_completed": outcome == "completed",
        "model_attempted": current_model_attempted,
        "mode": mode,
        "status": status,
        "task_completed": status == "completed",
        "evidence": evidence if status == "completed" else None,
        "intent": intent,
        "clarification_reply": linked,
        "clarification_recovered": linked and status == "completed",
    }
    if linked:
        try:
            result["clarification_source_request_id"] = str(
                UUID(str(previous.get("request_id")))
            )
        except (ValueError, TypeError, AttributeError):
            # Malformed provenance can never establish a recovery.
            result["clarification_reply"] = False
            result["clarification_recovered"] = False
    return {"completion": result}
