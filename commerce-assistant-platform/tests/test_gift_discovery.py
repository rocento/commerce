"""Gift discovery uses each merchant catalog without inventing recipient suitability."""

import asyncio
import json

import httpx
import pytest
from test_catalog_schema import catalog_schema
from test_shopping import TENANT, WHO, interpreted, product

from app.commerce_action_engine.application.catalog import registry
from app.commerce_action_engine.application.responses import finish
from app.commerce_action_engine.application.shopping import shopping_answer
from app.commerce_action_engine.execution.agents import default_agents
from app.commerce_action_engine.execution.language.gate import Resolution
from app.commerce_action_engine.execution.language.shopping_reply import (
    resolve_shopping_reply,
)


@pytest.mark.parametrize(
    "industry,name",
    [
        ("jewelry", "Silver pendant"),
        ("electronics", "Headphones"),
        ("grocery", "Chocolate box"),
        ("pharmacy", "Skincare set"),
    ],
)
@pytest.mark.parametrize("reply", ["Show options", "under 50 USD"])
@pytest.mark.parametrize("choose_category", [False, True])
def test_gift_budget_and_show_options_across_demos(
    industry, name, reply, choose_category
):
    async def run():
        schema = catalog_schema(industry, [])
        if choose_category:
            from uuid import UUID

            schema["categories"] = [
                {
                    "id": str(UUID(int=2)),
                    "name": "Gift selections",
                    "sellable_count": 2,
                },
                {
                    "id": str(UUID(int=3)),
                    "name": "Other selections",
                    "sellable_count": 2,
                },
            ]
        calls = []

        class NoModel:
            async def generate(self, request):
                raise AssertionError("Gift request must not need a model fallback")

        def handler(request):
            body = json.loads(request.content)
            calls.append(body)
            if body["name"] == "get_catalog_schema":
                return httpx.Response(
                    200,
                    json={"products": [], "category": None, "catalog_schema": schema},
                )
            assert body["name"] == "search_products"
            assert body["arguments"]["query"] == "*"
            return httpx.Response(
                200,
                json={
                    "category": None,
                    "products": [
                        product(1, name=name, price="30", attributes=[]),
                        product(2, name="Expensive " + name, price="90", attributes=[]),
                    ],
                    "catalog_profile": {
                        "revision": schema["version"],
                        "scope": "current_sellable_category",
                        "complete": True,
                        "candidate_count": 2,
                        "matched_count": 2,
                        "facets_complete": True,
                        "facets": [],
                        "prices": [
                            {"currency": "USD", "count": 2, "min": "30", "max": "90"}
                        ],
                    },
                },
            )

        source = interpreted(
            Resolution(
                status="RESOLVED",
                intent="PRODUCT_SEARCH",
                confidence=1.0,
                message="",
                entities={
                    "productText": "products",
                    "giftContext": {
                        "core_text": "find products",
                        "recipient": "my son",
                        "occasion": "wedding",
                    },
                },
            )
        )
        async with httpx.AsyncClient(
            base_url="http://assistant-tools:8081",
            transport=httpx.MockTransport(handler),
        ) as client:
            tools = {
                t.definition.name: t for t in registry(client, "catalog-token", WHO, {})
            }
            args = (
                "I need a gift for my son",
                NoModel(),
                default_agents(TENANT).load(TENANT, "shopper"),
                WHO,
                tools,
            )
            first = await shopping_answer(
                *args,
                interpretation=source,
                grounded_intent=True,
                commerce_meaning=True,
                commerce_planning=True,
            )
            question = first.pending_shopping
            if choose_category:
                assert question and question.field == "gift_category"
                category_frame = resolve_shopping_reply(
                    question, "Gift selections"
                ).frame
                first = await shopping_answer(
                    *args,
                    interpretation=source,
                    grounded_intent=True,
                    commerce_meaning=True,
                    commerce_planning=True,
                    shopping_resume=category_frame,
                    shopping_resume_revision=schema["version"],
                    shopping_resume_question=question,
                )
                question = first.pending_shopping
            assert (
                question
                and question.optional
                and "budget for the gift" in question.question
            )
            resumed = resolve_shopping_reply(question, reply).frame
            assert resumed and resumed.gift_context.recipient == "my son"
            answer = await shopping_answer(
                *args,
                interpretation=source,
                grounded_intent=True,
                commerce_meaning=True,
                commerce_planning=True,
                shopping_resume=resumed,
                shopping_resume_revision=schema["version"],
                shopping_resume_question=question,
            )
            assert answer.pending_shopping is None
            assert name in answer.text and "Gift ideas" in answer.text
            assert "bounded candidate" not in answer.text
            assert any(b.products for b in answer.blocks)
            if reply != "Show options":
                assert "Expensive" not in answer.text

    asyncio.run(run())


def test_empty_response_has_an_explanation_not_only_price_disclaimer():
    blocks = finish([])
    assert "couldn’t find matching products" in blocks[0].text
    assert not any("Tax and delivery" in (b.text or "") for b in blocks)


def test_gift_category_options_come_from_current_store_and_keep_budget():
    from uuid import UUID

    from app.commerce_action_engine.actions.catalog import CatalogSchema
    from app.commerce_action_engine.actions.shopping.contracts import ShoppingIntent
    from app.commerce_action_engine.actions.shopping.grounding import plan_clarification

    schema = CatalogSchema.model_validate(
        {
            **catalog_schema("unseen-industry", []),
            "categories": [
                {
                    "id": str(UUID(int=1)),
                    "name": "Merchant category A",
                    "sellable_count": 4,
                },
                {
                    "id": str(UUID(int=2)),
                    "name": "Merchant category B",
                    "sellable_count": 2,
                },
                {"id": str(UUID(int=3)), "name": "Empty category", "sellable_count": 0},
            ],
        }
    )
    frame = ShoppingIntent(
        shopping=True,
        query="*",
        max_price="50",
        currency="USD",
        gift_context={"core_text": "find products under $50", "recipient": "my son"},
    )
    question = plan_clarification(frame, schema, None)
    assert question and [c.label for c in question.choices] == [
        "Merchant category A",
        "Merchant category B",
    ]
    selected = resolve_shopping_reply(question, "Merchant category B").frame
    assert selected.category_id == str(UUID(int=2)) and selected.max_price == "50"
    assert selected.gift_context.recipient == "my son"
    assert resolve_shopping_reply(question, "Show options").frame.discovery_refined
    assert plan_clarification(selected, schema, None) is None


def test_gift_occasion_is_a_verified_preference_not_a_required_filter():
    from test_catalog_schema import schema_attribute

    from app.commerce_action_engine.actions.catalog import CatalogSchema
    from app.commerce_action_engine.actions.shopping.contracts import ShoppingIntent
    from app.commerce_action_engine.actions.shopping.gifts import gift_preferences

    schema = CatalogSchema.model_validate(
        catalog_schema(
            "jewelry",
            [
                schema_attribute(
                    "occasion",
                    options=["wedding", "birthday"],
                    semantic_role="intended_use",
                )
            ],
        )
    )
    frame = ShoppingIntent(
        shopping=True,
        query="*",
        gift_context={
            "core_text": "find products",
            "occasion": "wedding",
            "recipient": "my son",
        },
    )
    gift_preferences(frame, schema)
    assert not frame.attributes and frame.intended_use is None
    assert [(c.name, c.value) for c in frame.preferences] == [("occasion", "wedding")]
    gift_preferences(frame, schema)
    assert len(frame.preferences) == 1
    assert all(c.name not in {"age", "gender"} for c in frame.preferences)
