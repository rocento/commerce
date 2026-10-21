from interpretation_helpers import standard_route
from test_assistant import identity as identity  # noqa: PLC0414 -- pytest fixture
from test_enterprise_contracts import context as context  # noqa: PLC0414
from test_shopping import interpreted

from app.commerce_action_engine.actions.catalog.followups import (
    discovery_context,
    latest_products,
)
from app.commerce_action_engine.application.followups import resolve_reply
from app.commerce_action_engine.application.interpretation import shopping_plan
from app.commerce_resolution_engine.contracts import Message

A = "00000000-0000-0000-0000-000000000001"
B = "00000000-0000-0000-0000-000000000002"


def test_followups_keep_original_constraints_and_seen_products():
    history = [
        Message("user", "recommend red shoes under $100"),
        Message("assistant", f"/products/{A}"),
        Message("user", "cheaper options"),
        Message("assistant", f"/products/{B}"),
        Message("user", "something else"),
    ]
    assert discovery_context(history) == ("recommend red shoes under $100", [A, B], [A])
    assert latest_products(history) == [B]


def test_does_not_reuse_products_before_an_unrelated_turn():
    history = [
        Message("user", "recommend shoes"),
        Message("assistant", f"/products/{A}"),
        Message("user", "where is my order?"),
        Message("assistant", "Your order is placed."),
    ]
    assert discovery_context(history) == ("where is my order?", [], [])
    assert discovery_context([]) is None


def test_extra_requirements_are_not_treated_as_bare_followups():
    history = [
        Message("user", "something else without sugar"),
        Message("assistant", f"/products/{A}"),
    ]
    assert discovery_context(history)[0] == "something else without sugar"


async def real_resolve(url, text):
    from test_bestseller_periods import interpret

    return interpret(text)


def test_cheaper_category_reply_searches_and_sorts_without_model(monkeypatch, context):
    import asyncio

    from test_shopping import product, scenario

    from app.commerce_action_engine.execution.language import gate

    monkeypatch.setattr(gate, "resolve", real_resolve)
    result, message = asyncio.run(
        resolve_reply(
            "http://engine", "Show me cheaper options", "breads", context=context
        )
    )
    result = result.result
    assert message == "find cheapest breads"
    assert standard_route(result) == "search"
    assert not result.entities.get("recommendationFollowup")
    plan = shopping_plan(interpreted(result), message)
    assert plan.query == "breads"
    assert plan.sort_by == "price_asc"
    interpretation = interpreted(result)
    answer, calls = asyncio.run(
        scenario(
            message,
            {},
            [
                product(1, name="Whole wheat bread", price="4"),
                product(2, name="White bread", price="2"),
            ],
            interpretation=interpretation,
        )
    )
    cards = [p for block in answer.blocks for p in block.products or []]
    assert [p.price for p in cards] == ["2", "4"]
    assert answer.usage.input_tokens == 0
    assert calls and all("cart" not in call["name"] for call in calls)


def test_discovery_reply_preserves_budget_and_other_options(monkeypatch, context):
    import asyncio

    from app.commerce_action_engine.execution.language import gate

    monkeypatch.setattr(gate, "resolve", real_resolve)
    for original, sort in [
        ("Show me cheaper options", "price_asc"),
        ("something else", None),
    ]:
        result, message = asyncio.run(
            resolve_reply("http://engine", original, "breads under $5", context=context)
        )
        result = result.result
        assert standard_route(result) == "search"
        plan = shopping_plan(interpreted(result), message)
        assert plan is not None and not plan.clarification
        assert plan.sort_by == sort
        assert "5" in str(result.entities["price"])


def test_discovery_reply_cannot_become_a_write_or_drop_requirements(
    monkeypatch, context
):
    import asyncio

    from app.commerce_action_engine.execution.language import gate

    monkeypatch.setattr(gate, "resolve", real_resolve)
    original = "Show me cheaper options"
    for reply in [
        "add milk to cart",
        "cancel order 123",
        "breads; buy milk",
        "",
        "x" * 251,
        "breads without gluten",
    ]:
        result, message = asyncio.run(
            resolve_reply("http://engine", original, reply, context=context)
        )
        result = result.result
        assert standard_route(result) == "clarify"
        assert message == original
        assert "complete request" not in result.message


def test_missing_context_question_and_reply_complete_over_sse(identity, monkeypatch):
    import json

    import httpx
    from fastapi.testclient import TestClient
    from test_shopping import catalog_schema, product

    from app.commerce_action_engine.execution.language import gate
    from app.main import create_app

    monkeypatch.setattr(gate, "resolve", real_resolve)
    calls = []
    import importlib

    class NoModel:
        async def generate(self, request):
            raise AssertionError("Discovery clarification must not call a model")

        async def aclose(self):
            pass

    monkeypatch.setattr(
        importlib.import_module("app.commerce_action_engine.application.bootstrap"),
        "build_provider",
        lambda _: NoModel(),
    )

    def commerce(request):
        body = json.loads(request.content)
        calls.append(body)
        assert request.url.path == "/v1/assistant-tools/shopper"
        assert request.headers["authorization"] == "Bearer catalog-capability"
        if body["name"] == "get_catalog_schema":
            return httpx.Response(
                200,
                json={
                    "products": [],
                    "category": None,
                    "catalog_schema": catalog_schema("general", []),
                },
            )
        assert body["name"] in {"search_products", "get_product"}
        return httpx.Response(
            200,
            json={
                "products": [product(1, name="White bread", price="2")],
                "category": None,
            },
        )

    config, request_id, headers = identity
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        first = client.post(
            "/v1/chat",
            headers=headers(),
            json={"request_id": request_id, "message": "Show me cheaper options"},
        )
        first_events = [
            json.loads(line[6:])
            for line in first.text.splitlines()
            if line.startswith("data: ")
        ]
        clarification = next(
            e["clarification"] for e in first_events if e.get("clarification")
        )
        assert not calls
        response = client.post(
            "/v1/chat",
            headers={**headers(), "x-commerce-catalog-token": "catalog-capability"},
            json={
                "request_id": request_id,
                "message": "breads",
                "clarification": clarification,
            },
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert response.status_code == 200 and events[-1]["type"] == "done"
    assert not any(e.get("clarification") or e["type"] == "error" for e in events)
    assert "White bread" in response.text
    assert "Lowest-priced matches" in response.text
    assert "complete request" not in response.text
    assert calls


def test_bakery_phrasings_request_category_candidates():
    import asyncio

    for text in [
        "Recommend products in category Bakery",
        "Recommend products in Bakery",
        "Recommend Bakery",
    ]:
        result = asyncio.run(real_resolve("http://engine", text))
        plan = shopping_plan(interpreted(result), text)
        assert plan is not None and not plan.clarification
        assert plan.query == "*"
        assert plan.category == "bakery"


def test_recommendation_accepts_an_additional_category(monkeypatch):
    import asyncio

    from test_shopping import product, scenario

    result = asyncio.run(real_resolve("http://engine", "Recommend Bakery"))
    interpretation = interpreted(result)
    answer, _ = asyncio.run(
        scenario(
            "Recommend Bakery",
            {},
            [
                product(
                    name="Breakfast loaf",
                    category="Breakfast",
                    category_names=["Breakfast", "Bakery"],
                )
            ],
            interpretation=interpretation,
        )
    )
    assert [p.name for block in answer.blocks for p in block.products or []] == [
        "Breakfast loaf"
    ]
