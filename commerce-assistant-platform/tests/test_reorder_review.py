import asyncio
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from interpretation_helpers import standard_route
from test_assistant import identity as identity  # noqa: PLC0414
from test_bestseller_periods import interpret
from test_cart_actions import interpreted
from test_reorder import receipt, resolved

from app.commerce_action_engine.adapters.commerce import CommerceTools
from app.commerce_action_engine.application.handlers.reorder import reorder_events
from app.commerce_action_engine.contracts import AssistantOrder
from app.commerce_action_engine.execution.language import gate as language_gate
from app.main import create_app


@pytest.mark.parametrize(
    "message",
    [
        "pls reorder #5",
        "reorder 5",
        "I need order same to number 5",
        "repeat order number 5",
        "buy again order 5",
    ],
)
def test_reorder_request_reads_owned_order_without_placing(
    identity, monkeypatch, message
):
    resolution = interpret(message)
    assert standard_route(resolution) == "reorder"

    async def resolve(url, text):
        return resolution

    monkeypatch.setattr(language_gate, "resolve", resolve)
    order = AssistantOrder.model_validate({**receipt(), "number": 5})
    reader = AsyncMock(return_value=order)
    monkeypatch.setattr(CommerceTools, "order_by_number", reader)
    config, request_id, headers = identity
    with TestClient(create_app(config)) as client:
        response = client.post(
            "/v1/chat",
            headers=headers(),
            json={"request_id": request_id, "message": message},
        )
    reader.assert_awaited_once_with(5)
    assert "card.order" in response.text
    assert "Choose Reorder" in response.text
    assert "no new order has been placed" in response.text
    assert "Your new order is" not in response.text


def test_guest_reorder_does_not_read_orders():
    reader = AsyncMock()

    async def run():
        return [
            e
            async for e in reorder_events(
                request=interpreted(resolved()),
                commerce_tools=lambda: reader,
                selected_id=None,
                authenticated=False,
                make_event=lambda kind, **fields: {"type": kind, **fields},
            )
        ]

    events = asyncio.run(run())
    assert events[0]["code"] == "login_required"
    reader.orders.assert_not_called()


@pytest.mark.parametrize("text", ["do not reorder #5", "never repeat order 5"])
def test_negative_reorder_never_routes_to_review(text):
    assert standard_route(interpret(text)) != "reorder"
