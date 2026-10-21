"""Versioned gold invariants over the actual shopping/runtime pipeline."""

import asyncio
import json
import re
from pathlib import Path

import pytest
from test_runtime import FakeProvider, agent, final, principal
from test_shopping import product

from app.commerce_action_engine.contracts import AssistantBlock
from app.commerce_action_engine.execution.agents import AgentCatalog
from app.commerce_resolution_engine.contracts import Message
from app.commerce_resolution_engine.runtime import AgentRuntime
from evals.support import run_shopping

GOLD = json.loads((Path(__file__).parents[1] / "evals/commerce-gold.json").read_text())
CATALOG = {row["number"]: product(**row) for row in GOLD["catalog"]}


@pytest.mark.parametrize("case", GOLD["cases"], ids=lambda case: case["id"])
def test_gold_discovery(case):
    answer, calls, _ = asyncio.run(
        run_shopping(
            case["message"], case["plan"], [CATALOG[i] for i in case["catalog"]]
        )
    )
    expected = [CATALOG[i] for i in case["ids"]]
    actual_routes = re.findall(r"/products/[0-9a-f-]{36}", answer.text)
    assert actual_routes == [p["route"] for p in expected]
    assert [call["name"] for call in calls] == case["tools"]
    assert case["text"] in answer.text
    for fact in case.get("verified", []):
        assert fact in answer.text
    for p in expected:
        assert f"{p['price']} {p['currency']}" in answer.text
    for block in answer.blocks:
        AssistantBlock.model_validate_json(block.model_dump_json())
        for card in block.products or ():
            seed = next(p for p in expected if p["id"] == str(card.id))
            assert card.route == seed["route"]
            assert card.price == seed["price"] and card.currency == seed["currency"]
        for source in block.sources or ():
            assert str(source.product_id) in {p["id"] for p in expected}
    assert "DO NOT DISPLAY MODEL PROSE" not in answer.text


def test_gold_followup_uses_bounded_history_and_current_user_message():
    async def run():
        provider = FakeProvider(
            [final("Please provide a product link to compare current facts.")]
        )
        history = tuple(
            Message(role, f"turn {i} " + "x" * 2000)
            for i in range(10)
            for role in ("user", "assistant")
        )
        runtime = AgentRuntime(AgentCatalog((agent(),)), {"test": provider})
        events = [
            event
            async for event in runtime.stream(
                agent_id="shopper",
                principal=principal(),
                message="What about a cheaper one?",
                history=history,
            )
        ]
        request = provider.requests[0]
        assert len(request.messages) == 7
        assert sum(len(m.text) for m in request.messages[:-1]) == 6000
        assert request.messages[0].text.startswith("turn 7 ")
        assert request.messages[-1].text == "What about a cheaper one?"
        assert events[-1].answer.tool_calls == 0
        assert "product link" in events[-1].answer.text

    asyncio.run(run())


def test_gold_comparison_missing_facts_and_order():
    async def run():
        first = product(price="89", in_stock=None)
        second = product(2, price="109", attributes=[])
        answer, calls, _ = await run_shopping(
            f"Compare {second['route']} {first['route']}",
            {"presentation": "compare"},
            [first, second],
        )
        assert [c["name"] for c in calls] == ["get_catalog_schema", "compare_products"]
        block = answer.blocks[0]
        assert [str(p.id) for p in block.products] == [second["id"], first["id"]]
        rows = {row.label: row.values for row in block.rows}
        assert rows["Current price"] == ["109 USD", "89 USD"]
        assert rows["size"] == ["Not provided", "42"]
        assert rows["Availability"] == ["In stock", "Availability unknown"]
        AssistantBlock.model_validate_json(block.model_dump_json())

    asyncio.run(run())


def test_gold_preference_ranking_is_grounded():
    async def run():
        leather = product(
            price="99", attributes=[{"name": "material", "value": '"leather"'}]
        )
        cheap = product(2, price="79", attributes=[])
        answer, calls, _ = await run_shopping(
            "shoes, preferably leather",
            {"preferences": [{"name": "material", "value": "leather"}]},
            [cheap, leather],
        )
        assert answer.text.index(leather["route"]) < answer.text.index(cheap["route"])
        assert "Preference matches: material=leather" in answer.text
        assert [c["name"] for c in calls] == ["get_catalog_schema", "search_products"]

    asyncio.run(run())


def test_gold_followup_refreshes_reference_price():
    async def run():
        reference = product(9, price="80")
        cheaper = product(price="79")
        stale = product(2, price="90")
        answer, calls, model_requests = await run_shopping(
            f"similar but cheaper than {reference['route']}",
            {"cheaper": True},
            [stale, cheaper],
            reference,
            history=(
                Message("assistant", f"Previously {reference['route']} was 100 USD"),
            ),
        )
        assert model_requests[0].messages[0].text.endswith("100 USD")
        assert [c["name"] for c in calls] == [
            "get_catalog_schema",
            "get_product",
            "search_products",
        ]
        assert calls[-1]["arguments"]["max_price"] == "80"
        assert cheaper["route"] in answer.text and stale["route"] not in answer.text

    asyncio.run(run())
