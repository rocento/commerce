"""The live boundary selects routes without consulting the legacy wire router."""

import pytest
from interpretation_helpers import standard_route
from test_enterprise_contracts import context as context  # noqa: PLC0414
from test_language_fallback import resolved

from app.commerce_action_engine.application.interpretation import interpret_resolution
from app.commerce_action_engine.contracts.interpretation import InterpretationFailure
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.execution.language.routing import route


@pytest.mark.parametrize(
    ("intent", "expected"),
    [
        ("PRODUCT_SEARCH", "search"),
        ("PRODUCT_COMPARE", "comparison"),
        ("CLEAR_COMPARISON", "comparison_clear"),
        ("ADD_TO_CART", "cart_action"),
        ("VIEW_CART", "cart"),
        ("VIEW_WISHLIST", "wishlist"),
        ("REMOVE_FROM_WISHLIST", "wishlist_remove"),
        ("CART_MOVE_FROM_WISHLIST", "wishlist_to_cart"),
        ("ORDER_STATUS", "order"),
        ("DELIVERY_STATUS", "delivery"),
        ("ACCOUNT_ADDRESS_LIST", "locations"),
        ("SUPPORT_TICKET_STATUS", "support"),
        ("SUPPORT_CHAT_HISTORY", "support_detail"),
        ("SHIPMENT_TRACKING", "shipment"),
        ("REORDER", "reorder"),
        ("UNRECOGNIZED", "unmapped"),
    ],
)
def test_standard_route_does_not_call_wire_router(
    monkeypatch, context, intent, expected
):
    def unexpected(*args):
        pytest.fail("Live routing must consume standard semantics")

    source = resolved(intent=intent)
    assert standard_route(source) == expected
    monkeypatch.setattr(gate, "route", unexpected, raising=False)
    decision = interpret_resolution(source, context)
    assert decision.route == expected
    # Semantic primary intent is deliberately not the legacy route discriminator.
    changed = decision.result.model_copy(update={"primary_intent": "VIEW_CART"})
    assert route(changed) == expected


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        ({"status": "DENIED"}, "denied"),
        ({"status": "UNSUPPORTED"}, "unsupported"),
        ({"status": "UNKNOWN"}, "fallback"),
        ({"status": "AMBIGUOUS"}, "clarify"),
        ({"confidence": 0.64}, "clarify"),
        ({"confidence": 0.65}, "search"),
        ({"missing": ["product"]}, "clarify"),
        ({"requestType": "COMPOUND", "operations": ["search"]}, "guided_action"),
        ({"requestType": "COMPOUND"}, "clarify"),
        ({"entities": {"requestConstraints": []}}, "clarify"),
        (
            {
                "intent": "PRODUCT_RECOMMEND",
                "entities": {"salesPeriod": "today", "discountRanking": True},
            },
            "bestsellers",
        ),
        (
            {
                "intent": "PRODUCT_RECOMMEND",
                "entities": {"salesPeriod": "invalid", "discountRanking": True},
            },
            "clarify",
        ),
        (
            {"intent": "PRODUCT_RECOMMEND", "entities": {"discountRanking": True}},
            "discounts",
        ),
    ],
)
def test_route_precedence(context, change, expected):
    assert (
        interpret_resolution(
            resolved(intent="PRODUCT_SEARCH").model_copy(update=change), context
        ).route
        == expected
    )


def test_failure_never_selects_reasoning(context):
    for code in ("unavailable", "invalid_response", "incompatible_version"):
        assert (
            route(InterpretationFailure(request_id=context.actor.request_id, code=code))
            == "unavailable"
        )


@pytest.mark.parametrize(
    "code", ["unavailable", "invalid_response", "incompatible_version"]
)
def test_failed_interpretation_always_supplies_a_fallback_reply(context, code):
    from app.commerce_action_engine.application.interpretation import (
        reasoning_fallback_message,
    )

    failure = InterpretationFailure(request_id=context.actor.request_id, code=code)
    assert reasoning_fallback_message(failure)


def test_empty_known_reply_is_still_a_model_fallback_block(context):
    from app.commerce_action_engine.application.interpretation import (
        reasoning_fallback_message,
    )

    request = interpret_resolution(resolved(message=""), context).result
    assert reasoning_fallback_message(request) == ""


def test_legacy_route_exports_are_retired():
    from app.commerce_action_engine.execution import language

    assert not hasattr(gate, "route")
    assert not hasattr(language, "route")
    assert "route" not in language.__all__
