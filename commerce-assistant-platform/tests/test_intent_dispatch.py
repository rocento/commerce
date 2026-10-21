"""Dictionary-to-action coverage, including honest handoffs and write boundaries."""

import json
import re
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from interpretation_helpers import standard_route
from test_assistant import identity as identity  # noqa: PLC0414 -- pytest fixture
from test_cart_actions import NAME, interpreted, snapshot
from test_enterprise_contracts import context as context  # noqa: PLC0414

from app.commerce_action_engine.actions.catalog.product_facts import (
    PRODUCT_FACT_INTENTS,
)
from app.commerce_action_engine.actions.customer import cart_to_wishlist
from app.commerce_action_engine.actions.shopping import cart
from app.commerce_action_engine.adapters.commerce import CommerceTools
from app.commerce_action_engine.application import handle_turn
from app.commerce_action_engine.application.handlers.guidance import guidance
from app.commerce_action_engine.application.interpretation import interpret_resolution
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.execution.language.handoffs import (
    CONTEXT_INTENTS,
    HANDOFFS,
)
from app.commerce_action_engine.execution.language.routing import CART_ACTION_INTENTS
from app.main import create_app

TAXONOMY = (
    Path(__file__).resolve().parents[1]
    / "app/commerce_language_engine/src/rocento-capabilities.ts"
)
CODES = re.search(r"new Set\(`(.*?)`", TAXONOMY.read_text(), re.DOTALL).group(1).split()


def resolved(intent, **updates):
    return gate.Resolution.model_validate(
        {
            "status": "RESOLVED",
            "intent": intent,
            "confidence": 0.99,
            "message": "Understood.",
            **updates,
        }
    )


@pytest.mark.parametrize("intent", CODES)
def test_every_dictionary_intent_has_an_explicit_route(intent):
    assert standard_route(resolved(intent)) in {
        "product_fact",
        "search",
        "comparison",
        "comparison_clear",
        "cart",
        "cart_action",
        "wishlist",
        "wishlist_remove",
        "wishlist_to_cart",
        "order",
        "locations",
        "support",
        "support_detail",
        "reorder",
        "guided_action",
        "handoff",
        "context",
        "delivery",
        "shipment",
    }


@pytest.mark.parametrize("intent", CODES)
def test_status_confidence_and_missing_slots_precede_dispatch(intent):
    for updates in [
        {"status": "AMBIGUOUS"},
        {"status": "NEEDS_CONTEXT"},
        {"confidence": 0.1},
        {"missing": ["productReference"]},
    ]:
        assert standard_route(resolved(intent, **updates)) == "clarify"
    assert standard_route(resolved(intent, status="UNKNOWN")) == "fallback"


def test_handoffs_reference_real_storefront_routes(context):
    source = (TAXONOMY.parents[4] / "commerce-web/apps/storefront/src/main.tsx").read_text()
    assert set(HANDOFFS) <= set(CODES)
    for intent, handoff in HANDOFFS.items():
        assert f'path="{handoff.path}"' in source, intent
        assert f"]({handoff.path})" in guidance(
            interpret_resolution(resolved(intent), context).result
        )


def test_cart_dispatch_inventory_matches_the_executor():
    assert CART_ACTION_INTENTS == cart.WRITE_INTENTS | cart.CHECKOUT_INTENTS


def test_resolved_search_in_shopping_mode_does_not_start_model_basket_planning(
    identity,
    monkeypatch,
):
    config, request_id, headers = identity

    async def resolve(url, message):
        return resolved("PRODUCT_SEARCH", entities={"productText": "shoes"})

    monkeypatch.setattr(gate, "resolve", resolve)
    with TestClient(create_app(config)) as client:
        response = client.post(
            "/v1/chat",
            headers=headers(),
            json={
                "request_id": request_id,
                "conversation_id": request_id,
                "message": "find shoe products",
                "shopping_mode": "shop",
            },
        )
    # Without a configured catalog, the deterministic search explains the missing
    # capability. The basket branch would instead try model planning and fail.
    assert '"code":"area_unavailable"' in response.text
    assert "event: done" in response.text
    assert "event: error" not in response.text


@pytest.mark.parametrize("shopping_mode", [None, "shop"])
def test_every_handoff_and_context_reply_completes_without_commerce_writes(
    identity,
    monkeypatch,
    shopping_mode,
    context,
):
    config, request_id, headers = identity

    async def resolve(url, message):
        return resolved(message)

    async def forbidden(*args, **kwargs):
        pytest.fail("A handoff/context response attempted a commerce operation")

    monkeypatch.setattr(gate, "resolve", resolve)
    for method in ("change_cart", "cart", "wishlist", "create_ticket", "orders"):
        monkeypatch.setattr(CommerceTools, method, forbidden)
    with TestClient(create_app(config)) as client:
        for intent in sorted(
            (set(HANDOFFS) - {"CART_MOVE_FROM_WISHLIST"} - PRODUCT_FACT_INTENTS)
            | CONTEXT_INTENTS
        ):
            body = {"request_id": request_id, "message": intent}
            if shopping_mode:
                body.update(shopping_mode=shopping_mode, conversation_id=request_id)
            response = client.post("/v1/chat", headers=headers(), json=body)
            events = [
                json.loads(line[6:])
                for line in response.text.splitlines()
                if line.startswith("data: ")
            ]
            assert response.status_code == 200, intent
            assert events[-1]["type"] == "done", intent
            assert not any(e["type"] == "error" for e in events), intent
            assert guidance(
                interpret_resolution(resolved(intent), context).result
            ) in "".join(e.get("text", "") for e in events), intent


@pytest.mark.parametrize("intent", sorted(CART_ACTION_INTENTS))
@pytest.mark.parametrize("shopping_mode", [None, "shop"])
def test_resolved_cart_action_reaches_executor_without_a_search_plan(
    identity,
    monkeypatch,
    intent,
    shopping_mode,
):
    config, request_id, headers = identity
    resolution = resolved(
        intent, requiresConfirmation=True, entities={"productText": NAME, "quantity": 2}
    )

    async def resolve(url, message):
        return resolution

    execute = AsyncMock(
        return_value=cart.CartUpdated("Verified cart result.", snapshot())
    )
    wishlist_execute = AsyncMock(
        return_value=cart_to_wishlist.WishlistNeedsInput(
            "Verified cart result.", snapshot()
        )
    )
    read_cart = AsyncMock(return_value=snapshot(3))
    change_cart = AsyncMock(side_effect=AssertionError("Removal needs confirmation"))
    monkeypatch.setattr(gate, "resolve", resolve)
    monkeypatch.setattr(cart, "execute_cart", execute)
    monkeypatch.setattr(cart_to_wishlist, "execute", wishlist_execute)
    if intent == "REMOVE_FROM_CART":
        monkeypatch.setattr(CommerceTools, "cart", read_cart)
        monkeypatch.setattr(CommerceTools, "change_cart", change_cart)
    monkeypatch.setattr(
        handle_turn,
        "shopping_plan",
        lambda *args: pytest.fail("Cart action entered search validation"),
    )
    body = {"request_id": request_id, "message": f"{intent} {NAME}"}
    if shopping_mode:
        body.update(shopping_mode=shopping_mode, conversation_id=request_id)
    with TestClient(create_app(config)) as client:
        response = client.post(
            "/v1/chat",
            # Dispatch assumes location selection is complete. The delivery
            # suite separately verifies configured/unconfigured stores and
            # requests both with and without selected coordinates.
            headers={
                **headers(),
                "x-delivery-latitude": "30",
                "x-delivery-longitude": "31",
            },
            json=body,
        )
    if intent == "REMOVE_FROM_CART":
        # Removal dispatch now resolves the owned item for a confirmation card.
        read_cart.assert_awaited_once()
        change_cart.assert_not_awaited()
        execute.assert_not_awaited()
        assert '"kind":"cart_removal_choice"' in response.text
        assert "confirm removal of 2" in response.text
    else:
        if intent in cart.WISHLIST_INTENTS:
            wishlist_execute.assert_awaited_once()
            execute.assert_not_awaited()
        else:
            execute.assert_awaited_once()
            wishlist_execute.assert_not_awaited()
        assert "Verified cart result." in response.text
        assert '"kind":"cart_summary"' in response.text
    assert "event: done" in response.text
    assert "event: error" not in response.text


@pytest.mark.parametrize(
    "status", ["RESOLVED", "AMBIGUOUS", "NEEDS_CONTEXT", "UNKNOWN"]
)
def test_transfer_words_never_override_the_resolution_or_write_all_saved_items(
    identity,
    monkeypatch,
    status,
):
    config, request_id, headers = identity

    async def resolve(url, message):
        return resolved("CART_MOVE_FROM_WISHLIST", status=status, message="Which item?")

    change = AsyncMock(side_effect=AssertionError("Unexpected write"))
    monkeypatch.setattr(gate, "resolve", resolve)
    monkeypatch.setattr(CommerceTools, "change_cart", change)
    monkeypatch.setattr(CommerceTools, "cart", AsyncMock(return_value=snapshot()))
    with TestClient(create_app(config)) as client:
        response = client.post(
            "/v1/chat",
            headers=headers(),
            json={
                "request_id": request_id,
                "message": "move one item from wishlist to cart",
            },
        )
    change.assert_not_awaited()
    assert "Moved" not in response.text
    assert "event: done" in response.text


@pytest.mark.parametrize(
    "updates",
    [
        {"status": "UNKNOWN"},
        {"confidence": 0.1},
        {"missing": ["quantity"]},
        {"intent": "CART_MOVE_FROM_WISHLIST"},
        {"requestType": "COMPOUND"},
        {"entities": {"quantity": 2, "excluded": {"color": ["red"]}}},
        {"entities": {"destination": "wishlist"}},
    ],
)
def test_executor_rejects_incomplete_or_unsupported_semantics(updates):
    import asyncio

    tools = AsyncMock()
    result = (
        resolved("ADD_TO_CART", **updates)
        if "intent" not in updates
        else resolved(**updates)
    )
    text, snapshot_result, choices = asyncio.run(
        cart.execute(interpreted(result), "add apples to cart", tools)
    )
    tools.change_cart.assert_not_awaited()
    tools.cart.assert_not_awaited()
    assert text and snapshot_result is None
    assert choices == []
