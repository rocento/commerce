"""Unsupported interpretations cannot execute even when they carry forged actions."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity  # noqa: F401

from app.commerce_action_engine.execution.language import gate
from app.main import create_app


@pytest.mark.parametrize("shopping_mode", [None, "shop", "optimize", "buy_again"])
def test_unsupported_status_blocks_all_execution(identity, monkeypatch, shopping_mode):  # noqa: F811
    config, request_id, headers = identity

    async def resolve(url, text):
        return gate.Resolution(
            status="UNSUPPORTED",
            intent="ADD_TO_CART",
            confidence=1,
            message="Gift cards are not supported. No changes have been made.",
            reason="unsupported_capability",
            unsupportedIntents=["APPLY_GIFT_CARD"],
            operations=["ADD_ITEM"],
            requestType="COMPOUND",
        )

    def forbidden(request):
        raise AssertionError(f"Unsupported request called {request.url}")

    monkeypatch.setattr(gate, "resolve", resolve)
    body = {"request_id": request_id, "message": "add apples and apply gift card"}
    if shopping_mode:
        body.update(shopping_mode=shopping_mode, conversation_id=request_id)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(forbidden))
    ) as client:
        response = client.post("/v1/chat", headers=headers(), json=body)
    assert response.status_code == 200
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert events[-1]["type"] == "done"
    assert not any(
        event["type"] in {"error", "content.blocks", "card.order"} for event in events
    )
    assert "Gift cards are not supported" in response.text
    assert not any(event.get("clarification") for event in events)
