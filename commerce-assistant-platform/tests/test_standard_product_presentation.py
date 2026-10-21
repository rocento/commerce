"""Typed presentation preserves selection semantics without reading a wire envelope."""

import pytest
from test_enterprise_contracts import context as context  # noqa: PLC0414
from test_language_fallback import resolved

from app.commerce_action_engine.application.handlers.customer import wishlist_reference
from app.commerce_action_engine.application.handlers.product_guidance import (
    product_prompts,
    prompt_message,
)
from app.commerce_action_engine.application.interpretation import interpret_resolution


def request(context, entities):
    return interpret_resolution(
        resolved(
            intent="PRODUCT_ACTION_CHOICE", status="NEEDS_CONTEXT", entities=entities
        ),
        context,
    ).result


def test_items_take_precedence_and_preserve_quantities(context):
    value = request(
        context,
        {
            "productText": "ignored",
            "quantity": 99,
            "guideAction": "cart",
            "items": [
                {"productText": f"product {i}", "quantity": i + 1} for i in range(6)
            ],
        },
    )
    prompts = product_prompts(value)
    assert [p.query for p in prompts] == [f"product {i}" for i in range(6)]
    assert [p.quantity for p in prompts] == [1, 2, 3, 4, 5, 6]
    assert all(p.action == "cart" for p in prompts)
    assert "Nothing has been added or ordered yet." in prompt_message(prompts)


@pytest.mark.parametrize(
    "action,phrase",
    [
        ("choose", "What would you like to do?"),
        ("remove", "What would you like to do?"),
        ("compare", "Choose two to five products to compare."),
        ("cart", "Nothing has been added or ordered yet."),
    ],
)
def test_single_query_defaults_and_wording(context, action, phrase):
    prompts = product_prompts(
        request(context, {"productText": "Milk", "guideAction": action})
    )
    assert prompts[0].query == "Milk"
    assert prompts[0].quantity == 1
    assert phrase in prompt_message(prompts)


def test_query_list_uses_shared_quantity(context):
    prompts = product_prompts(
        request(context, {"productQueries": ["Milk", "Bread"], "quantity": 3})
    )
    assert [(p.query, p.quantity) for p in prompts] == [("Milk", 3), ("Bread", 3)]


@pytest.mark.parametrize(
    "entities",
    [
        {},
        {"productQueries": "milk"},
        {"items": ["milk"]},
        {"productText": "milk", "quantity": 0},
        {"productText": "milk", "guideAction": "buy"},
    ],
)
def test_malformed_prompt_never_becomes_a_partial_card(context, entities):
    with pytest.raises((ValueError, TypeError)):
        product_prompts(request(context, entities))


@pytest.mark.parametrize("value", [None, "Milk", "all", "all items", "everything"])
def test_wishlist_reference_is_preserved(context, value):
    assert wishlist_reference(request(context, {"productText": value})) == value


@pytest.mark.parametrize("value", [[], {}, 1, True])
def test_invalid_wishlist_reference_is_not_broadened(context, value):
    with pytest.raises(ValueError):
        wishlist_reference(request(context, {"productText": value}))
