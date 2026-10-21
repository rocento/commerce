"""Pure compound review/admission shared by ingress validation and standard planning."""

from dataclasses import dataclass
from typing import Protocol

from pydantic import JsonValue

from app.commerce_action_engine.contracts.interpretation import Confidence
from app.commerce_action_engine.contracts.requested_actions import (
    RequestedActionMetadata,
)


class ReviewInput(Protocol):
    """Read-only semantics; neither trusted identity nor commerce capability."""

    @property
    def status(self) -> str: ...

    @property
    def legacy_intent(self) -> str | None: ...

    @property
    def primary_intent(self) -> str | None: ...

    @property
    def request_type(self) -> str | None: ...

    @property
    def confidence(self) -> Confidence: ...

    @property
    def requires_confirmation(self) -> bool: ...

    @property
    def requested_actions(self) -> RequestedActionMetadata: ...

    @property
    def compound_reply(self) -> str | None: ...

    @property
    def compound_interpretation_version(self) -> int | None: ...

    @property
    def entities(self) -> dict[str, JsonValue]: ...

    @property
    def operations(self) -> list[str]: ...

    @property
    def missing(self) -> list[str]: ...

    @property
    def unsupported_intents(self) -> list[str]: ...

    @property
    def reason(self) -> str | None: ...


@dataclass(frozen=True)
class ReviewSemantics:
    """Canonical values for ingress review before identity-bound interpretation."""

    status: str
    legacy_intent: str | None
    primary_intent: str | None
    request_type: str | None
    confidence: Confidence
    requires_confirmation: bool
    requested_actions: RequestedActionMetadata
    compound_reply: str | None
    compound_interpretation_version: int | None
    entities: dict[str, JsonValue]
    operations: list[str]
    missing: list[str]
    unsupported_intents: list[str]
    reason: str | None


@dataclass(frozen=True)
class Review:
    state: str
    message: str
    needs_reply: bool = False


def is_reviewed_pair(result: ReviewInput) -> bool:
    actions = result.requested_actions.requestedActions or []
    return (
        result.requested_actions.requestedActionsVersion == 1
        and len(actions) == 2
        and {action.intent for action in actions} == {"ADD_TO_CART", "ADD_TO_WISHLIST"}
    )


def consistent_interpretation(result: ReviewInput) -> bool:
    """Independently check the complete Node projection; this grants no authority."""
    actions = result.requested_actions.requestedActions or []
    return bool(
        result.compound_interpretation_version == 1
        and is_reviewed_pair(result)
        and result.request_type == "MULTI_ACTION"
        and result.legacy_intent is None
        and result.primary_intent is None
        and result.requested_actions.intentCountStatus == "EXACT"
        and result.requested_actions.intentCount == 2
        and result.requested_actions.uniqueIntentCount == 2
        and result.requires_confirmation
        and not result.requested_actions.requestedActionIssues
        and not result.missing
        and not result.unsupported_intents
        and result.reason is None
        and result.compound_reply in {None, "filled", "replaced"}
        and all(
            a.id == f"request{i + 1}"
            and (a.after is None or (i > 0 and a.after == "request1"))
            and len(a.items) == 1
            and a.items[0].productText
            and len(a.items[0].productText.strip()) > 0
            and len(a.items[0].productText) <= 200
            and not a.items[0].unit
            and not a.items[0].reference
            and not a.items[0].resolvedFrom
            and not a.items[0].selectionStrategy
            for i, a in enumerate(actions)
        )
        and result.entities
        == {"items": [a.items[0].model_dump(exclude_none=True) for a in actions]}
        and result.operations
        == [
            "ADD_ITEM" if a.intent == "ADD_TO_CART" else "SAVE_TO_WISHLIST"
            for a in actions
        ]
    )


def admitted_pair(result: ReviewInput) -> bool:
    """Fresh, resolved language input eligible for compound planning only."""
    return (
        result.status == "RESOLVED"
        and result.confidence.raw >= 0.65
        and consistent_interpretation(result)
    )


def review(result: ReviewInput) -> Review | None:
    if result.status in {"DENIED", "UNSUPPORTED"}:
        return None
    if not is_reviewed_pair(result) and not result.compound_reply:
        return None
    if result.compound_reply == "cancelled":
        return Review("cancelled", "Cancelled this request. No changes have been made.")
    issues = set(result.requested_actions.requestedActionIssues or [])
    if "INTERPRETATION_CONFLICT" in issues:
        return Review(
            "needs_request",
            "Please restate both actions with each product, quantity and destination. The interpretations disagree, so no changes have been made.",
            True,
        )
    if "requestConstraints" in result.entities or issues - {
        "INTERPRETATION_CONFLICT",
        "UNRESOLVED_PRODUCT",
    }:
        return Review(
            "needs_request",
            "Please restate the complete request with each product, quantity and destination. I cannot safely resolve its conditions or alternatives. No changes have been made.",
            True,
        )
    if "UNRESOLVED_PRODUCT" in issues or any(
        not action.items
        or any(not item.productText or item.reference for item in action.items)
        for action in result.requested_actions.requestedActions or []
    ):
        return Review(
            "needs_product",
            "Which product do you mean? Give its full name. I will keep both the cart and wishlist actions. No changes have been made.",
            True,
        )
    if (
        result.requested_actions.intentCountStatus != "EXACT"
        or not result.requested_actions.requestedActions
    ):
        return Review(
            "needs_request",
            "Please restate the complete request with each product and destination. No changes have been made.",
            True,
        )
    descriptions = []
    for action in result.requested_actions.requestedActions:
        names = ", ".join(
            f"{item.quantity or 1} {item.unit + ' ' if item.unit else ''}{item.productText or 'unresolved product'}"
            for item in action.items
        )
        descriptions.append(
            f"Add {names[:300]} to {'cart' if action.intent == 'ADD_TO_CART' else 'wishlist'}"
        )
    return Review(
        "understood",
        "Requested actions: "
        + "; ".join(descriptions)
        + ". No changes have been made. "
        "Combined cart and wishlist execution is not available yet. Please send each action separately to continue.",
    )
