import asyncio
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import pytest

from app.commerce_action_engine.actions.shopping.cart import execute
from app.commerce_action_engine.adapters.commerce import ToolUnavailable
from app.commerce_action_engine.contracts import AssistantCart
from app.commerce_action_engine.contracts.action import ActorContext
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.language.compatibility import (
    adapt_legacy_resolution,
)
from app.commerce_action_engine.execution.language.gate import Resolution

ID = "da090052-c5af-42ad-aa3d-0c48d4237772"
NAME = "Gala Apples 1kg"


def interpreted(result):
    identity = str(UUID(int=1))
    context = SimpleNamespace(
        actor=ActorContext(
            tenant_id=identity,
            store_id=identity,
            session_id=identity,
            request_id=identity,
            channel="evaluation",
        )
    )
    request = adapt_legacy_resolution(result.model_dump(), context)
    assert isinstance(request, InterpretedRequest)
    return request


def test_add_tea_on_cart_offers_catalog_choices_without_writing():
    message = "pls add tea on cart"
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    output = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import {loadRuntime} from './src/runtime.ts';import {resolve} from './src/engine.ts';"
                "console.log(JSON.stringify(resolve(await loadRuntime(),process.argv[1])));"
            ),
            message,
        ],
        cwd=engine,
        capture_output=True,
        text=True,
        check=True,
    )
    parsed = Resolution.model_validate(json.loads(output.stdout))
    assert parsed.status == "RESOLVED" and parsed.entities["productText"] == "tea"
    choices = [
        {"id": ID, "name": "Green Tea 100g"},
        {"id": "da090052-c5af-42ad-aa3d-0c48d4237773", "name": "Black Tea 100g"},
    ]
    for resolution in [
        parsed,
        parsed.model_copy(update={"entities": {"category": "tea"}}),
    ]:
        tools = AsyncMock()
        tools.cart.return_value = snapshot(0)
        tools.search_cart_product.return_value = choices
        text, _, products = asyncio.run(
            execute(interpreted(resolution), message, tools)
        )
        tools.search_cart_product.assert_awaited_once_with("tea")
        tools.change_cart.assert_not_awaited()
        assert products == choices and "choose" in text.lower()


def snapshot(quantity=1):
    return AssistantCart.model_validate(
        {
            "items": [
                {
                    "product_id": ID,
                    "name": NAME,
                    "price": "2.50",
                    "currency": "USD",
                    "quantity": quantity,
                    "line_total": "2.50",
                }
            ]
            if quantity
            else [],
            "subtotal": "2.50" if quantity else "0",
            "discount_amount": "0",
            "currency": "USD",
            "fully_reserved": True,
        }
    )


@pytest.mark.parametrize(
    "intent,entities,message,change",
    [
        ("CLEAR_CART", {}, "clear my cart", {"action": "clear"}),
        (
            "UPDATE_CART_QUANTITY",
            {"quantity": 3},
            f"set {NAME} quantity to 3",
            {"action": "set", "product_id": ID, "quantity": 3},
        ),
        (
            "UPDATE_CART_QUANTITY",
            {"quantity": 0},
            f"set {NAME} quantity to 0",
            {"action": "remove", "product_id": ID},
        ),
        (
            "ADD_TO_CART",
            {"productText": NAME, "quantity": 2},
            f"add 2 {NAME} to cart",
            {"action": "add", "product_id": ID, "quantity": 2},
        ),
        (
            "ADD_TO_CART",
            {"quantity": 2},
            f"add 2 {NAME} to cart",
            {"action": "add", "product_id": ID, "quantity": 2},
        ),
    ],
)
def test_executes_cart_actions_and_returns_authoritative_result(
    intent, entities, message, change
):
    tools = AsyncMock()
    tools.cart.return_value = snapshot()
    tools.search_cart_product.return_value = [{"id": ID, "name": NAME}]
    tools.change_cart.return_value = snapshot(0)
    result = Resolution(
        status="RESOLVED", intent=intent, entities=entities, message="", confidence=1
    )
    text, cart, _ = asyncio.run(execute(interpreted(result), message, tools))
    tools.change_cart.assert_awaited_once_with(change)
    assert cart is tools.change_cart.return_value
    assert text


@pytest.mark.parametrize(
    "intent,entities,message",
    [
        ("REMOVE_FROM_CART", {}, "remove apples from cart"),
        ("UPDATE_CART_QUANTITY", {}, f"change {NAME} quantity"),
        ("UPDATE_CART_QUANTITY", {"quantity": -1}, f"set {NAME} quantity to -1"),
        ("UPDATE_CART_QUANTITY", {"quantity": True}, f"set {NAME} quantity"),
        ("ADD_TO_CART", {"productText": "apples", "quantity": 2}, "add apples to cart"),
    ],
)
def test_ambiguous_or_invalid_instructions_do_not_write(intent, entities, message):
    tools = AsyncMock()
    tools.cart.return_value = snapshot()
    tools.search_cart_product.return_value = [{"id": ID, "name": NAME}]
    result = Resolution(
        status="RESOLVED", intent=intent, entities=entities, message="", confidence=1
    )
    text, _, choices = asyncio.run(execute(interpreted(result), message, tools))
    tools.change_cart.assert_not_awaited()
    assert text
    if len(tools.search_cart_product.return_value) > 1:
        assert choices


@pytest.mark.parametrize(
    "intent", ["START_CHECKOUT", "CONTINUE_CHECKOUT", "CREATE_ORDER"]
)
@pytest.mark.parametrize("quantity", [0, 1])
def test_checkout_uses_customer_checkout_flow(intent, quantity):
    tools = AsyncMock()
    tools.cart.return_value = snapshot(quantity)
    result = Resolution(status="RESOLVED", intent=intent, message="", confidence=1)
    text, _, _ = asyncio.run(execute(interpreted(result), "checkout", tools))
    tools.change_cart.assert_not_awaited()
    assert ("/checkout" in text) == bool(quantity)


def test_write_failure_is_not_retried_or_reported_as_success():
    tools = AsyncMock()
    tools.cart.return_value = snapshot()
    tools.change_cart.side_effect = ToolUnavailable()
    result = Resolution(
        status="RESOLVED", intent="CLEAR_CART", message="", confidence=1
    )
    text, cart, _ = asyncio.run(execute(interpreted(result), "clear my cart", tools))
    assert "couldn't confirm" in text
    assert cart is None
    tools.change_cart.assert_awaited_once()


def test_unverified_size_suffix_suggests_products_without_writing():
    banana_id = "ed090052-c5af-42ad-aa3d-0c48d4237772"
    tools = AsyncMock()
    tools.cart.return_value = snapshot()
    tools.search_cart_product.return_value = [
        {"id": banana_id, "name": "Local Bananas"},
        {"id": "fd090052-c5af-42ad-aa3d-0c48d4237772", "name": "M13 Local Oranges"},
    ]
    tools.change_cart.return_value = snapshot()
    result = Resolution(
        status="RESOLVED",
        intent="ADD_TO_CART",
        entities={"productText": "Local Bananas 1kg", "category": "banana"},
        message="",
        confidence=1,
    )
    text, _, choices = asyncio.run(
        execute(interpreted(result), "add Local Bananas 1kg to cart", tools)
    )
    tools.change_cart.assert_not_awaited()
    assert "Local Bananas" in text
    assert choices == tools.search_cart_product.return_value


def test_ambiguous_add_returns_products_for_selection():
    tools = AsyncMock()
    tools.cart.return_value = snapshot()
    tools.search_cart_product.return_value = [
        {"id": ID, "name": "Gala Apples 1kg"},
        {"id": "fd090052-c5af-42ad-aa3d-0c48d4237772", "name": "Green Apples 1kg"},
    ]
    result = Resolution(
        status="RESOLVED",
        intent="ADD_TO_CART",
        entities={"productText": "apples"},
        message="",
        confidence=1,
    )
    text, _, choices = asyncio.run(
        execute(interpreted(result), "add apples to cart", tools)
    )
    tools.change_cart.assert_not_awaited()
    assert len(choices) == 2
    assert "choose" in text.casefold()


def test_remove_one_unit_requires_confirmation_and_preserves_cart():
    tools = AsyncMock()
    tools.cart.return_value = snapshot(3)
    tools.change_cart.return_value = snapshot(2)
    result = Resolution(
        status="RESOLVED",
        intent="REMOVE_FROM_CART",
        entities={"quantity": 1},
        message="",
        confidence=1,
    )
    text, cart, choices = asyncio.run(
        execute(interpreted(result), f"remove 1 {NAME} from cart", tools)
    )
    tools.change_cart.assert_not_awaited()
    assert cart.items[0].quantity == 3
    assert choices[0]["product_id"] == ID
    assert "confirm removal of 1" in text


@pytest.mark.parametrize("quantity", [None, 1])
def test_move_to_wishlist_removes_source_after_destination_confirmation(quantity):
    from uuid import UUID

    tools = AsyncMock()
    tools.cart.return_value = snapshot(2)
    tools.change_cart.return_value = snapshot(0 if quantity is None else 1)
    events = []

    async def save(product_id):
        events.append("saved")

    async def remove(change):
        assert events == ["saved"]
        events.append("removed")
        return tools.change_cart.return_value

    tools.add_wishlist_item.side_effect = save
    tools.change_cart.side_effect = remove
    entities = {
        "productText": NAME,
        "sourceCollection": "cart",
        "destination": "wishlist",
    }
    if quantity is not None:
        entities["quantity"] = quantity
    result = Resolution(
        status="RESOLVED",
        intent="CART_MOVE_TO_WISHLIST",
        message="",
        confidence=1,
        entities=entities,
    )
    text, cart, _ = asyncio.run(
        execute(interpreted(result), f"pls move {NAME} to wishlist", tools)
    )
    tools.add_wishlist_item.assert_awaited_once_with(UUID(ID))
    expected = {"action": "remove", "product_id": ID}
    if quantity is not None:
        expected["quantity"] = quantity
    tools.change_cart.assert_awaited_once_with(expected)
    assert text.startswith("Moved")
    assert len(cart.items) == (0 if quantity is None else 1)


@pytest.mark.parametrize(
    "failure", ["missing_source", "wishlist_failed", "removal_failed", "unchanged_cart"]
)
def test_incomplete_wishlist_move_never_claims_success(failure):
    tools = AsyncMock()
    tools.cart.return_value = snapshot(0 if failure == "missing_source" else 2)
    tools.change_cart.return_value = snapshot(2)
    if failure == "wishlist_failed":
        tools.add_wishlist_item.side_effect = ToolUnavailable()
    if failure == "removal_failed":
        tools.change_cart.side_effect = ToolUnavailable()
    result = Resolution(
        status="RESOLVED",
        intent="CART_MOVE_TO_WISHLIST",
        message="",
        confidence=1,
        entities={"productText": NAME, "destination": "wishlist"},
    )
    text, _, _ = asyncio.run(
        execute(interpreted(result), f"pls move {NAME} to wishlist", tools)
    )
    assert not text.startswith("Moved")
    if failure in {"missing_source", "wishlist_failed"}:
        tools.change_cart.assert_not_awaited()
    if failure == "missing_source":
        tools.add_wishlist_item.assert_not_awaited()
        tools.search_cart_product.assert_not_awaited()


@pytest.mark.parametrize(
    "name,material,allowed",
    [
        ("Silver Moon Necklace 45cm", "silver", True),
        ("Moon Necklace 45cm", "silver", False),
    ],
)
def test_wishlist_descriptive_attribute_requires_full_exact_catalog_name(
    name, material, allowed
):
    tools = AsyncMock()
    tools.cart.return_value = snapshot(0)
    tools.search_cart_product.return_value = [{"id": ID, "name": name}]
    result = Resolution(
        status="RESOLVED",
        intent="ADD_TO_WISHLIST",
        confidence=1,
        message="Understood.",
        entities={"productText": name, "material": material, "destination": "wishlist"},
    )
    text, _, _ = asyncio.run(
        execute(interpreted(result), f"Save {name} for later", tools)
    )
    if allowed:
        from uuid import UUID

        tools.add_wishlist_item.assert_awaited_once_with(UUID(ID))
        assert "Saved" in text
    else:
        tools.add_wishlist_item.assert_not_awaited()
        assert "conditions" in text


def test_wishlist_name_attribute_does_not_authorize_partial_product_match():
    tools = AsyncMock()
    tools.cart.return_value = snapshot(0)
    tools.search_cart_product.return_value = [
        {"id": ID, "name": "Silver Moon Necklace 45cm"}
    ]
    result = Resolution(
        status="RESOLVED",
        intent="ADD_TO_WISHLIST",
        confidence=1,
        message="Understood.",
        entities={"productText": "silver necklace", "material": "silver"},
    )
    text, _, products = asyncio.run(
        execute(interpreted(result), "Save silver necklace for later", tools)
    )
    tools.add_wishlist_item.assert_not_awaited()
    assert products and "choose" in text.lower()
