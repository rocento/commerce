"""Canonical deterministic route precedence over interpretation semantics."""

from app.commerce_action_engine.actions.catalog.product_facts import (
    PRODUCT_FACT_INTENTS,
)
from app.commerce_action_engine.contracts.interpretation import InterpretationFailure
from app.commerce_action_engine.execution.language.handoffs import (
    CONTEXT_INTENTS,
    HANDOFFS,
)
from app.commerce_action_engine.execution.planning.compound_review import (
    ReviewInput,
    is_reviewed_pair,
)
from app.commerce_contracts.language_proposal import CONVERSATION_INTENTS

# Intents with a deterministic assistant-to-commerce capability mapping.
# Several share a read endpoint; the workflow still validates intent-specific
# slots and requires confirmation before any write.
CATALOG_API_INTENTS = frozenset(
    {
        "PRODUCT_SEARCH",
        "PRODUCT_COMPARE",
        "PRODUCT_RECOMMEND",
        "ADD_TO_CART",
        "PRODUCT_REVIEWS",
        "PRODUCT_RATING",
        "PRODUCT_PHOTOS",
        "PRODUCT_VIDEO",
        "PRODUCT_MANUAL",
        "PRODUCT_ALLERGENS",
        "PRODUCT_NUTRITION",
        "PRODUCT_SIZE_GUIDE",
    }
)
CART_API_INTENTS = frozenset(
    {
        "VIEW_CART",
        "CART_TOTAL",
        "CART_ITEM_COUNT",
        "REMOVE_FROM_CART",
        "CLEAR_CART",
        "UPDATE_CART_QUANTITY",
        "START_CHECKOUT",
        "CONTINUE_CHECKOUT",
        "CREATE_ORDER",
    }
)
WISHLIST_API_INTENTS = frozenset(
    {"VIEW_WISHLIST", "ADD_TO_WISHLIST", "REMOVE_FROM_WISHLIST"}
)
ORDER_API_INTENTS = frozenset(
    {
        "TRACK_ORDER",
        "ORDER_HISTORY",
        "ORDER_STATUS",
        "ORDER_VIEW",
        "VIEW_ORDER",
        "ORDER_DETAILS",
        "ORDER_CANCEL_ELIGIBILITY",
        "ORDER_CANCEL_STATUS",
        "ORDER_DAMAGED",
        "ORDER_WRONG_ITEM",
    }
)
DELIVERY_API_INTENTS = frozenset({"DELIVERY_STATUS"})
LOCATION_API_INTENTS = frozenset(
    {
        "ACCOUNT_ADDRESS_LIST",
        "ACCOUNT_ADDRESS_ADD",
        "ACCOUNT_ADDRESS_REMOVE",
        "ACCOUNT_ADDRESS_DEFAULT",
    }
)
SUPPORT_API_INTENTS = frozenset(
    {
        "SUPPORT_TICKET_STATUS",
        "SUPPORT_TICKET_CLOSE",
        "SUPPORT_TICKET_REOPEN",
        "SUPPORT_ESCALATE",
        "SUPPORT_CALLBACK",
        "SUPPORT_CHAT_HISTORY",
    }
)
SHIPMENT_API_INTENTS = frozenset({"SHIPMENT_TRACKING", "ORDER_SHIPMENT_STATUS"})
SUPPORT_DETAIL_API_INTENTS = frozenset({"SUPPORT_CHAT_HISTORY"})
WISHLIST_WRITE_API_INTENTS = frozenset({"REMOVE_FROM_WISHLIST"})
ASSISTANT_API_INTENTS = (
    CATALOG_API_INTENTS
    | PRODUCT_FACT_INTENTS
    | CART_API_INTENTS
    | WISHLIST_API_INTENTS
    | ORDER_API_INTENTS
    | DELIVERY_API_INTENTS
    | LOCATION_API_INTENTS
    | SUPPORT_API_INTENTS
    | SHIPMENT_API_INTENTS
    | SUPPORT_DETAIL_API_INTENTS
    | WISHLIST_WRITE_API_INTENTS
)
CONFIRMATION_CONTEXT_INTENTS = frozenset(
    {
        "REMOVE_FROM_CART",
        "CLEAR_CART",
        "UPDATE_CART_QUANTITY",
        "START_CHECKOUT",
        "CONTINUE_CHECKOUT",
        "CREATE_ORDER",
        "ADD_TO_WISHLIST",
        "REMOVE_FROM_WISHLIST",
        "ORDER_DAMAGED",
        "ORDER_WRONG_ITEM",
        "ACCOUNT_ADDRESS_ADD",
        "ACCOUNT_ADDRESS_REMOVE",
        "ACCOUNT_ADDRESS_DEFAULT",
        "SUPPORT_TICKET_CLOSE",
        "SUPPORT_TICKET_REOPEN",
        "SUPPORT_ESCALATE",
        "SUPPORT_CALLBACK",
    }
)
CART_ACTION_INTENTS = frozenset(
    {
        "ADD_TO_CART",
        "ADD_TO_WISHLIST",
        "CART_MOVE_TO_WISHLIST",
        "REMOVE_FROM_CART",
        "CLEAR_CART",
        "UPDATE_CART_QUANTITY",
        "START_CHECKOUT",
        "CONTINUE_CHECKOUT",
        "CREATE_ORDER",
    }
)


def route(result: ReviewInput | InterpretationFailure | None) -> str:
    if result is None or isinstance(result, InterpretationFailure):
        return "unavailable"
    if result.status == "DENIED":
        return "denied"
    if result.status == "UNSUPPORTED":
        return "unsupported"
    if "requestConstraints" in result.entities:
        return "clarify"
    # Even a resolved pair belongs exclusively to complete-request planning.
    # It must never select a single-action route or model fallback.
    if is_reviewed_pair(result) or result.compound_interpretation_version is not None:
        return "clarify"
    if result.status == "UNKNOWN":
        return "fallback"
    if result.status in {"AMBIGUOUS", "NEEDS_CONTEXT"}:
        return "clarify"
    if result.confidence.raw < 0.65 or result.missing:
        return "clarify"
    if result.request_type == "COMPOUND" and result.operations:
        return "guided_action"
    if result.request_type:
        return "clarify"
    if result.legacy_intent in CONVERSATION_INTENTS:
        return "conversation"
    if (
        result.legacy_intent in {"PRODUCT_RECOMMEND", "PRODUCT_BESTSELLERS"}
        and "salesPeriod" in result.entities
    ):
        return (
            "bestsellers"
            if isinstance(result.entities["salesPeriod"], str)
            and result.entities["salesPeriod"]
            in {"today", "last_week", "last_month", "last_year"}
            else "clarify"
        )
    if (
        result.legacy_intent == "PRODUCT_RECOMMEND"
        and result.entities.get("discountRanking") is True
    ):
        return "discounts"
    if result.legacy_intent in CART_ACTION_INTENTS:
        return "cart_action"
    if result.legacy_intent == "CLEAR_COMPARISON":
        return "comparison_clear" if not result.entities else "clarify"
    if result.legacy_intent == "PRODUCT_COMPARE":
        return "comparison"
    if result.legacy_intent == "CART_MOVE_FROM_WISHLIST":
        return "wishlist_to_cart"
    if result.legacy_intent in PRODUCT_FACT_INTENTS:
        return "product_fact"
    if result.legacy_intent is not None and result.legacy_intent in HANDOFFS:
        return "handoff"
    if result.legacy_intent in CONTEXT_INTENTS:
        return "context"
    if result.legacy_intent in CATALOG_API_INTENTS:
        return "search"
    if result.legacy_intent == "ADD_TO_WISHLIST":
        return "search"
    if result.legacy_intent in CART_API_INTENTS - CONFIRMATION_CONTEXT_INTENTS:
        return "cart"
    if result.legacy_intent in WISHLIST_API_INTENTS - {"ADD_TO_WISHLIST"}:
        if result.legacy_intent == "REMOVE_FROM_WISHLIST":
            return "wishlist_remove"
        return "wishlist"
    if result.legacy_intent in ORDER_API_INTENTS:
        return "order"
    if result.legacy_intent in DELIVERY_API_INTENTS:
        return "delivery"
    if result.legacy_intent in LOCATION_API_INTENTS:
        return "locations"
    if result.legacy_intent in SUPPORT_DETAIL_API_INTENTS:
        return "support_detail"
    if result.legacy_intent in SUPPORT_API_INTENTS:
        return "support"
    if result.legacy_intent in SHIPMENT_API_INTENTS:
        return "shipment"
    if result.legacy_intent == "REORDER":
        return "reorder"
    if (
        result.legacy_intent
        in {
            *CONFIRMATION_CONTEXT_INTENTS,
            "CANCEL_ORDER",
            "REORDER",
            "RETURN_ITEM",
        }
        or result.requires_confirmation
    ):
        return "guided_action"
    return "unmapped"
