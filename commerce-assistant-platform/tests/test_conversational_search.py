"""Search command corrections must survive the real language/catalog boundary."""

import pytest
from interpretation_helpers import standard_route
from test_language_understanding import interpret
from test_shopping import interpreted

from app.commerce_action_engine.application.interpretation import shopping_plan
from app.commerce_action_engine.execution.language import gate


@pytest.mark.parametrize("head", ["serch for", "lok for", "looking fr"])
def test_corrected_command_retains_product_budget_and_independent_purpose(head):
    messages = [
        f"   could you please {head} three fnd lanterns under 30 euros?",
        f"please {head} lanterns for stargazing under $30",
    ]
    results = interpret([{"messages": [message]} for message in messages])
    for message, run, query, currency, purpose in zip(
        messages,
        results,
        ["fnd lanterns", "lanterns"],
        ["EUR", "USD"],
        [None, "stargazing"],
        strict=True,
    ):
        resolution = gate.Resolution.model_validate(run[0])
        assert standard_route(resolution) == "search"
        plan = shopping_plan(interpreted(resolution), message)
        assert plan is not None and not plan.clarification
        assert (plan.query, plan.currency, plan.max_price) == (query, currency, "30")
        assert plan.exclusive_max
        assert plan.intended_use == purpose


@pytest.mark.parametrize(
    "message",
    [
        "don't serch for shoes",
        "don’t lok for shoes",
        "never serch for shoes",
    ],
)
def test_negated_corrected_commands_do_not_admit_catalog_search(message):
    raw = interpret([{"messages": [message]}])[0][0]
    assert raw["status"] == "UNKNOWN" and raw["intent"] is None
    resolution = gate.Resolution.model_validate(raw)
    # Ingress may further restrict an UNKNOWN result when action metadata
    # disagrees. Neither outcome may acquire an executable search plan.
    assert resolution.status in {"UNKNOWN", "NEEDS_CONTEXT"}
    assert resolution.intent is None
    assert standard_route(resolution) != "search"
    assert shopping_plan(interpreted(resolution), message) is None
