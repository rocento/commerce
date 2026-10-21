"""The cart read result retains the authoritative snapshot without UI decisions."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

from test_cart_actions import snapshot

from app.commerce_action_engine.actions.shopping.cart_read import (
    CartReadResult,
    read_cart,
)


def test_read_only_capability_returns_the_unchanged_authoritative_snapshot():
    cart = snapshot(3).model_copy(
        update={"discount_amount": "0.50", "fully_reserved": False}
    )
    before = cart.model_dump()
    reader = SimpleNamespace(cart=AsyncMock(return_value=cart))

    result = asyncio.run(read_cart(reader))

    assert isinstance(result, CartReadResult)
    assert result.cart is cart
    assert result.cart.model_dump() == before
    reader.cart.assert_awaited_once_with()
