"""Phase 9 discovery query mapping contract tests."""

import pytest

from app.commerce_action_engine.actions.catalog.workflow import map_discovery_request
from app.commerce_action_engine.actions.shopping import ShoppingIntent
from app.commerce_action_engine.contracts.interpretation import (
    Confidence,
    InterpretedRequest,
)


def resolved(**updates):
    return InterpretedRequest.model_validate(
        {
            "request_id": "00000000-0000-0000-0000-000000000001",
            "status": "RESOLVED",
            "legacy_intent": "PRODUCT_SEARCH",
            "message": "Understood",
            "confidence": Confidence(raw=0.9),
            "entities": {"productText": "shoes"},
            **updates,
        }
    )


@pytest.mark.parametrize(
    "entities,message,expected",
    [
        (
            {"productText": "shoes", "color": "black", "brand": "Acme"},
            "find black Acme shoes",
            {"query": "shoes", "brand": "Acme", "attributes": ["black"]},
        ),
        (
            {
                "category": "phones",
                "price": {
                    "operator": "BETWEEN",
                    "min": 100,
                    "max": 300,
                    "currency": "EGP",
                },
            },
            "find phones from 100 to 300 EGP",
            {
                "category": "phones",
                "min_price": "100",
                "max_price": "300",
                "currency": "EGP",
            },
        ),
        (
            {
                "productText": "shoes",
                "price": {"operator": "<", "value": 120, "currency": "USD"},
            },
            "find shoes under $120",
            {"max_price": "120", "currency": "USD", "exclusive_max": True},
        ),
    ],
)
def test_maps_supported_search_constraints(entities, message, expected):
    plan = map_discovery_request(resolved(entities=entities), message, ShoppingIntent)
    assert plan is not None
    for key, value in expected.items():
        actual = getattr(plan, key)
        if key == "attributes":
            assert [item.value for item in actual] == value
        else:
            assert actual == value


def test_numeric_budget_without_currency_defers_to_store_market():
    plan = map_discovery_request(
        resolved(
            entities={"productText": "shoes", "price": {"operator": "<", "value": 100}}
        ),
        "find shoes under 100",
        ShoppingIntent,
    )
    assert plan is not None
    assert plan.clarification is None
    assert plan.currency is None
    assert plan.max_price == "100" and plan.exclusive_max


def test_recommend_category_maps_to_live_catalog_search():
    plan = map_discovery_request(
        resolved(
            legacy_intent="PRODUCT_RECOMMEND", entities={"productText": "best frutes"}
        ),
        "pls recommend best fruits",
        ShoppingIntent,
    )
    assert plan is not None
    assert plan.query == "frutes"
    assert plan.presentation == "recommend"


@pytest.mark.parametrize(
    "entities,expected_category",
    [
        ({"productText": "best dates", "category": "dates"}, "dates"),
        ({"category": "fruit"}, "fruit"),
        ({"productText": "bananas", "category": "banana"}, "banana"),
    ],
)
def test_category_recommendations_search_across_the_category(
    entities, expected_category
):
    plan = map_discovery_request(
        resolved(legacy_intent="PRODUCT_RECOMMEND", entities=entities),
        "recommend " + (entities.get("productText") or expected_category),
        ShoppingIntent,
    )
    assert plan is not None
    assert plan.presentation == "recommend"
    assert plan.category == expected_category
    assert plan.query == ("bananas" if expected_category == "banana" else "*")


@pytest.mark.parametrize(
    "result,message",
    [
        (resolved(status="UNKNOWN"), "fish"),
        (resolved(request_type="COMPOUND"), "add shoes and checkout"),
        (
            resolved(entities={"productText": "shoes", "product_reference": "CURRENT"}),
            "find them",
        ),
        (
            resolved(entities={"productText": "shoes", "excluded": {"color": ["red"]}}),
            "find shoes except red",
        ),
    ],
)
def test_unsupported_or_unresolved_requests_do_not_form_catalog_plans(result, message):
    assert map_discovery_request(result, message, ShoppingIntent) is None


@pytest.mark.parametrize(
    "query,category,items",
    [
        ("cheapest dates", "dates", None),
        ("cheapest items", None, None),
        ("cheapest dates", "dates", [{"productText": "cheapest dates"}]),
    ],
)
def test_cheapest_search_maps_to_catalog_price_ranking(query, category, items):
    entities = {"productText": query, "sort_by": "price_asc"}
    if category:
        entities["category"] = category
    if items:
        entities["items"] = items
    plan = map_discovery_request(
        resolved(entities=entities), "pls i need " + query, ShoppingIntent
    )
    assert plan is not None
    assert plan.query == "*"
    assert plan.category == category
    assert plan.sort_by == "price_asc"
    assert not plan.cheaper


@pytest.mark.parametrize(
    "entities,message,query,attributes",
    [
        (
            {"productText": "lipton green tea", "category": "tea"},
            "recommend Lipton green tea",
            "lipton green tea",
            [],
        ),
        (
            {"productText": "red products", "color": "red"},
            "recommend red products",
            "*",
            [("color", "red")],
        ),
        (
            {
                "productText": "black running shoes",
                "category": "running_shoes",
                "color": "black",
            },
            "recommend black running shoes",
            "*",
            [("color", "black")],
        ),
        (
            {"productText": "*", "color": "burgundy"},
            "recommend products with color burgundy",
            "*",
            [("color", "burgundy")],
        ),
        (
            {"productText": "*", "category": "beverages"},
            "recommend products in category beverages",
            "*",
            [],
        ),
        (
            {"productText": "*", "flavor": "vanilla"},
            "recommend products with flavor vanilla",
            "*",
            [("flavor", "vanilla")],
        ),
    ],
)
def test_recommendations_by_name_category_and_attributes(
    entities, message, query, attributes
):
    plan = map_discovery_request(
        resolved(legacy_intent="PRODUCT_RECOMMEND", entities=entities),
        message,
        ShoppingIntent,
    )
    assert plan is not None
    assert plan.query == query
    assert [(a.name, a.value) for a in plan.attributes] == attributes
    assert plan.category == entities.get("category")
    assert plan.presentation == "recommend"


def test_open_ended_recommendation_uses_catalog_browse_without_invented_filters():
    plan = map_discovery_request(
        resolved(legacy_intent="PRODUCT_RECOMMEND", entities={"productText": "*"}),
        "pls recommend something",
        ShoppingIntent,
    )
    assert plan is not None
    assert plan.query == "*"
    assert plan.presentation == "recommend"
    assert plan.category is None
    assert plan.attributes == []
