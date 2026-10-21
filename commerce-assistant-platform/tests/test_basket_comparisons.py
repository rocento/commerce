"""Literal basket and item limits through the real proposal workflow."""

import asyncio
from uuid import UUID

import pytest
from test_baskets import Provider
from test_catalog_schema import catalog_schema, schema_attribute
from test_shopping import product

from app.commerce_action_engine.actions.catalog import (
    CatalogResult,
    CatalogSchema,
    SchemaArgs,
    SearchToolArgs,
)
from app.commerce_action_engine.actions.shopping.basket_workflow import plan_basket
from app.commerce_action_engine.actions.shopping.baskets import (
    BasketGoal,
    BasketPlan,
    SearchLine,
)
from app.commerce_action_engine.actions.shopping.contracts import ShoppingIntent
from app.commerce_action_engine.execution.agents import Principal
from app.commerce_resolution_engine.contracts import ToolDefinition
from app.commerce_resolution_engine.runtime import RuntimeTool


async def proposal(
    message,
    plan,
    *,
    meaning=False,
    planning=False,
    previous=None,
    products=None,
    schema=None,
):
    task, requests = UUID(int=30), []
    provider = Provider(plan)

    class Gateway:
        def __init__(self):
            self.draft = None
            self.calls = []

        async def context(self, requested):
            assert requested == task
            self.calls.append("context")
            return {
                "cart": {"items": [], "currency": "USD"},
                "draft": previous,
                "cancelled": False,
                "task_revision": 1,
                "source_revision": 2,
            }

        async def quote(self, requested, draft):
            assert requested == task
            self.calls.append("quote")
            self.draft = draft
            return {
                "id": str(UUID(int=31)),
                "can_apply": not draft["goal"]["unresolved"],
            }

    async def read_schema(arguments, principal):
        return CatalogResult(
            products=[],
            category=None,
            catalog_schema=CatalogSchema.model_validate(
                schema or catalog_schema(attributes=[])
            ),
        )

    async def search(arguments, principal):
        requests.append(arguments.model_dump())
        matches = (
            products.get(arguments.query, [])
            if isinstance(products, dict)
            else products
        )
        return CatalogResult(products=matches or [], category=None)

    tools = {
        "get_catalog_schema": RuntimeTool(
            ToolDefinition("get_catalog_schema", "Read schema", SchemaArgs),
            CatalogResult,
            read_schema,
            frozenset({"shopper"}),
        ),
        "search_products": RuntimeTool(
            ToolDefinition("search_products", "Search products", SearchToolArgs),
            CatalogResult,
            search,
            frozenset({"shopper"}),
        ),
    }
    gateway = Gateway()
    answer = await plan_basket(
        message,
        "shop",
        task,
        provider,
        tools,
        Principal(tenant=UUID(int=1), persona="shopper"),
        gateway,
        commerce_meaning=meaning,
        commerce_planning=planning,
        planning_prices=(400, 1600),
    )
    assert "UNTRUSTED PROVIDER PROSE" not in answer[0]
    assert set(gateway.calls) <= {"context", "quote"}
    return answer, gateway.draft, requests, provider


@pytest.mark.parametrize("meaning,planning", [(False, False), (True, True)])
@pytest.mark.parametrize(
    "phrase,exclusive",
    [
        ("under", True),
        ("below", True),
        ("less than", True),
        ("up to", False),
        ("at most", False),
        ("no more than", False),
    ],
)
def test_budget_operator_comes_from_its_own_literal_span(
    phrase, exclusive, meaning, planning
):
    _, draft, _, provider = asyncio.run(
        proposal(
            f"Build an Under Armour basket {phrase} USD 100",
            BasketPlan(goal=BasketGoal(budget="999", currency="EGP")),
            meaning=meaning,
            planning=planning,
        )
    )
    assert draft["goal"]["budget"] == "100"
    assert draft["goal"]["budget_exclusive"] is exclusive
    assert draft["goal"]["currency"] == "USD"
    assert not draft["goal"]["unresolved"]
    assert len(provider.requests) == 1


@pytest.mark.parametrize(
    "message,amount,exclusive",
    [
        ("Basket under USD 100 and up to USD 150", "100", True),
        ("Basket up to USD 150 and under USD 100", "100", True),
        ("Basket at most USD 100 and under USD 100", "100", True),
        ("Basket under USD 100 and at most USD 100", "100", True),
        ("Basket under USD 1,500.50 and up to USD 2,000", "1500.50", True),
        ("Basket up to USD 2,000 and at most USD 1,500.50", "1500.50", False),
    ],
)
def test_conjoined_budget_limits_intersect_instead_of_last_limit_winning(
    message, amount, exclusive
):
    _, draft, _, _ = asyncio.run(proposal(message, BasketPlan(goal=BasketGoal())))
    assert draft["goal"]["budget"] == amount
    assert draft["goal"]["budget_exclusive"] is exclusive
    assert not draft["goal"]["unresolved"]


@pytest.mark.parametrize("meaning,planning", [(False, False), (True, True)])
@pytest.mark.parametrize(
    "phrase,direction,exclusive",
    [
        ("under", "max", True),
        ("less than", "max", True),
        ("at most", "max", False),
        ("no more than", "max", False),
        ("above", "min", True),
        ("more than", "min", True),
        ("at least", "min", False),
        ("no less than", "min", False),
    ],
)
def test_item_price_boundary_is_independent_of_basket_budget(
    phrase, direction, exclusive, meaning, planning
):
    intent = ShoppingIntent(shopping=True, query="shoes")
    setattr(intent, direction + "_price", "100")
    # The extractor deliberately supplies the opposite tie flag.
    setattr(intent, "exclusive_" + direction, not exclusive)
    _, draft, requests, _ = asyncio.run(
        proposal(
            f"Add shoes {phrase} USD 100 each; basket at most USD 300",
            BasketPlan(
                goal=BasketGoal(budget="100"),
                searches=[SearchLine(intent=intent, quantity=1)],
            ),
            products=[product(price="100")],
            meaning=meaning,
            planning=planning,
        )
    )
    assert draft["goal"]["budget"] == "300"
    assert draft["goal"]["budget_exclusive"] is False
    assert requests[0][direction + "_price"] == "100"
    assert requests[0].get("exclusive_" + direction, False) is exclusive
    assert requests[0]["currency"] == "USD"
    assert bool(draft["selections"]) is not exclusive
    if draft["selections"]:
        assert draft["selections"][0]["exclusive_" + direction] is False


@pytest.mark.parametrize("meaning", [False, True])
def test_whole_basket_budget_is_not_copied_into_item_price_filters(meaning):
    _, draft, requests, _ = asyncio.run(
        proposal(
            "Build a shoes basket under USD 150",
            BasketPlan(
                goal=BasketGoal(),
                searches=[
                    SearchLine(
                        intent=ShoppingIntent(
                            shopping=True, query="shoes", max_price="150"
                        ),
                        quantity=1,
                    )
                ],
            ),
            products=[product(price="99")],
            meaning=meaning,
        )
    )
    assert draft["goal"]["budget"] == "150"
    assert requests[0]["max_price"] is None
    assert draft["selections"][0]["max_price"] is None


@pytest.mark.parametrize("meaning", [False, True])
def test_two_product_limits_are_scoped_separately_before_meaning_conflict_check(
    meaning,
):
    _, draft, requests, _ = asyncio.run(
        proposal(
            "Add shoes under USD 50 and socks above USD 80; basket up to USD 200",
            BasketPlan(
                goal=BasketGoal(budget="80"),
                searches=[
                    SearchLine(
                        intent=ShoppingIntent(shopping=True, query="shoes"), quantity=1
                    ),
                    SearchLine(
                        intent=ShoppingIntent(shopping=True, query="socks"), quantity=1
                    ),
                ],
            ),
            products={
                "shoes": [product(price="49")],
                "socks": [
                    product(number=2, price="81", name="Socks", category="Socks")
                ],
            },
            meaning=meaning,
        )
    )
    assert draft["goal"]["budget"] == "200"
    assert requests[0]["max_price"] == "50"
    assert requests[0]["min_price"] is None
    assert requests[1]["min_price"] == "80"
    assert requests[1]["max_price"] is None
    assert len(draft["selections"]) == 2
    assert not draft["goal"]["unresolved"]


@pytest.mark.parametrize(
    "message",
    ["Add shoes under USD 50 each", "Add shoes under USD 50"],
)
def test_item_limit_cannot_become_a_whole_basket_budget(message):
    _, draft, requests, _ = asyncio.run(
        proposal(
            message,
            BasketPlan(
                goal=BasketGoal(budget="50"),
                searches=[
                    SearchLine(
                        intent=ShoppingIntent(shopping=True, query="shoes"), quantity=2
                    )
                ],
            ),
            products=[product(price="49")],
        )
    )
    assert draft["goal"]["budget"] is None
    assert requests[0]["max_price"] == "50"
    assert draft["selections"][0]["quantity"] == 2


def test_unbound_limit_requires_scope_clarification_instead_of_false_total_budget():
    _, draft, _, _ = asyncio.run(
        proposal(
            "Add something under USD 100", BasketPlan(goal=BasketGoal(budget="100"))
        )
    )
    assert draft["goal"]["budget"] is None
    assert "each item or to the whole basket" in draft["goal"]["unresolved"][0]


@pytest.mark.parametrize(
    "message,amount,currency",
    [
        ("Budget USD 100", "100", "USD"),
        ("Budget 100", "100", "USD"),
        ("I can spend 100 EGP", "100", "EGP"),
        ("Spending limit of £100", "100", "GBP"),
    ],
)
def test_adjacent_stated_budget_has_typed_monetary_evidence(message, amount, currency):
    _, draft, _, _ = asyncio.run(
        proposal(message, BasketPlan(goal=BasketGoal(budget="999")))
    )
    assert draft["goal"]["budget"] == amount
    assert draft["goal"]["currency"] == currency
    assert draft["goal"]["budget_exclusive"] is False


@pytest.mark.parametrize(
    "message",
    ["Budget 128GB", "Budget 100 XYZ", "Budget ABC 100", "Budget 3 pieces"],
)
def test_units_or_unknown_currency_do_not_become_a_budget(message):
    answer, draft, _, provider = asyncio.run(
        proposal(message, BasketPlan(goal=BasketGoal(budget="100")))
    )
    assert draft is None
    assert "basket budget" in answer[0]
    assert not provider.requests


@pytest.mark.parametrize(
    "message",
    [
        "Budget is flexible, add 3 apples",
        'Add "Budget 3" apples',
        "Use quantity at most 3 pieces",
    ],
)
def test_unrelated_numbers_and_quoted_budget_labels_do_not_prove_a_budget(message):
    _, draft, _, _ = asyncio.run(
        proposal(message, BasketPlan(goal=BasketGoal(budget="3")))
    )
    assert draft["goal"]["budget"] is None
    assert not draft["goal"]["unresolved"]


@pytest.mark.parametrize(
    "message",
    [
        "Basket above USD 100",
        "Basket exactly USD 100",
        "Basket between USD 100 and USD 150",
    ],
)
def test_unrepresentable_total_comparison_requires_an_upper_budget(message):
    _, draft, _, _ = asyncio.run(
        proposal(message, BasketPlan(goal=BasketGoal(budget="150")))
    )
    assert draft["goal"]["budget"] is None
    assert "upper spending limit" in draft["goal"]["unresolved"][0]


def test_explicit_followup_budget_replaces_prior_limit_and_retains_fee_scope():
    previous = {
        "goal": BasketGoal(
            budget="100", currency="USD", budget_exclusive=True, all_inclusive=True
        ).model_dump()
    }
    _, draft, _, _ = asyncio.run(
        proposal(
            "Make it at most USD 200", BasketPlan(goal=BasketGoal()), previous=previous
        )
    )
    assert draft["goal"]["budget"] == "200"
    assert draft["goal"]["budget_exclusive"] is False
    assert draft["goal"]["all_inclusive"] is True


def test_item_followup_keeps_prior_total_budget_and_quantities():
    previous = {
        "goal": BasketGoal(
            budget="100", currency="USD", budget_exclusive=True, all_inclusive=True
        ).model_dump()
    }
    _, draft, _, _ = asyncio.run(
        proposal(
            "Add shoes at most USD 30 each",
            BasketPlan(
                goal=BasketGoal(budget="30"),
                searches=[
                    SearchLine(
                        intent=ShoppingIntent(shopping=True, query="shoes"), quantity=2
                    )
                ],
            ),
            previous=previous,
            products=[product(price="30")],
        )
    )
    assert draft["goal"]["budget"] == "100"
    assert draft["goal"]["budget_exclusive"] is True
    assert draft["goal"]["all_inclusive"] is True
    assert draft["selections"][0]["quantity"] == 2


def test_numeric_attribute_is_not_a_budget_or_item_price_limit():
    _, draft, requests, _ = asyncio.run(
        proposal(
            "Add phones with storage at least 128 GB; basket at most USD 500",
            BasketPlan(
                goal=BasketGoal(budget="128"),
                searches=[
                    SearchLine(
                        intent=ShoppingIntent(shopping=True, query="phones"), quantity=1
                    )
                ],
            ),
            products=[
                product(
                    price="400",
                    name="Phone",
                    attributes=[{"name": "storage", "value": "256"}],
                )
            ],
            schema=catalog_schema(
                "electronics", [schema_attribute("storage", "measurement", unit="GB")]
            ),
        )
    )
    assert draft["goal"]["budget"] == "500"
    assert requests[0]["min_price"] is None


def test_labelled_budget_does_not_parse_later_attribute_units_as_money():
    _, draft, _, _ = asyncio.run(
        proposal(
            "Budget USD 500 and storage at least 128 GB",
            BasketPlan(goal=BasketGoal()),
            schema=catalog_schema(
                "electronics", [schema_attribute("storage", "measurement", unit="GB")]
            ),
        )
    )
    assert draft["goal"]["budget"] == "500"
    assert not draft["goal"]["unresolved"]


def test_measurement_in_model_query_is_not_validated_as_a_monetary_limit():
    _, draft, requests, provider = asyncio.run(
        proposal(
            "Build a phone basket under USD 500 with storage at least 128 GB",
            BasketPlan(
                goal=BasketGoal(),
                searches=[
                    SearchLine(
                        intent=ShoppingIntent(
                            shopping=True, query="storage at least 128 GB"
                        ),
                        quantity=1,
                    )
                ],
            ),
            schema=catalog_schema(
                "electronics", [schema_attribute("storage", "measurement", unit="GB")]
            ),
            products=[
                product(price="400", attributes=[{"name": "storage", "value": "256"}])
            ],
        )
    )
    assert draft["goal"]["budget"] == "500"
    assert requests[0]["min_price"] is None
    assert len(provider.requests) == 1


def test_malformed_model_query_returns_clarification_instead_of_api_error():
    answer, draft, _, provider = asyncio.run(
        proposal(
            "Build a shoes basket under USD 500",
            BasketPlan(
                goal=BasketGoal(),
                searches=[
                    SearchLine(
                        intent=ShoppingIntent(shopping=True, query="shoes under 128GB"),
                        quantity=1,
                    )
                ],
            ),
        )
    )
    assert draft is None
    assert answer[0].startswith("Please ")
    assert not answer[1]
    assert len(provider.requests) == 1
