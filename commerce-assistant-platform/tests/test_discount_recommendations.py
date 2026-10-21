"""Real language interpretation, authorized promotion read and discounted cards."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient
from interpretation_helpers import standard_route
from test_assistant import identity as identity  # noqa: PLC0414 -- pytest fixture
from test_bestseller_periods import interpret
from test_shopping import product

from app.commerce_action_engine.execution.language import gate as language_gate
from app.main import create_app


@pytest.mark.parametrize("empty", [False, True])
@pytest.mark.parametrize("limit", [50, None])
def test_discount_recommendations_sse(identity, monkeypatch, empty, limit):
    message = "Recommend products with the best discounts today"
    resolution = interpret(message)
    assert standard_route(resolution) == "discounts"

    async def resolve(url, text):
        return resolution

    monkeypatch.setattr(language_gate, "resolve", resolve)
    requests = []

    def commerce(request):
        requests.append(request)
        assert request.headers["authorization"] == "Bearer catalog-capability"
        assert json.loads(request.content) == {
            "name": "get_discount_recommendations",
            "arguments": {},
        }
        p = product(1, name="Tea", price="10")
        return httpx.Response(
            200,
            json={
                "offers": []
                if empty
                else [
                    {
                        "product": p,
                        "offer": {
                            "product_id": p["id"],
                            "currency": p["currency"],
                            "original_price": "10",
                            "discounted_price": "8",
                            "savings": "2",
                            "discount_percent": "20",
                        },
                    }
                ],
                "candidate_limit": limit,
                **({"scope": "all_eligible_catalog_products"} if limit is None else {}),
                "metric": "catalog_discount_percent",
                "quantity": 1,
            },
        )

    config, request_id, headers = identity
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**headers(), "x-commerce-catalog-token": "catalog-capability"},
            json={"request_id": request_id, "message": message},
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert not any(e["type"] == "error" for e in events), response.text
    assert len(requests) == 1
    assert (
        "across all eligible catalog products"
        if limit is None
        else "50 checked products"
    ) in response.text
    if empty:
        assert "no eligible catalog discounts" in response.text
        assert not any(e["type"] == "content.blocks" for e in events)
    else:
        block = next(e for e in events if e["type"] == "content.blocks")["blocks"][0]
        assert set(block) == {"kind", "title", "products", "sources"}
        cards = block["products"]
        assert cards[0]["price"] == "8"
        assert cards[0]["original_price"] == "10"
        assert "Original price: 10" in response.text
        assert "20.00%" in response.text


@pytest.mark.parametrize(
    "field,value",
    [
        ("discounted_price", "7"),
        ("savings", "0"),
        ("discount_percent", "95"),
        ("currency", "EUR"),
        ("original_price", "11"),
    ],
)
def test_inconsistent_promotion_evidence_is_rejected(field, value):
    from pydantic import ValidationError

    from app.commerce_action_engine.actions.catalog.discounts import DiscountProduct

    p = product(1, price="10")
    offer = {
        "product_id": p["id"],
        "currency": p["currency"],
        "original_price": "10",
        "discounted_price": "8",
        "savings": "2",
        "discount_percent": "20",
    }
    offer[field] = value
    with pytest.raises(ValidationError):
        DiscountProduct.model_validate({"product": p, "offer": offer})
