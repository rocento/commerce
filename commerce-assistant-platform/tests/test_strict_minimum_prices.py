"""Strict limits survive real language mapping, runtime transport and product checks."""

import asyncio
import json
import subprocess
from pathlib import Path

import pytest
from interpretation_helpers import standard_route
from pydantic import ValidationError
from test_shopping import interpreted, product, scenario

from app.commerce_action_engine.actions.shopping import ShoppingIntent
from app.commerce_action_engine.actions.shopping.pricing import retain_price_bounds
from app.commerce_action_engine.application.interpretation import shopping_plan
from app.commerce_action_engine.execution.language import gate


@pytest.fixture(scope="module")
def engine_results():
    messages = [
        "find shoes above $100",
        "find shoes over $100.",
        "find shoes more than $100",
        "find shoes at least $100",
        "find shoes above $100 and under $101",
        "find shoes above $100 and at most $100",
        "find shoes above 100",
        "find shoes above £100",
        "find shoes above $0",
        "find copper fasteners for less than USD 31.75",
        "show me copper fasteners up to GBP 84",
        "I need copper fasteners costing more than EUR 250",
        "I need copper fasteners under EGP 4835",
    ]
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import {loadRuntime} from './src/runtime.ts'; import {resolve} from './src/engine.ts'; "
                "const c=await loadRuntime(); const messages=JSON.parse(process.argv[1]); "
                "console.log(JSON.stringify(messages.map(text=>resolve(c,text))));"
            ),
            json.dumps(messages),
        ],
        cwd=engine,
        capture_output=True,
        text=True,
        check=True,
    )
    return dict(zip(messages, json.loads(result.stdout), strict=True))


@pytest.mark.parametrize(
    "message,field,amount,currency,strict",
    [
        ("find copper fasteners for less than USD 31.75", "max", "31.75", "USD", True),
        ("show me copper fasteners up to GBP 84", "max", "84", "GBP", False),
        (
            "I need copper fasteners costing more than EUR 250",
            "min",
            "250",
            "EUR",
            True,
        ),
        ("I need copper fasteners under EGP 4835", "max", "4835", "EGP", True),
    ],
)
def test_product_price_boundaries_reach_catalog_plan(
    engine_results, message, field, amount, currency, strict
):
    resolution = gate.Resolution.model_validate(engine_results[message])
    assert resolution.entities["productText"] == "copper fasteners"
    assert standard_route(resolution) == "search"
    plan = shopping_plan(interpreted(resolution), message)
    assert getattr(plan, f"{field}_price") == amount
    assert getattr(plan, f"exclusive_{field}") is strict
    assert plan.currency == currency


@pytest.mark.parametrize(
    "message,inclusive",
    [
        ("find shoes above $100", False),
        ("find shoes over $100.", False),
        ("find shoes more than $100", False),
        ("find shoes at least $100", True),
    ],
)
def test_real_engine_to_catalog_boundary_without_model(
    engine_results, message, inclusive
):
    resolution = gate.Resolution.model_validate(engine_results[message])
    plan = shopping_plan(interpreted(resolution), message)
    assert plan.min_price == "100" and plan.exclusive_min is not inclusive
    interpretation = interpreted(resolution)
    answer, calls = asyncio.run(
        scenario(
            message,
            {"min_price": "0"},
            [
                product(1, price="99.99"),
                product(2, price="100.00"),
                product(3, price="100.01"),
                product(4, price="100.01", currency="EUR"),
            ],
            interpretation=interpretation,
        )
    )
    assert answer.model == "commerce-language-engine"
    assert answer.usage.input_tokens == 0
    prices = [p.price for block in answer.blocks for p in block.products or []]
    assert prices == (["100.00", "100.01"] if inclusive else ["100.01"])
    search = next(c["arguments"] for c in calls if c["name"] == "search_products")
    assert search["min_price"] == "100"
    assert search.get("exclusive_min", False) is not inclusive


def test_combined_limits_missing_currency_zero_and_empty_range(engine_results):
    def plan(text):
        return shopping_plan(
            interpreted(gate.Resolution.model_validate(engine_results[text])), text
        )

    bounded = plan("find shoes above $100 and under $101")
    assert (
        bounded.min_price,
        bounded.max_price,
        bounded.exclusive_min,
        bounded.exclusive_max,
    ) == ("100", "101", True, True)
    conflict = "find shoes above $100 and at most $100"
    assert engine_results[conflict]["status"] == "NEEDS_CONTEXT"
    assert "price" in engine_results[conflict]["missing"]
    assert plan(conflict) is None
    # Application shopping supplies an omitted currency from the authoritative
    # store schema, or clarifies there if unavailable (test_shopping.py).
    omitted = plan("find shoes above 100")
    assert omitted.currency is None and not omitted.clarification
    assert plan("find shoes above £100").currency == "GBP"
    zero = plan("find shoes above $0")
    assert zero.min_price == "0" and zero.exclusive_min


@pytest.mark.parametrize("phrase", ["above", "over", "more than"])
def test_omitted_model_lower_bound_is_independently_restored(phrase):
    answer, calls = asyncio.run(
        scenario(
            f"shoes {phrase} $100 and under $101",
            {},
            [
                product(1, price="100"),
                product(2, price="100.01"),
                product(3, price="101"),
            ],
        )
    )
    assert [p.price for b in answer.blocks for p in (b.products or [])] == ["100.01"]
    search = next(c["arguments"] for c in calls if c["name"] == "search_products")
    assert search["exclusive_min"] is True
    assert search["max_price"] == "101"


@pytest.mark.parametrize(
    "message", ["shoes above $100 and under $100", "shoes above $100 and below €200"]
)
def test_impossible_or_mixed_currency_ranges_ask_before_search(message):
    answer, calls = asyncio.run(scenario(message, {}, [product()]))
    assert "range" in answer.text or "currency" in answer.text
    assert not any(c["name"] == "search_products" for c in calls)


def test_stricter_bounds_survive_ties_and_more_precise_values():
    result = retain_price_bounds(
        {"min_price": "100", "exclusive_min": True}, "at least $100"
    )
    assert result["exclusive_min"]
    result = retain_price_bounds(
        {"min_price": "100", "exclusive_min": True}, "at least $100.01"
    )
    assert result["min_price"] == "100.01" and not result["exclusive_min"]
    assert retain_price_bounds({}, "more than 100.01 GBP")["currency"] == "GBP"
    assert retain_price_bounds({}, "no more than $100")["max_price"] == "100"
    with pytest.raises(ValueError):
        retain_price_bounds({}, "not above $100")


@pytest.mark.parametrize(
    "bounds",
    [
        {"min_price": "0", "max_price": "0", "exclusive_min": True},
        {"min_price": "100", "max_price": "100", "exclusive_min": True},
        {"min_price": "100", "max_price": "100", "exclusive_max": True},
        {"exclusive_min": True},
    ],
)
def test_empty_or_unanchored_strict_limits_are_invalid(bounds):
    with pytest.raises(ValidationError):
        ShoppingIntent(shopping=True, **bounds)


def test_equal_inclusive_limits_allow_exact_price():
    plan = ShoppingIntent(shopping=True, min_price="100", max_price="100")
    assert not plan.exclusive_min and not plan.exclusive_max


@pytest.mark.parametrize(
    "message,strict",
    [
        ("up to $6", False),
        ("at most $6", False),
        ("under $6", True),
        ("up to $6 and under $6", True),
        ("under $6 and up to $6", True),
        ("up to $10 and up to $6", False),
    ],
)
def test_literal_operator_corrects_extracted_tie_after_combining_constraints(
    message, strict
):
    result = retain_price_bounds(
        {"max_price": "6.00", "exclusive_max": True}, message, literal_ties=True
    )
    assert result["exclusive_max"] is strict
    assert result["max_price"] == "6.00"


def test_literal_tie_repair_preserves_stricter_amount_and_unspecified_history():
    original = {"max_price": "5", "exclusive_max": True}
    assert (
        retain_price_bounds(original, "up to $6", literal_ties=True)["max_price"] == "5"
    )
    assert retain_price_bounds(original, "coffee", literal_ties=True) == original
    result = retain_price_bounds(
        {"min_price": "100", "exclusive_min": True},
        "at least $50 and at least $100",
        literal_ties=True,
    )
    assert result["min_price"] == "100" and not result["exclusive_min"]
