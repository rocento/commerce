"""Cart pricing uses a verified snapshot, exact arithmetic, and read-only routing."""

import json
import subprocess
from pathlib import Path
from uuid import uuid4

import pytest
from interpretation_helpers import standard_route

from app.commerce_action_engine.application.responses import cart_summary_text
from app.commerce_action_engine.contracts import AssistantCart
from app.commerce_action_engine.execution.language.gate import Resolution


def cart(subtotal="12.30", discount="2.10", items=True):
    return AssistantCart.model_validate(
        {
            "items": [
                {
                    "product_id": str(uuid4()),
                    "name": "Tea",
                    "price": "6.15",
                    "currency": "USD",
                    "quantity": 2,
                    "line_total": subtotal,
                }
            ]
            if items
            else [],
            "subtotal": subtotal,
            "discount_amount": discount,
            "currency": "USD",
            "fully_reserved": True,
        }
    )


def test_total_discount_and_checkout_limits():
    text = cart_summary_text(cart())
    assert "2 items" in text
    assert "Subtotal: 12.30 USD" in text
    assert "Total discount: 2.10 USD" in text
    assert "Cart total after discount: 10.20 USD" in text
    assert "before tax and delivery" in text
    assert "final payable total are calculated at checkout" in text


def test_zero_discount_empty_and_fractional_money():
    assert "Total discount: 0.00 USD" in cart_summary_text(cart(discount="0.00"))
    assert "0.10 USD" in cart_summary_text(cart("0.30", "0.20"))
    text = cart_summary_text(cart("0", "0", items=False))
    assert "empty" in text and "Cart total after discount: 0 USD" in text
    assert "not currently reserved" not in text


@pytest.mark.parametrize(
    "subtotal,discount",
    [("NaN", "0"), ("12", "Infinity"), ("bad", "0"), ("12", "13"), ("12", "-1")],
)
def test_invalid_money_never_becomes_a_total(subtotal, discount):
    text = cart_summary_text(cart(subtotal, discount))
    assert "couldn't verify" in text
    assert "Cart total after discount" not in text


def test_screenshot_language_reaches_cart_read():
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    messages = [
        "total cart items",
        "total items in my cart",
        "cart item count",
        "how many items are in my cart",
        "pls total of my items in cart",
        "I need total of my items in cart",
        "show total discount for my cart",
        "delivery fee for my cart",
    ]
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            "import {loadRuntime} from './src/runtime.ts';import {resolve} from './src/engine.ts';const c=await loadRuntime();console.log(JSON.stringify(JSON.parse(process.argv[1]).map(t=>resolve(c,t))));",
            json.dumps(messages),
        ],
        cwd=engine,
        capture_output=True,
        text=True,
        check=True,
    )
    for raw in json.loads(result.stdout):
        resolution = Resolution.model_validate(raw)
        assert resolution.status == "RESOLVED"
        assert resolution.intent == "CART_TOTAL"
        assert standard_route(resolution) == "cart"


def test_item_count_is_quantity_not_distinct_product_count():
    snapshot = cart()
    snapshot.items.append(
        snapshot.items[0].model_copy(
            update={"product_id": uuid4(), "quantity": 3, "line_total": "18.45"}
        )
    )
    snapshot.subtotal = "30.75"
    text = cart_summary_text(snapshot)
    assert "5 items" in text
    assert "Cart total after discount: 28.65 USD" in text
    empty = cart_summary_text(cart("0", "0", items=False))
    assert "0 items" in empty and "Cart total after discount: 0 USD" in empty
