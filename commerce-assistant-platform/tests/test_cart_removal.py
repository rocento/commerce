"""Receipts require a unique owned cart item and a verified removal response."""

import asyncio
from unittest.mock import AsyncMock
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_cart_actions import ID, NAME, interpreted, snapshot
from test_product_guidance import frames, real_engine
from test_product_guidance import (
    no_model as no_model,  # noqa: PLC0414 -- pytest fixture
)

from app.commerce_action_engine.actions.shopping.cart_removal import (
    RemovalCompleted,
    RemovalNeedsChoice,
    RemovalNeedsConfirmation,
    RemovalNeedsInput,
    RemovalNoChange,
    RemovalUnverified,
    remove_from_cart,
)
from app.commerce_action_engine.adapters.commerce import ToolUnavailable
from app.commerce_action_engine.application.responses import validate_blocks
from app.commerce_action_engine.contracts import AssistantBlock
from app.commerce_action_engine.execution.language.gate import Resolution
from app.main import create_app


def resolution(query="Gala", **entities):
    return interpreted(
        Resolution(
            status="RESOLVED",
            intent="REMOVE_FROM_CART",
            confidence=1,
            message="",
            entities={"productText": query, **entities},
        )
    )


@pytest.mark.parametrize("query", ["Gala", "gala apples", NAME])
def test_unique_cart_name_requests_confirmation_without_mutation(query):
    tools = AsyncMock()
    tools.cart.return_value = snapshot(3)
    tools.change_cart.return_value = snapshot(0)
    result = asyncio.run(
        remove_from_cart(resolution(query), f"remove {query} from cart", tools)
    )
    assert isinstance(result, RemovalNeedsConfirmation)
    assert result.status == "needs_confirmation" and result.quantity == 3
    assert len(result.choices) == 1 and result.choices[0].name == NAME
    assert "confirm removal of 3" in result.text
    tools.search_cart_product.assert_not_awaited()
    tools.change_cart.assert_not_awaited()


@pytest.mark.parametrize("quantity,before", [(1, 3), (3, 5)])
def test_confirmed_quantity_preserved_even_when_cart_grew(quantity, before):
    tools = AsyncMock()
    tools.cart.return_value = snapshot(before)
    tools.change_cart.return_value = snapshot(2)
    result = asyncio.run(
        remove_from_cart(
            resolution(quantity=quantity),
            f"Confirm removal of {quantity} from my cart",
            tools,
            selected_product_id=UUID(ID),
            confirmed=True,
        )
    )
    assert isinstance(result, RemovalCompleted)
    assert result.status == "completed"
    assert (
        result.receipt.quantity == quantity and result.receipt.remaining_quantity == 2
    )
    tools.change_cart.assert_awaited_once_with(
        {"action": "remove", "product_id": ID, "quantity": quantity}
    )


def test_ambiguous_current_cart_names_offer_owned_items_without_writing():
    tools = AsyncMock()
    cart = snapshot(3)
    second = cart.items[0].model_copy(
        update={"product_id": UUID(int=77), "name": "Gala Apples 500g", "quantity": 2}
    )
    tools.cart.return_value = cart.model_copy(update={"items": [cart.items[0], second]})
    result = asyncio.run(
        remove_from_cart(resolution(quantity=1), "remove 1 Gala", tools)
    )
    assert isinstance(result, RemovalNeedsChoice)
    assert len(result.choices) == 2
    tools.change_cart.assert_not_awaited()
    tools.search_cart_product.assert_not_awaited()


@pytest.mark.parametrize("quantity", [0, 3])
def test_generic_removal_offers_current_cart_items(quantity):
    tools = AsyncMock()
    tools.cart.return_value = snapshot(quantity)
    result = asyncio.run(
        remove_from_cart(resolution(""), "Remove items from cart", tools)
    )
    if quantity:
        assert isinstance(result, RemovalNeedsChoice)
        assert result.choices == tuple(tools.cart.return_value.items)
    else:
        assert isinstance(result, RemovalNoChange)
        assert result.reason == "empty_cart"
    assert ("Choose an item" if quantity else "cart is empty") in result.text
    tools.change_cart.assert_not_awaited()
    tools.search_cart_product.assert_not_awaited()


@pytest.mark.parametrize("owned", [True, False])
def test_fuzzy_catalog_matches_never_authorize_removal(owned):
    tools = AsyncMock()
    tools.cart.return_value = snapshot(3)
    tools.search_cart_product.return_value = [
        {"id": ID if owned else str(UUID(int=55)), "name": NAME}
    ]
    result = asyncio.run(remove_from_cart(resolution("Galaa"), "remove Galaa", tools))
    if owned:
        assert isinstance(result, RemovalNeedsChoice)
        assert result.choices == tuple(tools.cart.return_value.items)
    else:
        assert isinstance(result, RemovalNoChange)
        assert result.reason == "not_found"
    tools.change_cart.assert_not_awaited()


@pytest.mark.parametrize("quantity", [0, -1, 1.5, True, "2", 1000001])
def test_invalid_quantities_never_read_or_write_cart(quantity):
    tools = AsyncMock()
    result = asyncio.run(
        remove_from_cart(resolution(quantity=quantity), "remove Gala", tools)
    )
    assert isinstance(result, RemovalNeedsInput)
    assert result.cart is None
    tools.cart.assert_not_awaited()
    tools.change_cart.assert_not_awaited()


@pytest.mark.parametrize("failed", [True, False])
def test_uncertain_or_unchanged_cart_never_produces_success_receipt(failed):
    tools = AsyncMock()
    tools.cart.return_value = snapshot(3)
    tools.change_cart.side_effect = ToolUnavailable() if failed else None
    tools.change_cart.return_value = snapshot(3)
    result = asyncio.run(
        remove_from_cart(
            resolution(quantity=3),
            "Confirm removal of 3 from my cart",
            tools,
            selected_product_id=UUID(ID),
            confirmed=True,
        )
    )
    assert isinstance(result, RemovalUnverified)
    assert result.status == "unverified"
    assert result.reason == ("write_unavailable" if failed else "receipt_mismatch")
    assert result.cart == (None if failed else snapshot(3))
    assert "confirm" in result.text
    tools.change_cart.assert_awaited_once()


def test_selected_item_removed_elsewhere_does_not_fall_back_to_another_name():
    tools = AsyncMock()
    tools.cart.return_value = snapshot(3)
    result = asyncio.run(
        remove_from_cart(
            resolution(NAME), "remove this", tools, selected_product_id=UUID(int=77)
        )
    )
    assert isinstance(result, RemovalNoChange)
    assert result.reason == "stale_selection" and "no longer" in result.text
    tools.search_cart_product.assert_not_awaited()
    tools.change_cart.assert_not_awaited()


@pytest.mark.parametrize("mode", ["initial", "generic", "selected", "confirmed"])
def test_real_removal_route_requires_confirmation_and_then_returns_only_receipt(
    identity, monkeypatch, mode
):
    real_engine(monkeypatch)
    config, request_id, headers = identity
    writes = []

    def commerce(request):
        assert request.url.path == "/v1/assistant-tools/cart"
        if request.method == "GET":
            return httpx.Response(200, json=snapshot(3).model_dump(mode="json"))
        assert request.headers["authorization"] == "Bearer cart-write-token"
        writes.append(request.read().decode())
        return httpx.Response(200, json=snapshot(0).model_dump(mode="json"))

    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        events = frames(
            client.post(
                "/v1/chat",
                headers={
                    **headers(),
                    "x-commerce-cart-token": "cart-token",
                    "x-commerce-cart-write-token": "cart-write-token",
                },
                json={
                    "request_id": request_id,
                    "message": {
                        "initial": "remove Gala from cart",
                        "generic": "remove items from cart",
                        "selected": "Remove this from my cart",
                        "confirmed": "Confirm removal of 3 from my cart",
                    }[mode],
                    **({"product_id": ID} if mode in {"selected", "confirmed"} else {}),
                },
            )
        )
    blocks = next(e["blocks"] for e in events if e["type"] == "content.blocks")
    if mode == "confirmed":
        assert [b["kind"] for b in blocks] == ["cart_removal"]
        assert blocks[0]["cart_removal"]["name"] == NAME
        assert blocks[0]["cart_removal"]["quantity"] == 3
        assert len(writes) == 1 and ID in writes[0]
        assert '"quantity":3' in writes[0]
    else:
        assert [b["kind"] for b in blocks] == ["cart_removal_choice"]
        assert blocks[0]["cart_removal_choice"]["items"][0]["name"] == NAME
        assert writes == []


@pytest.mark.parametrize(
    "message",
    [
        "do not remove Gala from cart",
        "don't remove Gala from cart",
        "remove 0 Gala from cart",
    ],
)
def test_real_engine_rejects_negation_and_invalid_quantity_before_mutation(message):
    from test_bestseller_periods import interpret

    tools = AsyncMock()
    result = asyncio.run(
        remove_from_cart(interpreted(interpret(message)), message, tools)
    )
    assert isinstance(result, RemovalNeedsInput)
    tools.cart.assert_not_awaited()
    tools.change_cart.assert_not_awaited()


def test_confirmed_quantity_no_longer_available_does_not_write():
    tools = AsyncMock()
    tools.cart.return_value = snapshot(2)
    result = asyncio.run(
        remove_from_cart(
            resolution(quantity=3),
            "Confirm removal of 3 from my cart",
            tools,
            selected_product_id=UUID(ID),
            confirmed=True,
        )
    )
    assert isinstance(result, RemovalNeedsInput)
    assert result.cart == snapshot(2) and "only 2" in result.text
    tools.change_cart.assert_not_awaited()


def test_receipt_contract_rejects_inconsistent_remaining_quantity_and_mixed_content():
    receipt = {
        "product_id": ID,
        "name": NAME,
        "quantity": 1,
        "remaining_quantity": 2,
        "cart_quantity": 2,
        "cart_subtotal": "5.00",
        "currency": "USD",
    }
    validate_blocks([AssistantBlock(kind="cart_removal", cart_removal=receipt)])
    for block in [
        AssistantBlock(
            kind="cart_removal", cart_removal={**receipt, "cart_quantity": 1}
        ),
        AssistantBlock(kind="cart_removal", cart_removal=receipt, text="mixed"),
        AssistantBlock(
            kind="cart_removal_choice",
            cart_removal_choice={"items": [snapshot().items[0]] * 2, "quantity": None},
        ),
    ]:
        with pytest.raises(ValueError):
            validate_blocks([block])
