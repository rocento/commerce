"""Ordinal rejection binds actual displayed products and retains the shopper's search."""

import asyncio

import pytest
from test_enterprise_contracts import context as context  # noqa: PLC0414
from test_language_fallback import resolved
from test_shopping import product, scenario
from test_shopping_context import context as shopping_context
from test_shopping_context import laptop_schema
from test_shopping_sentence_context import (
    published_rules as published_rules,  # noqa: PLC0414
)

from app.commerce_action_engine.application.followups import (
    resolve_recommendation_followup,
)
from app.commerce_action_engine.application.interpretation import (
    interpret_resolution,
    shopping_plan,
)
from app.commerce_action_engine.execution.language import gate
from app.commerce_resolution_engine.contracts import Message

ORIGINAL = "find laptop for university assignments up to $800"
REJECT = "I do not like the first suggestion. What is another option?"
PRODUCTS = [
    product(
        i,
        name=f"Study Laptop {i}",
        category="Laptop",
        price=str(600 + i),
        attributes=[],
    )
    for i in (1, 2, 3)
]


def original_resolution():
    return resolved(
        intent="PRODUCT_SEARCH",
        entities={
            "productText": "laptop",
            "category": "laptop",
            "price": {"operator": "<=", "value": 800, "currency": "USD"},
            "shoppingContext": shopping_context(
                ORIGINAL,
                (
                    "intended_use",
                    "university assignments",
                    "for university assignments",
                ),
            ),
        },
    )


async def rejection(history, context, monkeypatch):
    async def resolve(url, text, **kwargs):
        assert text == ORIGINAL
        return original_resolution()

    monkeypatch.setattr(gate, "resolve", resolve)
    initial = interpret_resolution(
        resolved(
            intent="PRODUCT_RECOMMEND",
            entities={
                "productText": "*",
                "recommendationFollowup": "different",
                "recommendationReference": "FIRST",
            },
        ),
        context,
    )
    return await resolve_recommendation_followup(
        "engine", REJECT, history, initial, context=context
    )


def test_first_rejection_excludes_only_the_actual_first_displayed_option(
    context, monkeypatch, published_rules
):
    history = [
        Message("user", ORIGINAL),
        Message("assistant", " ".join(p["route"] for p in PRODUCTS)),
    ]
    replay = asyncio.run(rejection(history, context, monkeypatch))
    result = replay.interpretation.result
    assert result.entities["excludedProducts"] == [PRODUCTS[0]["id"]]
    assert result.entities["cheaperReferences"] == []
    plan = shopping_plan(result, replay.message)
    assert plan.max_price == "800" and plan.min_price is None
    assert plan.shopping_context.relations[0].value == "university assignments"
    answer, calls = asyncio.run(
        scenario(
            replay.message,
            {},
            PRODUCTS,
            interpretation=result,
            catalog_schema_override=laptop_schema(),
        )
    )
    cards = [p for block in answer.blocks for p in block.products or []]
    assert {str(p.id) for p in cards} == {PRODUCTS[1]["id"], PRODUCTS[2]["id"]}
    assert PRODUCTS[0]["route"] not in answer.text
    assert any(
        call["arguments"].get("excluded_product_ids") == [PRODUCTS[0]["id"]]
        for call in calls
    )


def test_repeated_rejection_uses_latest_first_and_does_not_cycle_back(
    context, monkeypatch, published_rules
):
    history = [
        Message("user", ORIGINAL),
        Message("assistant", " ".join(p["route"] for p in PRODUCTS)),
        Message("user", REJECT),
        Message("assistant", " ".join(p["route"] for p in PRODUCTS[1:])),
    ]
    replay = asyncio.run(rejection(history, context, monkeypatch))
    assert replay.interpretation.result.entities["excludedProducts"] == [
        PRODUCTS[0]["id"],
        PRODUCTS[1]["id"],
    ]
    answer, _ = asyncio.run(
        scenario(
            replay.message,
            {},
            PRODUCTS,
            interpretation=replay.interpretation.result,
            catalog_schema_override=laptop_schema(),
        )
    )
    assert [str(p.id) for block in answer.blocks for p in block.products or []] == [
        PRODUCTS[2]["id"]
    ]


@pytest.mark.parametrize("earlier", [False, True])
def test_no_latest_product_identity_asks_targeted_question_without_repeating_a_product(
    context, monkeypatch, published_rules, earlier
):
    history = [Message("user", ORIGINAL)]
    if earlier:
        history += [Message("assistant", PRODUCTS[0]["route"]), Message("user", REJECT)]
    history += [Message("assistant", "I could not find a matching product.")]
    replay = asyncio.run(rejection(history, context, monkeypatch))
    result = replay.interpretation.result
    assert result.status == "NEEDS_CONTEXT"
    assert "Which product name or link" in result.message
    assert "laptop for university assignments" in result.message
    assert "maximum budget of 800 USD" in result.message
    assert not result.entities.get("excludedProducts")
    assert "/products/" not in result.message


def test_rejection_without_history_never_invents_a_product(
    context, monkeypatch, published_rules
):
    replay = asyncio.run(rejection([], context, monkeypatch))
    result = replay.interpretation.result
    assert result.status == "NEEDS_CONTEXT"
    assert "do not have a verified first suggestion" in result.message
    assert "product name or link" in result.message
    assert not result.entities.get("excludedProducts")


@pytest.mark.parametrize(
    "text",
    [
        '"' + REJECT + '"',
        "'" + REJECT + "'",
        REJECT + "\n",
        REJECT + "🙂",
        REJECT.replace(".", ";"),
        ": " + REJECT,
        REJECT + " " * 501,
    ],
)
def test_history_rejection_classification_keeps_the_same_source_bounds_as_language(
    text, published_rules
):
    from app.commerce_action_engine.actions.shopping.context import (
        recommendation_reference,
    )

    assert recommendation_reference(text) is None
    assert recommendation_reference(REJECT) == "FIRST"
