"""Real language resolution, schema-guided retrieval, and independent tag checks."""

import asyncio
import json

import httpx
import pytest
from test_catalog_schema import catalog_schema, schema_attribute
from test_language_understanding import real_resolve
from test_shopping import TENANT, WHO, interpreted, product

from app.commerce_action_engine.actions.catalog import CatalogSchema
from app.commerce_action_engine.actions.shopping import ShoppingIntent
from app.commerce_action_engine.actions.shopping.recommendations import purpose_filter
from app.commerce_action_engine.application.catalog import registry
from app.commerce_action_engine.application.shopping import shopping_answer
from app.commerce_action_engine.execution.agents import default_agents


def schema():
    return catalog_schema(
        "grocery",
        [
            schema_attribute(
                "meal_occasion",
                "multiselect",
                ["breakfast", "dinner"],
                "semantic",
                semantic_role="intended_use",
            )
        ],
    )


@pytest.mark.parametrize(
    "query",
    [
        "dinner",
        "for dinner",
        "something for dinner",
        "somehing for dinner",
        "food for dinner",
        "ingredients for dinner",
    ],
)
def test_resolve_only_current_catalog_uses(query):
    result = purpose_filter(
        ShoppingIntent(shopping=True, query=query), CatalogSchema(**schema())
    )
    assert result.name == "meal_occasion" and result.value == "dinner"


@pytest.mark.parametrize(
    "query",
    [
        "dinner without nuts",
        "chicken for dinner",
        "something for birthday",
        "dinner and checkout",
        "not dinner",
        "dinner for diabetics",
    ],
)
def test_unknown_modifiers_and_product_names_are_not_erased(query):
    assert (
        purpose_filter(
            ShoppingIntent(shopping=True, query=query), CatalogSchema(**schema())
        )
        is None
    )


def test_ambiguous_hidden_or_unfilterable_schema_does_not_rewrite():
    data = schema()
    data["attributes"].append(
        schema_attribute("other_use", options=["dinner"], semantic_role="intended_use")
    )
    assert (
        purpose_filter(
            ShoppingIntent(shopping=True, query="dinner"), CatalogSchema(**data)
        )
        is None
    )
    data["attributes"] = data["attributes"][:1]
    data["attributes"][0]["filterable"] = False
    assert (
        purpose_filter(
            ShoppingIntent(shopping=True, query="dinner"), CatalogSchema(**data)
        )
        is None
    )


@pytest.mark.parametrize("meaning", [False, True])
@pytest.mark.parametrize(
    "message",
    [
        "pls recommend somehing for dinner",
        "please recommend something for dinner under $5",
    ],
)
def test_real_language_to_recommendation_keeps_budget_and_rejects_noisy_candidates(
    message, meaning
):

    async def run():
        resolution = await real_resolve("unused", message)
        assert resolution.intent == "PRODUCT_RECOMMEND"
        interpretation = interpreted(resolution)
        calls = []

        def handler(request):
            body = json.loads(request.content)
            if body["name"] == "get_catalog_schema":
                return httpx.Response(
                    200,
                    json={
                        "products": [],
                        "category": None,
                        "catalog_schema": schema(),
                        "default_currency": "USD",
                    },
                )
            calls.append(body)
            return httpx.Response(
                200,
                json={
                    "products": [
                        product(
                            1,
                            name="Rice",
                            price="3",
                            attributes=[
                                {
                                    "name": "meal_occasion",
                                    "value": '["dinner"]',
                                    "source": "MERCHANT",
                                }
                            ],
                        ),
                        product(
                            2,
                            name="Breakfast cereal",
                            price="2",
                            attributes=[
                                {
                                    "name": "meal_occasion",
                                    "value": '["breakfast"]',
                                    "source": "MERCHANT",
                                }
                            ],
                        ),
                        product(3, name="Unverified item", price="2", attributes=[]),
                        product(
                            4,
                            name="Expensive dinner",
                            price="90",
                            attributes=[
                                {
                                    "name": "meal_occasion",
                                    "value": '["dinner"]',
                                    "source": "MERCHANT",
                                }
                            ],
                        ),
                    ],
                    "category": None,
                },
            )

        class NoModel:
            async def generate(self, request):
                raise AssertionError("A resolved recommendation must not call a model")

        async with httpx.AsyncClient(
            base_url="http://catalog", transport=httpx.MockTransport(handler)
        ) as client:
            answer = await shopping_answer(
                message,
                NoModel(),
                default_agents(TENANT).load(TENANT, "shopper"),
                WHO,
                {
                    t.definition.name: t
                    for t in registry(client, "catalog-token", WHO, {})
                },
                grounded_intent=True,
                commerce_meaning=meaning,
                interpretation=interpretation,
            )
        assert calls[0]["arguments"]["query"] == "*"
        assert calls[0]["arguments"]["attributes"]["meal_occasion"] == "dinner"
        text = answer.text
        assert "Rice" in text
        assert "Breakfast cereal" not in text and "Unverified item" not in text
        if "$5" in message:
            assert float(calls[0]["arguments"]["max_price"]) == 5
            assert "Expensive dinner" not in text

    asyncio.run(run())


def test_five_attribute_rich_products_fit_the_default_shopper_result_budget():
    from test_shopping import scenario

    from app.commerce_action_engine.actions.catalog import CatalogResult

    products = [
        product(
            i,
            name=f"Jewelry design {i}",
            attributes=[
                {
                    "name": f"catalog_field_{j}",
                    "value": json.dumps("merchant styling detail " * 3),
                    "source": "MERCHANT",
                }
                for j in range(10)
            ],
        )
        for i in range(5)
    ]
    size = len(
        CatalogResult.model_validate(
            {"products": products, "category": None}
        ).model_dump_json()
    )
    assert 8000 < size < 16000
    answer, _ = asyncio.run(
        scenario("recommend jewelry", {"query": "jewelry"}, products)
    )
    assert all(p["name"] in answer.text for p in products)
