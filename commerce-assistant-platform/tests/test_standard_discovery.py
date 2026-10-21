"""Catalog plan mapping consumes validated standard interpretations."""

import pytest
from test_enterprise_contracts import context as context  # noqa: PLC0414
from test_language_fallback import resolved

from app.commerce_action_engine.application.interpretation import (
    interpret_resolution,
    shopping_plan,
)
from app.commerce_action_engine.contracts.interpretation import InterpretationFailure
from app.commerce_action_engine.execution.language import gate


@pytest.mark.parametrize(
    "entities,message",
    [
        ({"productText": "shoes", "color": "red"}, "find red shoes"),
        ({"category": "shoes", "productText": "shoes"}, "recommend shoes"),
        (
            {
                "productText": "shoes",
                "price": {"operator": "<", "value": 100, "currency": "USD"},
            },
            "find shoes under $100",
        ),
        (
            {
                "productText": "shoes",
                "sort_by": "price_asc",
                "recommendationFollowup": "cheaper",
                "excludedProducts": ["abc"],
            },
            "find cheapest shoes",
        ),
        (
            {
                "productText": "shoes",
                "merchantAttributes": [{"name": "finish", "value": "matte"}],
            },
            "find shoes",
        ),
    ],
)
def test_standard_mapping_needs_no_wire_plan(context, entities, message):
    source = resolved(intent="PRODUCT_RECOMMEND", entities=entities)
    decision = interpret_resolution(source, context)
    expected = shopping_plan(decision.result, message)
    assert expected is not None
    assert not hasattr(gate, "shopping_plan")
    assert shopping_plan(decision.result, message) == expected
    assert (
        shopping_plan(
            decision.result.model_copy(update={"primary_intent": "VIEW_CART"}), message
        )
        == expected
    )


@pytest.mark.parametrize(
    "change",
    [
        {"status": "UNKNOWN"},
        {"status": "DENIED"},
        {"status": "UNSUPPORTED"},
        {"confidence": 0.64},
        {"requestType": "COMPOUND"},
        {"requiresConfirmation": True},
        {"entities": {"requestConstraints": []}},
        {"entities": {"items": "invalid"}},
    ],
)
def test_unsafe_or_invalid_interpretation_has_no_plan(context, change):
    source = resolved(
        intent="PRODUCT_SEARCH", entities={"productText": "shoes"}
    ).model_copy(update=change)
    assert (
        shopping_plan(interpret_resolution(source, context).result, "find shoes")
        is None
    )


def test_failure_has_no_plan(context):
    assert (
        shopping_plan(
            InterpretationFailure(
                request_id=context.actor.request_id, code="unavailable"
            ),
            "find shoes",
        )
        is None
    )
