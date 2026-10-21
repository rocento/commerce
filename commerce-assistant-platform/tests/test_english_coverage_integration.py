"""Real packaged language crosses the Python gate and reaches scoped reads."""

import asyncio
import json
import subprocess
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from interpretation_helpers import standard_route
from test_assistant import identity as identity  # noqa: PLC0414 -- pytest fixture
from test_enterprise_contracts import context as context  # noqa: PLC0414
from test_product_facts import ring
from test_shopping import interpreted

from app.commerce_action_engine.application.followups import resolve_reply
from app.commerce_action_engine.application.interpretation import (
    interpret_resolution,
    shopping_plan,
)
from app.commerce_action_engine.execution.language import gate
from app.main import create_app

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = """
import {loadRuntime} from './commerce-assistant-platform/app/commerce_language_engine/src/runtime.ts';
import {resolve} from './commerce-assistant-platform/app/commerce_language_engine/src/engine.ts';
import {readFileSync} from 'node:fs';
const {text,context}=JSON.parse(readFileSync(0,'utf8'));
console.log(JSON.stringify(resolve(await loadRuntime(),text,context??{})));
"""


@pytest.fixture
def real_engine(monkeypatch):
    async def resolve(url, text, *, context=None):
        data = await asyncio.to_thread(
            subprocess.check_output,
            ["node", "--input-type=module", "-e", SCRIPT],
            cwd=ROOT,
            input=json.dumps({"text": text, "context": context}),
            text=True,
        )
        return gate.Resolution.model_validate(json.loads(data))

    monkeypatch.setattr(gate, "resolve", resolve)
    return resolve


@pytest.mark.parametrize(
    "original,reply,quantity",
    [
        ("add 2 or 3 rings to my cart", "3", 3),
        ("pls add two product to cart", "fish", 2),
    ],
)
def test_reply_reaches_single_item_cart_contract(
    real_engine, original, reply, quantity, context
):
    result, text = asyncio.run(
        resolve_reply("engine", original, reply, context=context)
    )
    result = result.result
    assert result.status == "RESOLVED"
    assert result.legacy_intent == "ADD_TO_CART"
    assert result.entities["quantity"] == quantity
    assert standard_route(result) == "cart_action"
    assert "items" not in result.entities
    assert text != original


@pytest.mark.parametrize("reply", ["0", "3 and checkout", "yes"])
def test_invalid_quantity_stays_pending(real_engine, reply, context):
    original = "add 2 or 3 rings to my cart"
    result, text = asyncio.run(
        resolve_reply("engine", original, reply, context=context)
    )
    result = result.result
    assert standard_route(result) == "clarify"
    assert text == original


def test_currency_preserves_both_bounds(real_engine, context):
    result, text = asyncio.run(
        resolve_reply("engine", "find rings between 50 and 100", "EGP", context=context)
    )
    result = result.result
    assert result.entities["price"] == {
        "operator": "BETWEEN",
        "min": 50,
        "max": 100,
        "currency": "EGP",
    }
    plan = shopping_plan(interpreted(result), text)
    assert plan.currency == "EGP"
    assert plan.min_price == "50" and plan.max_price == "100"


def test_refinement_replays_scoped_history(real_engine, context):
    from app.commerce_action_engine.application.interpretation import (
        resolve_search_update,
    )
    from app.commerce_resolution_engine.contracts import Message

    async def run():
        initial = await real_engine("engine", "same in silver")
        return await resolve_search_update(
            "engine",
            "same in silver",
            (Message("user", "find gold rings under $100"),),
            interpret_resolution(initial, context),
            context=context,
        )

    decision, text = asyncio.run(run())
    result = decision.result
    assert result.entities["material"] == "silver"
    assert result.entities["price"]["value"] == 100
    assert result.entities["price"]["currency"] == "USD"
    assert shopping_plan(interpreted(result), text) is not None


def test_material_question_reaches_sse(identity, real_engine):
    config, request_id, headers = identity
    product = ring()
    calls = []

    def commerce(request):
        body = json.loads(request.content)
        calls.append(body["name"])
        assert body["name"] == "get_product"
        return httpx.Response(200, json={"products": [product], "category": None})

    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**headers(), "x-commerce-catalog-token": "read"},
            json={
                "request_id": request_id,
                "message": "what material is it made of?",
                "product_id": product["id"],
            },
        )
    assert "Material: gold" in response.text
    assert "event: error" not in response.text
    assert '"response_source":"R"' in response.text
    assert calls == ["get_product"]


def test_product_fact_reply_retains_the_requested_field(real_engine, context):
    result, _text = asyncio.run(
        resolve_reply(
            "engine",
            "what material is it made of?",
            "Classic Gold Ring",
            context=context,
        )
    )
    result = result.result
    assert result.legacy_intent == "PRODUCT_MATERIAL"
    assert result.entities == {"productText": "Classic Gold Ring"}
    assert standard_route(result) == "product_fact"
