"""Whole-cart paraphrases use the real language engine and guarded cart path."""

import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient
from interpretation_helpers import standard_route
from test_assistant import identity as identity  # noqa: PLC0414
from test_cart_actions import interpreted, snapshot
from test_language_understanding import ENGINE, interpret, real_resolve

from app.commerce_action_engine.actions.shopping.cart import execute
from app.commerce_action_engine.execution.language import gate
from app.main import create_app


@pytest.fixture(scope="module")
def interpretations():
    cases = json.loads((ENGINE / "tests/fixtures/cart-clear.json").read_text())
    messages = [text for group in cases.values() for text in group]
    runs = interpret([{"messages": [text]} for text in messages])
    results = {
        text: gate.Resolution.model_validate(run[0])
        for text, run in zip(messages, runs, strict=True)
    }
    return cases, results


def test_whole_cart_phrases_clear_once_and_return_the_authoritative_snapshot(
    interpretations,
):
    cases, results = interpretations
    for message in cases["commands"] + cases["requests"]:
        result = results[message]
        assert standard_route(result) == "cart_action", message
        assert result.intent == "CLEAR_CART", message
        tools = AsyncMock()
        tools.cart.return_value = snapshot(2)
        tools.change_cart.return_value = snapshot(0)
        text, cart, choices = asyncio.run(execute(interpreted(result), message, tools))
        tools.change_cart.assert_awaited_once_with({"action": "clear"})
        tools.search_cart_product.assert_not_awaited()
        assert cart is tools.change_cart.return_value and not cart.items, message
        assert text == "Your cart has been cleared." and not choices, message


def test_partial_qualified_and_informational_phrases_cannot_clear_the_cart(
    interpretations,
):
    cases, results = interpretations
    for message in cases["protected"] + cases["itemRemovals"]:
        result = results[message]
        assert not (
            result.intent == "CLEAR_CART" and standard_route(result) == "cart_action"
        ), message
    for message in [
        "clear only unavailable items in cart",
        "how do I clear my cart",
        "clear cart after checkout",
    ]:
        tools = AsyncMock()
        result = results[message]
        assert standard_route(result) == "clarify"
        asyncio.run(execute(interpreted(result), message, tools))
        tools.cart.assert_not_awaited()
        tools.change_cart.assert_not_awaited()


def test_new_wording_handles_an_already_empty_cart_without_writing(interpretations):
    _, results = interpretations
    message = "remove all products in cart"
    tools = AsyncMock()
    tools.cart.return_value = snapshot(0)
    text, cart, _ = asyncio.run(execute(interpreted(results[message]), message, tools))
    assert text == "Your cart is already empty." and not cart.items
    tools.change_cart.assert_not_awaited()


@pytest.mark.parametrize(
    "message,clear",
    [
        ("remove all products in cart", True),
        ("Could you please remove all products in cart?", True),
        ("delete everything in my shopping cart", True),
        ("empty out my basket", True),
        ("clear only unavailable items in cart", False),
        ("remove all products in cart except milk", False),
        ("how do I clear my cart", False),
    ],
)
def test_clear_cart_wording_reaches_the_authenticated_sse_path(
    identity, monkeypatch, message, clear
):
    monkeypatch.setattr(gate, "resolve", real_resolve)
    calls = []

    class NoModel:
        async def generate(self, request):
            pytest.fail("A deterministic cart command reached the model")

        async def aclose(self):
            pass

    def commerce(request):
        assert clear, "A clarification made a commerce call"
        assert request.url.path == "/v1/assistant-tools/cart"
        calls.append(request.method)
        if request.method == "GET":
            return httpx.Response(200, json=snapshot(2).model_dump(mode="json"))
        assert request.method == "POST"
        assert request.headers["Authorization"] == "Bearer cart-write"
        assert json.loads(request.content) == {"action": "clear"}
        return httpx.Response(200, json=snapshot(0).model_dump(mode="json"))

    config, request_id, headers = identity
    with TestClient(
        create_app(config, model=NoModel(), transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={
                **headers(),
                "x-commerce-cart-token": "cart-read",
                "x-commerce-cart-write-token": "cart-write",
            },
            json={"request_id": request_id, "message": message},
        )
    assert response.status_code == 200
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert events[-1]["type"] == "done" and not any(
        e["type"] == "error" for e in events
    )
    if clear:
        assert calls == ["GET", "POST"]
        assert "Your cart has been cleared." in response.text
    else:
        assert not calls and any(e.get("clarification") for e in events)
