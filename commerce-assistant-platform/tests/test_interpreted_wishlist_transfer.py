"""Standard wishlist-transfer inputs retain verified writes and live admission."""

import json
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_language_fallback import install_provider, proposal, unknown
from test_shopping import product
from test_wishlist_transfer import SelectionTools, Tools, transfer_outcomes

from app.commerce_action_engine.application.handlers import wishlist_transfer
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.language import gate
from app.commerce_resolution_engine.admission import require_permit
from app.main import create_app

INTENT = "CART_MOVE_FROM_WISHLIST"


def events_from(response):
    assert response.status_code == 200
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert events[-1]["type"] == "done"
    assert [event["sequence"] for event in events] == list(range(len(events)))
    return events


@pytest.mark.parametrize("after_proposal", [False, True])
@pytest.mark.parametrize("selection", [None, "ALL_SAVED", "RANDOM_SAVED"])
def test_standard_transfer_preserves_verified_writes(
    identity, monkeypatch, after_proposal, selection
):
    config, request_id, headers = identity
    message = "move banana from wishlist to cart"
    entities = {"sourceCollection": "wishlist", "destination": "cart"}
    if selection:
        entities["selection"] = selection
        message = (
            f"move {'all' if selection == 'ALL_SAVED' else 'any'} from wishlist to cart"
        )
    else:
        entities["productText"] = "banana"
    provider = install_provider(monkeypatch, proposal(INTENT, message))
    tools = SelectionTools(count=3) if selection else Tools()
    attempts, received, calls = [], [], []
    original = wishlist_transfer.wishlist_transfer_events

    async def observe(*, request, **kwargs):
        assert isinstance(request, InterpretedRequest)
        assert request.request_id == request_id
        assert request.legacy_intent == INTENT
        assert request.primary_intent == "ADD_TO_CART"
        assert request.entities == entities
        with pytest.raises(PermissionError):
            require_permit(UUID(request_id))
        received.append(request)
        async for event in original(request=request, **kwargs):
            yield event

    async def resolve(url, text):
        attempts.append(text)
        if after_proposal and len(attempts) == 1:
            return unknown()
        return gate.Resolution(
            status="RESOLVED",
            intent=INTENT,
            primaryIntent="ADD_TO_CART",
            confidence=0.99,
            message="Understood.",
            entities=entities,
        )

    async def commerce(request):
        path = request.url.path
        calls.append((request.method, path))
        if request.method == "GET" and path == "/v1/assistant-tools/wishlist":
            assert request.headers["authorization"] == "Bearer read"
            ids = tools.ids if selection else [tools.product_id]
            return httpx.Response(200, json=[str(value) for value in ids])
        if (
            request.method == "POST"
            and path == "/v1/assistant-tools/cart/wishlist-transfer"
        ):
            assert request.headers["authorization"] == "Bearer transfer"
            receipt = await tools.transfer_wishlist_to_cart(
                [UUID(value) for value in json.loads(request.content)["product_ids"]]
            )
            return httpx.Response(200, json=receipt.model_dump(mode="json"))
        if request.method == "POST" and path == "/v1/assistant-tools/shopper":
            assert request.headers["authorization"] == "Bearer catalog"
            assert json.loads(request.content) == {
                "name": "search_products",
                "arguments": {"query": "banana"},
            }
            return httpx.Response(
                200,
                json={
                    "products": [product(id=str(tools.product_id), name="Banana")],
                    "category": None,
                },
            )
        if request.method == "POST" and path == "/v1/assistant-tools/cart":
            assert request.headers["authorization"] == "Bearer add"
            cart = await tools.change_cart(json.loads(request.content))
            return httpx.Response(200, json=cart.model_dump(mode="json"))
        if request.method == "DELETE" and path == "/v1/assistant-tools/wishlist":
            assert request.headers["authorization"] == "Bearer remove"
            await tools.remove_wishlist_item(
                UUID(json.loads(request.content)["product_id"])
            )
            return httpx.Response(204)
        pytest.fail(f"Unexpected commerce call: {request.method} {path}")

    monkeypatch.setattr(gate, "resolve", resolve)
    monkeypatch.setattr(wishlist_transfer, "wishlist_transfer_events", observe)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={
                **headers(),
                "x-commerce-wishlist-token": "read",
                "x-commerce-catalog-token": "catalog",
                "x-commerce-cart-write-token": "add",
                "x-commerce-wishlist-write-token": "remove",
                "x-commerce-wishlist-cart-transfer-token": "transfer",
            },
            json={"request_id": request_id, "message": message},
        )
    events = events_from(response)
    assert not any(event["type"] == "error" for event in events)
    count = 3 if selection == "ALL_SAVED" else 1
    outcomes = transfer_outcomes(events)
    assert len(outcomes) == count
    assert all(item["status"] == "transferred" for item in outcomes)
    assert calls == [("GET", "/v1/assistant-tools/wishlist")] + (
        [("POST", "/v1/assistant-tools/cart/wishlist-transfer")]
        if selection
        else [
            ("POST", "/v1/assistant-tools/shopper"),
            ("POST", "/v1/assistant-tools/cart"),
            ("DELETE", "/v1/assistant-tools/wishlist"),
        ]
    )
    assert len(received) == 1
    assert len(provider.requests) == int(after_proposal)
    assert len(attempts) == 1 + int(after_proposal)
    assert provider.closed
    assert not hasattr(gate, "current")


@pytest.mark.parametrize("after_proposal", [False, True])
@pytest.mark.parametrize("case", ["invalid", "guest", "no_capability", "denied"])
def test_transfer_cannot_bypass_interpretation_or_commerce_authority(
    identity, monkeypatch, after_proposal, case
):
    config, request_id, headers = identity
    message = "move all from wishlist to cart"
    provider = install_provider(monkeypatch, proposal(INTENT, message))
    attempts, calls = [], []

    async def resolve(url, text):
        attempts.append(text)
        if after_proposal and len(attempts) == 1:
            return unknown()
        return gate.Resolution(
            status="RESOLVED",
            intent=INTENT,
            confidence=0.99,
            message="",
            entities={
                "sourceCollection": "wishlist",
                "destination": "cart",
                "selection": "ALL_SAVED",
                **({"items": "invalid"} if case == "invalid" else {}),
            },
        )

    def commerce(request):
        assert case == "denied", "Blocked request reached commerce"
        assert (
            request.method == "GET"
            and request.url.path == "/v1/assistant-tools/wishlist"
        )
        calls.append(request.url.path)
        return httpx.Response(403, json={})

    monkeypatch.setattr(gate, "resolve", resolve)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={
                **headers(**({"sub": None, "sid": None} if case == "guest" else {})),
                **(
                    {}
                    if case == "no_capability"
                    else {"x-commerce-wishlist-token": "read"}
                ),
                "x-commerce-wishlist-cart-transfer-token": "transfer",
            },
            json={"request_id": request_id, "message": message},
        )
    events = events_from(response)
    assert not transfer_outcomes(events)
    assert calls == (["/v1/assistant-tools/wishlist"] if case == "denied" else [])
    assert len(provider.requests) == int(after_proposal)
    assert len(attempts) == 1 + int(after_proposal)
    assert provider.closed
