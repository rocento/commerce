"""Direct standard-contract discovery preserves exact budget semantics."""

import subprocess
import sys

import pytest
from test_discovery_workflow import resolved

from app.commerce_action_engine.application.interpretation import shopping_plan


def test_catalog_mapper_imports_without_loading_language_wire_transport():
    subprocess.run(
        [
            sys.executable,
            "-c",
            """
import sys
from app.commerce_action_engine.actions.catalog.workflow import map_discovery_request
assert 'app.commerce_action_engine.execution.language.gate' not in sys.modules
assert 'httpx' not in sys.modules
""",
        ],
        check=True,
    )


@pytest.mark.parametrize(
    "operator,min_price,max_price,exclusive_min,exclusive_max",
    [
        (">", "100", None, True, False),
        (">=", "100", None, False, False),
        ("<", None, "100", False, True),
        ("<=", None, "100", False, False),
    ],
)
def test_standard_price_operators_preserve_inclusive_and_exclusive_bounds(
    operator, min_price, max_price, exclusive_min, exclusive_max
):
    result = resolved(
        entities={
            "productText": "shoes",
            "price": {"operator": operator, "value": 100, "currency": "EGP"},
        }
    )
    plan = shopping_plan(result, "find shoes")
    assert plan is not None
    assert (plan.min_price, plan.max_price) == (min_price, max_price)
    assert (plan.exclusive_min, plan.exclusive_max) == (exclusive_min, exclusive_max)
    assert plan.currency == "EGP"
