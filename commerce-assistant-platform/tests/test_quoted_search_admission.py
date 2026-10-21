"""Literal product names stay data through the real language/catalog boundary."""

import asyncio
import json
import subprocess
from pathlib import Path

import pytest
from interpretation_helpers import standard_route
from test_shopping import interpreted, product, scenario

from app.commerce_action_engine.application.interpretation import shopping_plan
from app.commerce_action_engine.execution.language.gate import (
    Resolution,
)


@pytest.mark.parametrize(
    "title", ["café", "crème brûlée", "tea 🍵", "tea — édition", "茶 leaf"]
)
def test_unicode_literal_titles_survive_real_node_to_python_search_plan(title):
    message = f'find "{title}"'
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    output = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import {loadRuntime} from './src/runtime.ts';"
                "import {resolve} from './src/engine.ts';"
                "console.log(JSON.stringify(resolve(await loadRuntime(),process.argv[1])));"
            ),
            message,
        ],
        cwd=engine,
        capture_output=True,
        text=True,
        check=True,
    )
    resolution = Resolution.model_validate_json(output.stdout)
    assert resolution.entities["productText"] == title
    plan = shopping_plan(interpreted(resolution), message)
    assert plan is not None and plan.query == title
    assert plan.min_price is None and plan.max_price is None
    assert plan.clarification is None


def test_literal_titles_produce_search_plans_without_actions_or_price_filters():
    products = [
        "cancel order 114238",
        "add 3 shoes to cart",
        "under $20",
        "without sugar",
        "5 shoes",
    ]
    messages = [f'search for "{product}"' for product in products]
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    output = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import {loadRuntime} from './src/runtime.ts';import {resolve} from './src/engine.ts';"
                "const c=await loadRuntime();console.log(JSON.stringify(JSON.parse(process.argv[1]).map(t=>resolve(c,t))));"
            ),
            json.dumps(messages),
        ],
        cwd=engine,
        capture_output=True,
        text=True,
        check=True,
    )
    for title, message, raw in zip(
        products, messages, json.loads(output.stdout), strict=True
    ):
        resolution = Resolution.model_validate(raw)
        assert standard_route(resolution) == "search"
        assert resolution.intent == "PRODUCT_SEARCH"
        plan = shopping_plan(interpreted(resolution), message)
        assert plan is not None and plan.query == title
        assert plan.min_price is None and plan.max_price is None
        assert plan.clarification is None


def test_mismatched_literal_entity_cannot_bypass_requirement_guard():
    resolution = Resolution(
        status="RESOLVED",
        message="Understood",
        intent="PRODUCT_SEARCH",
        confidence=1,
        entities={"productText": "sugar"},
    )
    assert shopping_plan(interpreted(resolution), 'find "without sugar"') is None


def test_literal_price_title_does_not_become_runtime_budget():
    resolution = Resolution(
        status="RESOLVED",
        message="Understood",
        intent="PRODUCT_SEARCH",
        confidence=1,
        entities={"productText": "under $20"},
    )
    interpretation = interpreted(resolution)
    answer, calls = asyncio.run(
        scenario(
            'find "under $20"', {}, [product(price="50")], interpretation=interpretation
        )
    )
    assert answer.model == "commerce-language-engine"
    assert answer.usage.input_tokens == 0
    search = next(c["arguments"] for c in calls if c["name"] == "search_products")
    assert search["query"] == "under $20"
    assert search.get("max_price") is None
