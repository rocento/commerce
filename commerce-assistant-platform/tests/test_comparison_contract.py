"""Independent price boundaries survive language extraction and catalog proof."""

import asyncio
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest
from test_shopping import interpreted, product, scenario

from app.commerce_action_engine.actions.catalog import Product
from app.commerce_action_engine.actions.shopping.constraints import mismatches
from app.commerce_action_engine.actions.shopping.contracts import ShoppingIntent
from app.commerce_action_engine.actions.shopping.pricing import (
    iter_price_bounds,
    retain_price_bounds,
)
from app.commerce_action_engine.application.interpretation import shopping_plan
from app.commerce_action_engine.execution.language.gate import Resolution
from app.commerce_action_engine.execution.language.proposal_constraints import (
    preserves_literals,
)
from app.commerce_contracts.comparisons import (
    COMPARISON_SYMBOLS,
    comparison_operator,
    comparison_pattern,
    intersect_bound,
)

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures/comparison-boundaries.json").read_text()
)
UNPROVEN_COMPARISONS = [
    "find phones under 1,23 USD",
    "find phones under 128GB",
    "find phones under 3 grams",
    "find phones quantity under 3.5",
]


@pytest.fixture(scope="module")
def language_results():
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    messages = [f"find phones {row['phrase']} $100" for row in FIXTURE["cases"]]
    messages.append("find Under Armour shoes at most $100")
    messages.extend(UNPROVEN_COMPARISONS)
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import {loadRuntime} from './src/runtime.ts'; "
                "import {resolve} from './src/engine.ts'; "
                "const engine=await loadRuntime(); "
                "console.log(JSON.stringify(JSON.parse(process.argv[1]).map(text=>resolve(engine,text))));"
            ),
            json.dumps(messages),
        ],
        cwd=engine,
        capture_output=True,
        text=True,
        check=True,
    )
    return dict(zip(messages, json.loads(result.stdout), strict=True))


@pytest.mark.parametrize("row", FIXTURE["cases"], ids=lambda row: row["phrase"])
def test_real_language_operator_and_final_sku_boundary(row, language_results):
    text = f"find phones {row['phrase']} $100"
    raw = language_results[text]
    assert raw["status"] == "RESOLVED"
    assert raw["entities"]["price"]["operator"] == row["symbol"]
    assert comparison_operator(row["phrase"]) == row["operator"]
    plan = shopping_plan(interpreted(Resolution.model_validate(raw)), text)
    assert plan.currency == "USD" and not plan.clarification
    accepted = [
        price
        for price in FIXTURE["prices"]
        if not mismatches(
            Product.model_validate(
                product(name="Phone", category="Phones", price=price)
            ),
            plan,
            None,
        )
    ]
    assert accepted == row["accepted"]


def test_generated_typescript_contract_is_current():
    root = Path(__file__).resolve().parents[2]
    subprocess.run(
        [
            sys.executable,
            str(root / "commerce-ops/scripts/contracts/generate_comparison_operators.py"),
            "--check",
        ],
        cwd=root,
        check=True,
    )


@pytest.mark.parametrize("direction", ["min", "max"])
def test_equal_decimal_bounds_keep_strictness_in_both_orders(direction):
    assert intersect_bound("100.00", False, "100", True, direction) == ("100.00", True)
    assert intersect_bound("100.00", True, "100", False, direction) == ("100.00", True)


def test_attribute_symbols_and_price_scope_remain_separate():
    pattern = comparison_pattern("attribute", include_symbols=True)
    for phrase in ("minimum", "maximum", ">=", "<=", ">", "<", "="):
        assert re.fullmatch(pattern, phrase)
        assert comparison_operator(phrase) in COMPARISON_SYMBOLS
    assert not re.fullmatch(comparison_pattern(), "minimum")
    assert retain_price_bounds({}, "minimum order 100") == {}


def test_longest_phrases_quotes_and_proven_measurement_spans():
    assert retain_price_bounds({}, "no more than $100")["exclusive_max"] is False
    assert retain_price_bounds({}, "no less than $100")["exclusive_min"] is False
    assert retain_price_bounds({}, 'find "Under $100"') == {}
    text = "Storage GB at least 128 GB under $500"
    assert retain_price_bounds({}, text, ignore_spans=((0, 25),)) == {
        "max_price": "500",
        "exclusive_max": True,
        "currency": "USD",
    }
    assert iter_price_bounds("under armour shoes") == ()
    with pytest.raises(ValueError, match="negated"):
        iter_price_bounds("not under $100")


def test_range_currency_and_decimal_boundary_are_preserved():
    bounds = iter_price_bounds("between 99.99 and 100.01 USD")
    assert [(b.operator, b.amount, b.currency) for b in bounds] == [
        ("gte", "99.99", "USD"),
        ("lte", "100.01", "USD"),
    ]
    plan = ShoppingIntent(
        shopping=True, **retain_price_bounds({}, "between 99.99 and 100.01 USD")
    )
    assert not mismatches(Product.model_validate(product(price="100")), plan, None)
    with pytest.raises(ValueError, match="currency"):
        retain_price_bounds({}, "between USD 99 and EUR 100")


def test_rewrites_cannot_change_boundary_strictness_or_drop_opposite_bounds():
    assert preserves_literals("phones below $100", "phones less than $100")
    assert preserves_literals("phones no more than $100", "phones at most $100")
    assert not preserves_literals("phones under $100", "phones up to $100")
    assert not preserves_literals("phones above $100", "phones at least $100")
    assert not preserves_literals(
        "phones above $50 and under $100", "phones under $100"
    )


def test_product_name_does_not_make_an_inclusive_price_strict(language_results):
    text = "find Under Armour shoes at most $100"
    plan = shopping_plan(
        interpreted(Resolution.model_validate(language_results[text])), text
    )
    assert plan.max_price == "100" and not plan.exclusive_max


@pytest.mark.parametrize("number", ["1,23", "12xyz", "10,0000", "1e3", "128GB"])
def test_incomplete_numeric_tokens_cannot_be_retained_as_money(number):
    with pytest.raises(ValueError, match="complete numeric"):
        retain_price_bounds({}, f"phones under {number} USD")


@pytest.mark.parametrize("unit", ["grams", "GB", "pieces", "volts"])
def test_unbound_measurements_require_a_field_instead_of_becoming_money(unit):
    with pytest.raises(ValueError, match="catalog unit"):
        retain_price_bounds({}, f"phones under 3 {unit}")


def test_unproven_attribute_range_cannot_become_a_price_range():
    with pytest.raises(ValueError, match="catalog unit"):
        retain_price_bounds({}, "Storage GB between 128 and 256 GB under $500")


@pytest.mark.parametrize("text", UNPROVEN_COMPARISONS)
def test_unproven_numbers_clarify_before_catalog_retrieval(text, language_results):
    answer, calls = asyncio.run(
        scenario(
            text,
            {"query": "phones", "max_price": "1"},
            [product(name="Phone", category="Phones", price="0.50")],
            interpretation=interpreted(
                Resolution.model_validate(language_results[text])
            ),
        )
    )
    assert answer is not None and not answer.blocks
    assert "clarify" in answer.text.lower() or "please" in answer.text.lower()
    assert not any(call["name"] == "search_products" for call in calls)
