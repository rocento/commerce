"""Explicit English currency names survive the real Node-to-catalog boundary."""

import asyncio
import json
import subprocess
from pathlib import Path

import pytest
from interpretation_helpers import standard_route
from test_shopping import interpreted, product, scenario

from app.commerce_action_engine.actions.shopping.pricing import retain_price_bounds
from app.commerce_action_engine.application.interpretation import shopping_plan
from app.commerce_action_engine.execution.language import gate

NAMES = [
    ("US dollar", "USD"),
    ("euro", "EUR"),
    ("British pound", "GBP"),
    ("Egyptian pound", "EGP"),
    ("Kuwaiti dinar", "KWD"),
    ("Japanese yen", "JPY"),
    ("Saudi riyal", "SAR"),
    ("UAE dirham", "AED"),
    ("Australian dollar", "AUD"),
    ("Canadian dollar", "CAD"),
    ("Bahraini dinar", "BHD"),
    ("Omani rial", "OMR"),
    ("Swiss franc", "CHF"),
]
CASES = [
    ("find shoes below 50 euros", "EUR", None, "50", False, True),
    ("find shoes at most 50 British pounds", "GBP", None, "50", False, False),
    ("find shoes above Canadian dollars 31.75", "CAD", "31.75", None, True, False),
    ("find shoes at least 1,250 Egyptian pounds", "EGP", "1250", None, False, False),
    (
        "find shoes exactly 80.125 Kuwaiti dinars",
        "KWD",
        "80.125",
        "80.125",
        False,
        False,
    ),
    ("find shoes between 20 and 50 euros", "EUR", "20", "50", False, False),
    ("find shoes above 20 euros and below 50 euros", "EUR", "20", "50", True, True),
]
CASES += [
    (f"find shoes under {amount}", code, None, "31.75", False, True)
    for name, code in NAMES
    for amount in (f"31.75 {name}", f"{name} 31.75")
]
CONFLICTS = [
    "find shoes above 20 euros and below 50 Canadian dollars",
    "find shoes between 20 euros and 50 Canadian dollars",
    "find shoes below USD 50 euros",
]


@pytest.fixture(scope="module")
def resolutions():
    messages = [case[0] for case in CASES] + CONFLICTS
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    output = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import {loadRuntime} from './src/runtime.ts'; "
                "import {resolve} from './src/engine.ts'; const c=await loadRuntime(); "
                "console.log(JSON.stringify(JSON.parse(process.argv[1]).map(t=>resolve(c,t))));"
            ),
            json.dumps(messages),
        ],
        cwd=engine,
        capture_output=True,
        text=True,
        check=True,
    )
    return dict(zip(messages, json.loads(output.stdout), strict=True))


@pytest.mark.parametrize("message,currency,low,high,strict_low,strict_high", CASES)
def test_currency_and_boundaries_reach_catalog(
    resolutions, message, currency, low, high, strict_low, strict_high
):
    resolution = gate.Resolution.model_validate(resolutions[message])
    assert standard_route(resolution) == "search"
    plan = shopping_plan(interpreted(resolution), message)
    assert not plan.clarification
    assert plan.query == "shoes"
    assert (plan.currency, plan.min_price, plan.max_price) == (currency, low, high)
    assert (plan.exclusive_min, plan.exclusive_max) == (strict_low, strict_high)


@pytest.mark.parametrize("message", CONFLICTS)
def test_conflicting_named_currencies_require_clarification(resolutions, message):
    plan = shopping_plan(
        interpreted(gate.Resolution.model_validate(resolutions[message])), message
    )
    assert plan.clarification
    answer, calls = asyncio.run(scenario(message, {}, [product()]))
    assert "currency" in answer.text
    assert not any(call["name"] == "search_products" for call in calls)


def test_literal_currency_overrides_missing_or_incorrect_extraction():
    answer, calls = asyncio.run(
        scenario(
            "shoes under 50 euros",
            {"currency": "USD"},
            [
                product(1, price="49.99", currency="EUR"),
                product(2, price="50", currency="EUR"),
                product(3, price="40", currency="USD"),
            ],
        )
    )
    assert [
        (p.price, p.currency) for b in answer.blocks for p in (b.products or [])
    ] == [("49.99", "EUR")]
    search = next(
        call["arguments"] for call in calls if call["name"] == "search_products"
    )
    assert search["max_price"] == "50"
    # The catalog transport sends the amount; final product verification above
    # enforces the strict boundary and currency against authoritative prices.


def test_literal_ranges_are_recovered_without_provider_currency():
    assert retain_price_bounds({}, "between 20 and 50 euros") == {
        "min_price": "20",
        "max_price": "50",
        "exclusive_min": False,
        "exclusive_max": False,
        "currency": "EUR",
    }
    with pytest.raises(ValueError, match="currency"):
        retain_price_bounds({}, "between 20 euros and 50 US dollars")


def test_named_currency_followup_reaches_complete_catalog_plan():
    from test_language_understanding import interpret

    raw = interpret(
        [
            {
                "messages": [
                    "find shoes above 20 euros and below 50 euros",
                    "budget 40",
                ]
            }
        ]
    )[0][-1]
    plan = shopping_plan(
        interpreted(gate.Resolution.model_validate(raw)), raw["interpretationText"]
    )
    assert plan is not None and not plan.clarification
    assert (plan.currency, plan.min_price, plan.max_price) == ("EUR", "20", "40")
    assert plan.exclusive_min and not plan.exclusive_max
