"""Price-order wording describes only the matching products actually checked."""

import re

import pytest
from test_shopping import product

from app.commerce_action_engine.actions.catalog import Product
from app.commerce_action_engine.actions.shopping.contracts import (
    Constraint,
    ShoppingIntent,
)
from app.commerce_action_engine.application.shopping_presentation import render


@pytest.mark.parametrize(
    "sort_by,direction,order",
    [
        ("price_asc", "lowest to highest", [2, 3, 1]),
        ("price_desc", "highest to lowest", [1, 3, 2]),
    ],
)
def test_price_order_is_scoped_to_checked_matches(sort_by, direction, order):
    products = [
        Product.model_validate(product(number, price=price))
        for number, price in [(1, "99"), (2, "5"), (3, "12")]
    ]
    text = render(
        products, ShoppingIntent(shopping=True, query="shoes", sort_by=sort_by), None
    )
    assert (
        f"Among the products I checked, these matches are listed from {direction} price."
        in text
    )
    assert re.findall(r"/products/[0-9a-f-]{36}", text) == [
        product(number)["route"] for number in order
    ]
    assert "bounded candidate" not in text


@pytest.mark.parametrize(
    "sort_by,order",
    [("price_asc", [3, 2, 1]), ("price_desc", [3, 1, 2])],
)
def test_mixed_currencies_do_not_claim_one_overall_price_order(sort_by, order):
    products = [
        Product.model_validate(product(1, price="99", currency="USD")),
        Product.model_validate(product(2, price="5", currency="USD")),
        Product.model_validate(product(3, price="12", currency="EUR")),
    ]
    text = render(
        products, ShoppingIntent(shopping=True, query="shoes", sort_by=sort_by), None
    )
    assert "Among the products I checked" in text
    assert "within each currency." in text
    assert re.findall(r"/products/[0-9a-f-]{36}", text) == [
        product(number)["route"] for number in order
    ]


def test_alternatives_do_not_claim_to_follow_the_requested_price_order():
    products = [
        Product.model_validate(product(1, price="99")),
        Product.model_validate(product(2, price="5")),
    ]
    text = render(
        products,
        ShoppingIntent(
            shopping=True,
            query="shoes",
            sort_by="price_desc",
            attributes=[Constraint(name="material", value="leather")],
            alternatives=True,
        ),
        None,
    )
    assert "Alternatives — these do not meet every requirement:" in text
    assert "highest to lowest" not in text
    assert "Among the products I checked" not in text
    assert "Unmet or unverified: material=leather" in text


def test_empty_results_do_not_claim_a_price_order():
    text = render(
        [], ShoppingIntent(shopping=True, query="shoes", sort_by="price_desc"), None
    )
    assert "couldn’t find products matching your request" in text
    assert "highest to lowest" not in text
