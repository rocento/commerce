"""Broad value requests use disclosed, verified price-first discovery."""

import asyncio
import subprocess
from pathlib import Path

import pytest
from interpretation_helpers import standard_route
from test_discovery import evidence
from test_shopping import interpreted, product, scenario

from app.commerce_action_engine.application.interpretation import shopping_plan
from app.commerce_action_engine.execution.language import gate as language_gate


@pytest.mark.parametrize("meaning", [False, True])
@pytest.mark.parametrize(
    "message",
    [
        "show me the best value for money products",
        "Recommend the best value products",
        "please recommend best-value products",
        "suggest the best value items",
    ],
)
def test_best_value_request_returns_grounded_price_first_suggestions(message, meaning):
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            "import {loadRuntime} from './src/runtime.ts';import {resolve} from './src/engine.ts';console.log(JSON.stringify(resolve(await loadRuntime(),process.argv[1])));",
            message,
        ],
        cwd=engine,
        capture_output=True,
        text=True,
        check=True,
    )
    resolution = language_gate.Resolution.model_validate_json(result.stdout)
    assert standard_route(resolution) == "search"
    plan = shopping_plan(interpreted(resolution), message)
    assert plan and (not plan.clarification) and (plan.query == "*")
    assert plan.sort_by == "price_asc" and plan.in_stock
    interpretation = interpreted(resolution)
    answer, requests = asyncio.run(
        scenario(
            message,
            {"query": "WRONG"},
            [
                product(1, name="Expensive", price="20"),
                product(2, name="Affordable", price="2"),
                product(3, name="Unavailable", price="1", in_stock=False),
            ],
            commerce_meaning=meaning,
            interpretation=interpretation,
        )
    )
    assert "lower purchase prices" in answer.text
    assert "not price per unit or product quality" in answer.text
    assert answer.text.index("Affordable") < answer.text.index("Expensive")
    assert "Unavailable" not in answer.text
    assert requests[-1]["name"] == "search_products"
    assert requests[-1]["arguments"]["query"] == "*"
    assert answer.usage.input_tokens == 0


def test_quoted_product_names_and_explicit_constraints_are_not_swallowed():
    resolution = language_gate.Resolution(
        status="RESOLVED",
        intent="PRODUCT_RECOMMEND",
        message="ok",
        confidence=1,
        entities={"productText": "coffee"},
    )
    for message in [
        "recommend best value coffee under $20",
        "recommend best value products without nuts",
        "recommend best value products per kilogram",
        "recommend best value products and add tea to cart",
        "do not recommend best value products",
    ]:
        plan = shopping_plan(interpreted(resolution), message)
        assert (
            plan is None
            or not plan.clarification
            or "Which type of product" not in plan.clarification
        )


@pytest.mark.parametrize("products", [[], [product(1, in_stock=False)]])
def test_value_browse_does_not_invent_available_products(products):
    message = "Recommend the best value products"
    resolution = language_gate.Resolution(
        status="RESOLVED",
        intent="PRODUCT_RECOMMEND",
        message="ok",
        confidence=1,
        entities={"productText": "best value products"},
    )
    interpretation = interpreted(resolution)
    answer, _ = asyncio.run(
        scenario(message, {}, products, interpretation=interpretation)
    )
    assert "lower purchase prices" not in answer.text
    assert not any(block.products for block in answer.blocks)


@pytest.mark.parametrize("count", [6, 8])
def test_value_recommendations_accept_the_full_ranked_catalog_response(count):
    message = "Recommend the best value products"
    resolution = language_gate.Resolution(
        status="RESOLVED",
        intent="PRODUCT_RECOMMEND",
        message="ok",
        confidence=1,
        entities={"productText": "best value products"},
    )
    products = [
        product(n, name=f"Product {n}", price=str(20 - n)) for n in range(1, count + 1)
    ]
    for rank, item in enumerate(products, 1):
        item["discovery"] = evidence(item, rank=rank)
    answer, requests = asyncio.run(
        scenario(message, {}, products, interpretation=interpreted(resolution))
    )
    assert "lower purchase prices" in answer.text
    assert "not price per unit or product quality" in answer.text
    cards = [card for block in answer.blocks for card in block.products or []]
    assert [str(card.id) for card in cards] == [
        item["id"] for item in reversed(products)
    ]
    assert requests[-1]["arguments"]["query"] == "*"
    assert answer.usage.input_tokens == 0
