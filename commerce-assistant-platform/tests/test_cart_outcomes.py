"""Cart outcomes distinguish acknowledged writes, uncertainty and read-only handoff."""

import asyncio
from unittest.mock import AsyncMock, call
from uuid import UUID

import pytest
from test_cart_actions import ID, NAME, snapshot
from test_interpreted_cart_actions import request_for

from app.commerce_action_engine.actions.shopping import cart
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable


@pytest.mark.parametrize(
    "intent,entities,change,text",
    [
        ("CLEAR_CART", {}, {"action": "clear"}, "Your cart has been cleared."),
        (
            "ADD_TO_CART",
            {"productText": NAME, "quantity": 2},
            {"action": "add", "product_id": ID, "quantity": 2},
            f"Added 2 × {NAME} to your cart.",
        ),
        (
            "UPDATE_CART_QUANTITY",
            {"productText": NAME, "quantity": 2},
            {"action": "set", "product_id": ID, "quantity": 2},
            f"Changed {NAME} quantity to 2.",
        ),
        (
            "UPDATE_CART_QUANTITY",
            {"productText": NAME, "quantity": 0},
            {"action": "remove", "product_id": ID},
            f"Removed {NAME} from your cart.",
        ),
    ],
)
def test_acknowledged_mutation_keeps_exact_payload_text_and_returned_snapshot(
    intent, entities, change, text
):
    tools = AsyncMock()
    tools.cart.return_value = snapshot(1)
    tools.search_cart_product.return_value = [{"id": ID, "name": NAME}]
    tools.change_cart.return_value = snapshot(2)
    result = asyncio.run(
        cart.execute_cart(request_for(intent, entities=entities), "change cart", tools)
    )
    assert isinstance(result, cart.CartUpdated)
    assert result.text == text and result.cart is tools.change_cart.return_value
    tools.change_cart.assert_awaited_once_with(change)
    assert tools.mock_calls[0] == call.cart()


@pytest.mark.parametrize(
    "updates",
    [
        {"status": "NEEDS_CONTEXT"},
        {"confidence": {"raw": 0.64, "calibrated": 1}},
        {"missing": ["product"]},
        {"request_type": "COMPOUND"},
        {"entities": {"productText": NAME, "price": 2}},
    ],
)
def test_incomplete_or_unsupported_request_stops_before_reads(updates):
    tools = AsyncMock()
    result = asyncio.run(cart.execute_cart(request_for(**updates), "add", tools))
    assert isinstance(result, cart.CartNeedsInput) and result.cart is None
    assert tools.mock_calls == []


@pytest.mark.parametrize(
    "intent", ["REMOVE_FROM_CART", "ADD_TO_WISHLIST", "CART_MOVE_TO_WISHLIST"]
)
def test_other_journeys_cannot_accidentally_enter_cart_mutation_path(intent):
    tools = AsyncMock()
    result = asyncio.run(cart.execute_cart(request_for(intent), "change", tools))
    assert isinstance(result, cart.CartNeedsInput)
    assert tools.mock_calls == []


@pytest.mark.parametrize(
    "intent", ["START_CHECKOUT", "CONTINUE_CHECKOUT", "CREATE_ORDER"]
)
@pytest.mark.parametrize("quantity", [0, 2])
def test_checkout_outcome_requires_owned_nonempty_cart_without_a_write(
    intent, quantity
):
    tools = AsyncMock()
    tools.cart.return_value = snapshot(quantity)
    result = asyncio.run(
        cart.execute_cart(request_for(intent, entities={}), "checkout", tools)
    )
    assert isinstance(result, cart.CartCheckoutReady if quantity else cart.CartNoChange)
    assert result.cart is tools.cart.return_value
    assert tools.mock_calls == [call.cart()]


def test_empty_clear_is_no_change():
    tools = AsyncMock()
    tools.cart.return_value = snapshot(0)
    result = asyncio.run(
        cart.execute_cart(request_for("CLEAR_CART", entities={}), "clear", tools)
    )
    assert isinstance(result, cart.CartNoChange) and result.reason == "empty_cart"
    assert result.text == "Your cart is already empty."
    assert tools.mock_calls == [call.cart()]


@pytest.mark.parametrize("found", [False, True])
def test_add_distinguishes_no_match_from_bounded_deduplicated_choices(found):
    products = [{"id": str(UUID(int=n)), "name": f"Apple {n}"} for n in range(1, 8)]
    tools = AsyncMock()
    tools.cart.return_value = snapshot(0)
    tools.search_cart_product.return_value = [products[0], *products] if found else []
    result = asyncio.run(
        cart.execute_cart(
            request_for(entities={"productText": "apple"}), "add apple", tools
        )
    )
    if found:
        assert isinstance(result, cart.CartNeedsChoice)
        assert result.choices == tuple(products[:5])
    else:
        assert isinstance(result, cart.CartNoChange) and result.reason == "not_found"
    tools.change_cart.assert_not_awaited()


def test_update_catalog_match_must_belong_to_owned_cart():
    tools = AsyncMock()
    tools.cart.return_value = snapshot(1)
    tools.search_cart_product.return_value = [{"id": str(UUID(int=2)), "name": "Other"}]
    result = asyncio.run(
        cart.execute_cart(
            request_for(
                "UPDATE_CART_QUANTITY", entities={"productText": "Other", "quantity": 2}
            ),
            "set Other to 2",
            tools,
        )
    )
    assert isinstance(result, cart.CartNoChange) and result.reason == "not_found"
    tools.change_cart.assert_not_awaited()


@pytest.mark.parametrize("quantity", [None, -1, True, 1000001])
def test_invalid_update_quantity_retains_cart_after_identity_resolution(quantity):
    tools = AsyncMock()
    tools.cart.return_value = snapshot(1)
    result = asyncio.run(
        cart.execute_cart(
            request_for(
                "UPDATE_CART_QUANTITY",
                entities={"productText": NAME, "quantity": quantity},
            ),
            "set quantity",
            tools,
        )
    )
    assert isinstance(result, cart.CartNeedsInput)
    assert result.cart is tools.cart.return_value
    assert result.text == "What quantity should I use? Please provide a whole number."
    assert tools.mock_calls == [call.cart()]


def test_uncertain_write_has_no_cart_evidence_and_is_never_retried():
    tools = AsyncMock()
    tools.cart.return_value = snapshot(1)
    tools.change_cart.side_effect = ToolUnavailable()
    result = asyncio.run(
        cart.execute_cart(request_for("CLEAR_CART", entities={}), "clear", tools)
    )
    assert isinstance(result, cart.CartUpdateUnverified)
    assert not hasattr(result, "cart")
    assert (
        result.text
        == "I couldn't confirm the cart update. [Open your cart](/cart) to check its current contents before trying again."
    )
    assert tools.mock_calls == [call.cart(), call.change_cart({"action": "clear"})]


@pytest.mark.parametrize("stage", ["cart", "change_cart"])
@pytest.mark.parametrize("failure_type", [ToolDenied, asyncio.CancelledError])
def test_denial_and_cancellation_propagate_unchanged_without_successor_calls(
    stage, failure_type
):
    tools = AsyncMock()
    tools.cart.return_value = snapshot(1)
    failure = failure_type()
    if isinstance(failure, ToolDenied):
        failure.completed_action = "wishlist_add"
    getattr(tools, stage).side_effect = failure
    with pytest.raises(failure_type) as caught:
        asyncio.run(
            cart.execute_cart(request_for("CLEAR_CART", entities={}), "clear", tools)
        )
    assert caught.value is failure
    assert tools.mock_calls == (
        [call.cart()]
        if stage == "cart"
        else [call.cart(), call.change_cart({"action": "clear"})]
    )
    if isinstance(failure, ToolDenied):
        assert failure.completed_action == "wishlist_add"
