"""Deterministic next-step wording for validated interpretations."""

from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.language.handoffs import (
    CONTEXT_INTENTS,
    HANDOFFS,
)


def guidance(result: InterpretedRequest) -> str:
    if result.legacy_intent is not None and result.legacy_intent in HANDOFFS:
        return HANDOFFS[result.legacy_intent].message()
    if result.legacy_intent in CONTEXT_INTENTS:
        return "Please include the full action and the product or order you mean, or use the controls on the previous result. This reply alone has not changed anything."
    if result.legacy_intent == "REMOVE_FROM_WISHLIST":
        return "Choose the saved product and confirm removal in your wishlist. Your wishlist has not been changed."
    if result.request_type == "COMPOUND":
        return "I understood the connected steps in your request. Review the items in your cart and use checkout to confirm the address, delivery time and payment. No cart or order changes have been made."
    if result.legacy_intent in {
        "REMOVE_FROM_CART",
        "CLEAR_CART",
        "UPDATE_CART_QUANTITY",
    }:
        return "Open your cart to review the items and confirm this change. Your cart has not been changed."
    if result.legacy_intent in {"START_CHECKOUT", "CONTINUE_CHECKOUT", "CREATE_ORDER"}:
        return "Review your cart, then continue to checkout to confirm delivery and payment. No order has been placed."
    if result.legacy_intent in {"CANCEL_ORDER", "REORDER", "RETURN_ITEM"}:
        return "Choose the order in [My orders](/account/orders) to review the available actions and confirm your request. No order has been changed."
    return "Please open the item’s page to review and confirm this action. No changes have been made."
