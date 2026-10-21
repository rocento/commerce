import json
from uuid import UUID

import pytest

from app.commerce_action_engine.application.responses import cart_block, validate_blocks
from app.commerce_action_engine.contracts import (
    AssistantBlock,
    AssistantCart,
    AssistantCartItem,
)


def snapshot(count=2, name="Apples", reserved=False):
    return AssistantCart(
        items=[
            AssistantCartItem(
                product_id=UUID(int=i + 1),
                name=name,
                price="3.50",
                currency="USD",
                quantity=2,
                line_total="7.00",
            )
            for i in range(count)
        ],
        subtotal=f"{count * 7}.00",
        discount_amount="1.50" if count else "0",
        currency="USD",
        fully_reserved=reserved,
    )


@pytest.mark.parametrize("count,reserved", [(0, False), (2, False), (10, True)])
def test_cart_snapshot_preserves_authoritative_items_and_totals(count, reserved):
    cart = snapshot(count, reserved=reserved)
    block = cart_block(cart)
    assert block.kind == "cart_summary"
    assert block.cart.items == cart.items
    assert block.cart.total_quantity == count * 2
    assert block.cart.total_lines == count
    assert block.cart.subtotal == cart.subtotal
    assert block.cart.discount_amount == cart.discount_amount
    assert block.cart.fully_reserved is reserved


def test_large_unicode_cart_keeps_full_totals_and_fits_stream_budget():
    cart = snapshot(200, name="🍎" * 1000)
    block = cart_block(cart)
    payload = json.dumps([block.model_dump(mode="json", exclude_unset=True)]).encode()
    assert len(payload) <= 24576
    assert 0 < len(block.cart.items) < 200
    assert len(cart.items) == 200
    assert block.cart.total_lines == 200
    assert block.cart.total_quantity == 400
    assert block.cart.subtotal == "1400.00"
    assert block.cart.items[0].name == cart.items[0].name


@pytest.mark.parametrize(
    "change",
    [
        {"total_quantity": 1},
        {"total_lines": 1},
        {"total_quantity": 9},
        {"items": []},
    ],
)
def test_invalid_cart_counts_are_rejected(change):
    payload = cart_block(snapshot()).model_dump(mode="json", exclude_unset=True)
    payload["cart"].update(change)
    with pytest.raises(ValueError, match="Invalid cart counts"):
        validate_blocks([AssistantBlock.model_validate(payload)])
