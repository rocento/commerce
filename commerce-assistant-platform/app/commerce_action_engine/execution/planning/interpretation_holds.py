"""Shared semantic holds for wire ingress and standard follow-up mutations."""

from dataclasses import dataclass, replace
from typing import Literal, cast

from app.commerce_action_engine.contracts.requested_actions import Issue
from app.commerce_action_engine.execution.planning.compound_review import (
    ReviewInput,
    admitted_pair,
    consistent_interpretation,
    is_reviewed_pair,
)

Status = Literal[
    "RESOLVED", "NEEDS_CONTEXT", "AMBIGUOUS", "UNKNOWN", "UNSUPPORTED", "DENIED"
]


@dataclass(frozen=True)
class InterpretationHold:
    status: Status
    confidence: float
    message: str
    missing: list[str]
    issues: list[Issue] | None


def normalize_holds(result: ReviewInput, message: str) -> InterpretationHold:
    """Return held fields without mutating input or granting execution authority."""
    hold = _action_hold(result, message)
    if "requestConstraints" in result.entities and hold.status not in {
        "DENIED",
        "UNSUPPORTED",
    }:
        missing = list(hold.missing)
        if "requestConstraints" not in missing:
            missing.append("requestConstraints")
        hold = replace(
            hold,
            status="NEEDS_CONTEXT",
            confidence=0.0,
            missing=missing,
            message=hold.message
            or "Please specify a product or conditions I can verify. No changes have been made.",
        )
    return hold


def _action_hold(result: ReviewInput, message: str) -> InterpretationHold:
    metadata = result.requested_actions
    status = cast(Status, result.status)
    confidence = result.confidence.raw
    missing = list(result.missing)
    issues = (
        list(metadata.requestedActionIssues)
        if metadata.requestedActionIssues is not None
        else None
    )
    if status in {"DENIED", "UNSUPPORTED"}:
        return InterpretationHold(status, confidence, message, missing, issues)
    complete_pair = admitted_pair(result)
    if result.compound_reply and not complete_pair:
        status = "NEEDS_CONTEXT"
    if metadata.requestedActionsVersion != 1:
        if result.compound_interpretation_version is not None:
            raise ValueError(
                "Complete compound interpretation requires action metadata"
            )
        return InterpretationHold(status, confidence, message, missing, issues)
    conflict = "INTERPRETATION_CONFLICT" in (issues or [])
    if (
        result.compound_interpretation_version is not None
        and not consistent_interpretation(result)
    ):
        conflict = True
        if "INTERPRETATION_CONFLICT" not in (issues or []):
            issues = [*(issues or []), "INTERPRETATION_CONFLICT"]
    if (
        status == "RESOLVED"
        and metadata.intentCountStatus == "EXACT"
        and not result.request_type
    ):
        actions = metadata.requestedActions or []
        conflict = (
            conflict
            or len(actions) > 1
            or (len(actions) == 1 and actions[0].intent != result.legacy_intent)
        )
        if conflict and "INTERPRETATION_CONFLICT" not in (issues or []):
            issues = [*(issues or []), "INTERPRETATION_CONFLICT"]
    empty = metadata.intentCountStatus == "EXACT" and metadata.intentCount == 0
    if conflict or empty:
        status, confidence = "NEEDS_CONTEXT", 0.0
        if "requestedActions" not in missing:
            missing.append("requestedActions")
        message = (
            "No affirmative action remains in your request. What would you like to do?"
            if empty
            else "Please confirm the complete request, including each action and its product. No changes have been made."
        )
    if (
        (is_reviewed_pair(result) or result.compound_reply)
        and status != "AMBIGUOUS"
        and not complete_pair
    ):
        status = "NEEDS_CONTEXT"
    return InterpretationHold(status, confidence, message, missing, issues)
