"""Joined product recommendations retain constraints and bounded planning."""

import asyncio

import pytest
from test_catalog_schema import catalog_schema, schema_attribute
from test_shopping import interpreted, product, scenario

from app.commerce_action_engine.actions.catalog import CatalogSchema
from app.commerce_action_engine.actions.shopping import ShoppingIntent
from app.commerce_action_engine.actions.shopping.recommendations import (
    product_list_parts,
)
from app.commerce_action_engine.execution.language.gate import Resolution


@pytest.mark.parametrize("planning", [False, True])
@pytest.mark.parametrize("compound", [False, True])
def test_joined_recommendations_keep_compounds_filters_and_verified_items(
    planning, compound
):
    apples = product(1, name="Gala Apples", price="2.50", category="Fruit")
    bananas = product(2, name="Bananas", price="1.50", category="Fruit")
    expensive = product(3, name="Premium Bananas", price="9", category="Fruit")
    unavailable = product(
        4, name="Bananas", price="1", category="Fruit", in_stock=False
    )
    noise = product(5, name="Rice", price="1", category="Pantry")
    bundle = product(6, name="Apples and Bananas Box", price="3", category="Fruit")
    interpretation = interpreted(
        Resolution(
            status="RESOLVED",
            intent="PRODUCT_RECOMMEND",
            confidence=1.0,
            message="",
            entities={
                "productText": "apples and bananas",
                "category": "banana",
                "price": {"operator": "<", "value": 5},
                "currency": "USD",
            },
        )
    )

    def search(args):
        if args["query"] == "apples and bananas":
            return [bundle, noise] if compound else [apples, noise]
        return (
            [apples, noise]
            if args["query"] == "apples"
            else [bananas, expensive, unavailable, noise]
        )

    answer, calls = asyncio.run(
        scenario(
            "Recommend apples and bananas under $5 in stock",
            {},
            [],
            search_products=search,
            commerce_planning=planning,
            interpretation=interpretation,
        )
    )
    names = {p.name for b in answer.blocks for p in b.products or []}
    assert names == (
        {bundle["name"]} if compound else {apples["name"], bananas["name"]}
    ), repr(answer)
    assert [c["arguments"]["query"] for c in calls] == (
        ["apples and bananas"]
        if compound
        else ["apples and bananas", "apples", "bananas"]
    )
    assert all(
        c["arguments"]["max_price"] == "5" and c["arguments"]["in_stock"] for c in calls
    )


@pytest.mark.parametrize(
    "query",
    [
        "red apples and bananas",
        '"salt and pepper"',
        "apples and not bananas",
        "red and blue",
        "apples and bananas and pears and lemons",
        "apples and",
        "and bananas",
    ],
)
def test_ambiguous_or_qualified_lists_are_not_weakened(query):
    schema = CatalogSchema(
        **catalog_schema(
            "grocery", [schema_attribute("color", options=["red", "blue"])]
        )
    )
    assert product_list_parts(ShoppingIntent(shopping=True, query=query), schema) == []


def test_real_language_joined_recommendation_reaches_both_items():
    from test_language_understanding import real_resolve

    async def run():
        message = "Recommend apples and bananas"
        resolution = await real_resolve("", message)
        apples = product(1, name="Gala Apples", category="Fruit")
        bananas = product(2, name="Bananas", category="Fruit")
        answer, calls = await scenario(
            message,
            {},
            [],
            commerce_planning=True,
            interpretation=interpreted(resolution),
            search_products=lambda args: (
                []
                if "and" in args["query"]
                else [apples]
                if args["query"] == "apples"
                else [bananas]
            ),
        )
        assert {p.name for b in answer.blocks for p in b.products or []} == {
            "Gala Apples",
            "Bananas",
        }
        assert [c["arguments"]["query"] for c in calls] == [
            "apples and bananas",
            "apples",
            "bananas",
        ]

    asyncio.run(run())
