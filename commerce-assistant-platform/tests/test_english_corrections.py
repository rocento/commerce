"""Expanded English edits must reach typed plans with their original constraints."""

import asyncio
from decimal import Decimal

from interpretation_helpers import standard_route
from test_enterprise_contracts import context as context  # noqa: PLC0414
from test_language_understanding import interpret, real_resolve
from test_shopping import interpreted

from app.commerce_action_engine.application.interpretation import (
    interpret_resolution,
    resolve_search_update,
    shopping_plan,
)
from app.commerce_action_engine.execution.language import gate
from app.commerce_resolution_engine.contracts import Message


def test_new_values_reach_typed_catalog_filters_after_saved_search_replay(
    monkeypatch, context
):
    monkeypatch.setattr(gate, "resolve", real_resolve)
    first, edited = interpret(
        [
            {
                "messages": [
                    "find black shoes under $150",
                    "color dusty periwinkle, brand Acme Atelier and material linen blend",
                ]
            }
        ]
    )[0]
    assert first["status"] == edited["status"] == "RESOLVED"
    message = "size UK 9 and budget eighty dollars and fifty cents"
    initial = asyncio.run(real_resolve("http://engine", message))
    result, text = asyncio.run(
        resolve_search_update(
            "http://engine",
            message,
            [Message("user", edited["interpretationText"])],
            interpret_resolution(initial, context),
            context=context,
        )
    )
    assert result.route == "search"
    result = result.result
    plan = shopping_plan(interpreted(result), text)
    assert plan is not None and not plan.clarification
    assert plan.query == "shoes" and plan.brand == "acme atelier"
    assert {a.name: a.value for a in plan.attributes} == {
        "color": "dusty periwinkle",
        "material": "linen blend",
        "size": "uk 9",
    }
    assert Decimal(plan.max_price) == Decimal("80.50") and plan.currency == "USD"
    assert not plan.exclusive_max


def test_spoken_budget_retains_the_opposite_bound_and_its_strictness():
    runs = interpret(
        [
            {
                "messages": [
                    "find shoes above $50 and under $150",
                    "budget eighty dollars and fifty cents",
                ]
            },
            {
                "messages": [
                    "find shoes between $50 and $150",
                    "actually above sixty point five dollars",
                ]
            },
            {
                "messages": [
                    "find shoes under $150",
                    "actually under eighty point five dollars",
                ]
            },
        ]
    )
    for run, minimum, maximum, strict_min, strict_max in zip(
        runs,
        ["50", "60.5", None],
        ["80.5", "150", "80.5"],
        [True, True, False],
        [False, False, True],
        strict=True,
    ):
        raw = run[-1]
        result = gate.Resolution.model_validate(raw)
        assert standard_route(result) == "search"
        plan = shopping_plan(interpreted(result), raw["interpretationText"])
        assert plan is not None and not plan.clarification
        assert (Decimal(plan.min_price) if plan.min_price is not None else None) == (
            Decimal(minimum) if minimum is not None else None
        )
        assert Decimal(plan.max_price) == Decimal(maximum)
        assert plan.exclusive_min == strict_min and plan.exclusive_max == strict_max


def test_unconsumed_new_values_and_numbers_never_become_a_partial_plan():
    corrections = [
        "color dusty periwinkle and checkout",
        "brand Acme or Other",
        "quantity one thousand thousand",
        "budget eighty and fifty",
        "budget eighty dollars and one hundred cents",
    ]
    runs = interpret(
        [{"messages": ["find shoes under $100", edit]} for edit in corrections]
    )
    for run in runs:
        result = gate.Resolution.model_validate(run[-1])
        assert standard_route(result) == "clarify"
        assert shopping_plan(interpreted(result), run[-1]["text"]) is None
        assert (
            result.context["next"]["activeSearch"]
            == run[0]["context"]["next"]["activeSearch"]
        )
