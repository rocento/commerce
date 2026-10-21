import asyncio
import json

import httpx
import pytest
from interpretation_helpers import standard_route

from app.commerce_action_engine.actions.shopping.reorder import (
    ReorderRejected,
    ReorderUncertain,
)
from app.commerce_action_engine.adapters.reorder import execute
from app.commerce_action_engine.execution.language.gate import Resolution


def resolved(**updates):
    return Resolution.model_validate(
        {
            "status": "RESOLVED",
            "intent": "REORDER",
            "confidence": 0.993,
            "message": "Please confirm",
            "requiresConfirmation": True,
            "entities": {"order_reference": "5"},
            **updates,
        }
    )


def test_reorder_intent_routes_to_review():
    assert standard_route(resolved()) == "reorder"


def receipt():
    return {
        "id": "00000000-0000-0000-0000-000000000006",
        "number": 6,
        "status": "placed",
        "subtotal": "10",
        "discount_amount": "0",
        "tax_amount": "0",
        "delivery_fee": "3",
        "total": "13",
        "currency": "USD",
        "cancellation_available": True,
        "shipments": [],
    }


def test_fixed_scoped_api_returns_only_verified_receipt():
    requests = []

    def handler(request):
        requests.append(request)
        assert request.url.path == "/v1/assistant-tools/reorder"
        assert request.headers["authorization"] == "Bearer signed-capability"
        assert json.loads(request.content) == {"order_number": 5}
        return httpx.Response(200, json=receipt())

    async def run():
        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(handler)
        ) as client:
            return await execute(client, "signed-capability", 5)

    assert asyncio.run(run()).number == 6
    assert len(requests) == 1


@pytest.mark.parametrize(
    "status,body,error",
    [
        (400, {"code": "REORDER_PRICE_CHANGED"}, ReorderRejected),
        (404, {}, ReorderRejected),
        (403, {}, ReorderRejected),
        (500, {}, ReorderUncertain),
        (200, {"number": 6}, ReorderUncertain),
    ],
)
def test_rejected_or_uncertain_never_claim_success(status, body, error):
    async def run():
        async with httpx.AsyncClient(
            base_url="http://commerce",
            transport=httpx.MockTransport(lambda r: httpx.Response(status, json=body)),
        ) as client:
            return await execute(client, "signed-capability", 5)

    with pytest.raises(error):
        asyncio.run(run())
