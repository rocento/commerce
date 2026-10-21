"""Guidance uses the validated routing intent and preserves next-step wording."""

import pytest
from test_enterprise_contracts import context as context  # noqa: PLC0414
from test_language_fallback import resolved

from app.commerce_action_engine.application.handlers.guidance import guidance
from app.commerce_action_engine.application.interpretation import interpret_resolution


@pytest.mark.parametrize(
    ("intent", "request_type", "expected"),
    [
        (
            "REMOVE_FROM_WISHLIST",
            None,
            "Choose the saved product and confirm removal in your wishlist. Your wishlist has not been changed.",
        ),
        (
            "CLEAR_CART",
            None,
            "Open your cart to review the items and confirm this change. Your cart has not been changed.",
        ),
        (
            "CREATE_ORDER",
            None,
            "Review your cart, then continue to checkout to confirm delivery and payment. No order has been placed.",
        ),
        (
            "REORDER",
            None,
            "Choose the order in [My orders](/account/orders) to review the available actions and confirm your request. No order has been changed.",
        ),
        (
            "REORDER",
            "COMPOUND",
            "I understood the connected steps in your request. Review the items in your cart and use checkout to confirm the address, delivery time and payment. No cart or order changes have been made.",
        ),
        (
            "UNMAPPED",
            None,
            "Please open the item’s page to review and confirm this action. No changes have been made.",
        ),
    ],
)
def test_standard_guidance_preserves_wording(context, intent, request_type, expected):
    request = interpret_resolution(
        resolved(intent=intent, requestType=request_type), context
    ).result
    assert guidance(request) == expected
    assert (
        guidance(request.model_copy(update={"primary_intent": "VIEW_CART"})) == expected
    )
