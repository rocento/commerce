import asyncio
import json

from test_baskets import PID, scenario

from app.commerce_action_engine.actions.shopping.baskets import (
    BasketGoal,
    BasketPlan,
    QuantityEdit,
)


def test_measured_rules_reach_planning_without_customer_identity():
    previous = {
        "goal": BasketGoal(currency="EGP", budget="100").model_dump(),
        "selections": [
            {
                "product_id": PID,
                "quantity": 1,
                "replaces": None,
                "reason": "250 g pack",
                "required_attributes": {},
            }
        ],
    }
    plan = BasketPlan(
        goal=BasketGoal(currency="EGP", budget="100"),
        quantities=[QuantityEdit(product_id=PID, quantity=3)],
    )
    _, drafts, _, provider = asyncio.run(
        scenario(
            plan,
            message="Make the proposed coffee 0.75 kg, keep the EGP 100 budget",
            previous=previous,
            market_context={
                "market": {"enabled": True, "currency": "EGP"},
                "selling_units": [
                    {
                        "product_id": PID,
                        "rule": {
                            "measure_per_unit": "0.25",
                            "measure_unit": "kg",
                            "minimum": 1,
                            "increment": 1,
                        },
                    }
                ],
                "selling_units_exhaustive": False,
            },
        )
    )
    facts = json.loads(provider.requests[0].messages[0].text.split("\n", 1)[1])
    assert facts["selling_units"][0]["rule"]["measure_per_unit"] == "0.25"
    assert (
        facts["market"]["currency"] == "EGP" and not facts["selling_units_exhaustive"]
    )
    assert drafts[0]["selections"][0]["quantity"] == 3
    assert drafts[0]["goal"]["currency"] == "EGP"
    assert "private-customer" not in json.dumps(facts)
