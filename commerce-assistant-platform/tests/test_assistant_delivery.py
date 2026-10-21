"""Missing delivery location prompts the client before any cart operation."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity  # noqa: F401

from app.commerce_action_engine.actions.shopping.cart import CartNeedsInput
from app.commerce_action_engine.execution.language import gate as language_gate
from app.main import create_app


@pytest.mark.parametrize("configured", [True, False])
@pytest.mark.parametrize("selected", [True, False])
def test_add_to_cart_requests_location_only_when_required(
    identity,  # noqa: F811
    monkeypatch,
    configured,
    selected,
):
    config, request_id, headers = identity
    calls = []
    required = configured and not selected

    async def resolve(url, text):
        return language_gate.Resolution(
            status="RESOLVED",
            intent="ADD_TO_CART",
            confidence=0.99,
            message="Understood.",
            entities={"productText": "fish", "quantity": 1},
        )

    async def execute(*args, selected_product=None):
        assert selected_product is None
        calls.append("cart_action")
        return CartNeedsInput("Choose a fish.")

    def commerce(request):
        calls.append(request.url.path)
        if request.url.path == "/v1/assistant-tools/shopper":
            assert request.method == "POST"
            assert json.loads(request.content)["name"] == "search_products"
            return httpx.Response(200, json={"products": []})
        assert request.method == "GET"
        assert request.url.path == "/v1/assistant-tools/delivery"
        return httpx.Response(
            200,
            json={
                "configured": configured,
                "deliverable": not configured,
                "area_id": None,
            },
        )

    monkeypatch.setattr(language_gate, "resolve", resolve)
    monkeypatch.setattr(
        "app.commerce_action_engine.actions.shopping.cart.execute_cart", execute
    )
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={
                **headers(),
                "x-commerce-catalog-token": "catalog-token",
                **(
                    {"x-delivery-latitude": "30", "x-delivery-longitude": "31"}
                    if selected
                    else {}
                ),
            },
            json={"request_id": request_id, "message": "add fish to cart"},
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert not any(event["type"] == "error" for event in events)
    assert any(event["type"] == "done" for event in events)
    assert any(event.get("code") == "area_unavailable" for event in events) is required
    assert ("cart_action" in calls) is not required
