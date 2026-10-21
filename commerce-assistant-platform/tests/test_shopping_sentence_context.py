"""Published sentence roles retain response intent without hiding requirements."""

import asyncio
import json
from copy import deepcopy
from pathlib import Path

import pytest
from test_shopping import product, scenario
from test_shopping_context import context, gate, laptop_schema

from app.commerce_action_engine.actions.catalog import Product
from app.commerce_action_engine.actions.catalog.workflow import map_discovery_request
from app.commerce_action_engine.actions.shopping.context import (
    ShoppingContextError,
    contextual_message,
    verified_context,
)
from app.commerce_action_engine.actions.shopping.contracts import ShoppingIntent
from app.commerce_action_engine.application.shopping_presentation import render

PACK = (
    Path(__file__).resolve().parents[1]
    / "app/commerce_language_engine/data/knowledge/shopping-en-v1.json"
)


@pytest.fixture
def published_rules(monkeypatch):
    rules = {
        rule["id"]: rule
        for rule in json.loads(PACK.read_text())["utteranceRules"]
        if rule["role"] != "budget_update"
    }
    monkeypatch.setattr(
        "app.commerce_action_engine.actions.shopping.context._published_sentence_rules",
        lambda: rules,
    )
    return rules


def sentence_context(message, rules, sentences, *, use="online classes"):
    meaning = context(message, *(("intended_use", use, "for " + use),) if use else ())
    meaning["sentenceRoles"] = [
        {
            "role": rules[rule]["role"],
            "ruleId": rule,
            "text": text,
            "start": message.index(text),
            "end": message.index(text) + len(text),
        }
        for rule, text in sentences
    ]
    meaning["responsePreferences"] = list(
        dict.fromkeys(
            rules[rule]["preference"]
            for rule, _ in sentences
            if "preference" in rules[rule]
        )
    )
    return meaning


@pytest.mark.parametrize(
    "prefix,suffix,rules",
    [
        (
            "This is my first time buying here. ",
            "",
            [("background.first_visit", "This is my first time buying here")],
        ),
        (
            "I am short on time. ",
            " Please give me a practical starting point.",
            [
                ("background.time_pressure", "I am short on time"),
                (
                    "response.practical_start",
                    "Please give me a practical starting point",
                ),
            ],
        ),
        (
            "I am not sure what I need. ",
            " Can you explain the tradeoffs?",
            [
                ("background.uncertain_selection", "I am not sure what I need"),
                ("response.tradeoffs", "Can you explain the tradeoffs"),
            ],
        ),
        (
            "",
            " pls be honest about what you cannot verify.",
            [("response.uncertainty", "pls be honest about what you cannot verify")],
        ),
        (
            "",
            " pls do not assume details I have not given you.",
            [
                (
                    "response.no_assumptions",
                    "pls do not assume details I have not given you",
                )
            ],
        ),
        (
            "",
            " Keep the answer short, please.",
            [("response.short", "Keep the answer short, please")],
        ),
        (
            "",
            " Explain why each suggestion fits.",
            [("response.explain_fit", "Explain why each suggestion fits")],
        ),
    ],
)
@pytest.mark.parametrize("commerce_meaning", [False, True])
def test_sentence_roles_reach_catalog_as_product_and_maximum_budget_only(
    published_rules, prefix, suffix, rules, commerce_meaning
):
    message = (
        prefix
        + "I need a laptop for online classes and my limit is $40. What should I look at?"
        + suffix
    )
    meaning = sentence_context(
        message,
        published_rules,
        rules + [("prompt.shopping_options", "What should I look at")],
    )
    interpretation = gate(
        message,
        meaning,
        category="laptop",
        price={"operator": "<=", "value": 40, "currency": "USD"},
    )
    answer, requests = asyncio.run(
        scenario(
            message,
            {},
            [
                product(
                    name="Study Laptop", category="Laptop", price="35", attributes=[]
                )
            ],
            interpretation=interpretation,
            catalog_schema_override=laptop_schema(),
            commerce_meaning=commerce_meaning,
        )
    )
    assert "Study Laptop" in answer.text
    assert "Suitability for your intended use" in answer.text
    assert requests
    assert all(
        "online classes" not in str(request["arguments"]) for request in requests
    )
    assert all(
        "keep the answer" not in str(request["arguments"]).lower()
        for request in requests
    )
    assert any(
        str(request["arguments"].get("max_price")) == "40" for request in requests
    )


def test_budget_no_match_explains_scope_without_inventing_alternatives(published_rules):
    message = "I need a laptop for online classes and my limit is $40. Keep it short."
    meaning = sentence_context(
        message, published_rules, [("response.short", "Keep it short")]
    )
    interpretation = gate(
        message,
        meaning,
        category="laptop",
        price={"operator": "<=", "value": 40, "currency": "USD"},
    )
    answer, requests = asyncio.run(
        scenario(
            message,
            {},
            [],
            interpretation=interpretation,
            catalog_schema_override=laptop_schema(),
        )
    )
    assert requests
    assert "among the products checked" in answer.text
    assert "maximum budget of 40 USD" in answer.text
    assert "cannot verify a suitable recommendation" in answer.text
    assert "change the budget or product requirements" in answer.text
    assert "too low" not in answer.text and "/products/" not in answer.text


@pytest.mark.parametrize(
    "alter",
    [
        lambda c: c["sentenceRoles"][0].update(ruleId="response.unknown"),
        lambda c: c["sentenceRoles"][0].update(role="background"),
        lambda c: c["sentenceRoles"][0].update(start=0),
        lambda c: c["sentenceRoles"].append(deepcopy(c["sentenceRoles"][0])),
        lambda c: c.update(responsePreferences=["explain_fit"]),
        lambda c: c.update(responsePreferences=["short", "short"]),
    ],
)
def test_sentence_evidence_must_match_published_rule_and_preference(
    published_rules, alter
):
    message = "find laptop for online classes. Keep it short."
    meaning = sentence_context(
        message, published_rules, [("response.short", "Keep it short")]
    )
    alter(meaning)
    assert (
        map_discovery_request(gate(message, meaning), message, ShoppingIntent) is None
    )


@pytest.mark.parametrize(
    "phrase",
    [
        "Keep it short under $20",
        "Keep it short and checkout",
        "Keep it short without nuts",
        "Keep it short $20",
        "Keep it short 😉",
        "Keep it short <",
        '"Keep it short"',
    ],
)
def test_sentence_cannot_swallow_quoted_identity_price_action_or_safety(
    published_rules, phrase
):
    message = "find laptop. " + phrase + "."
    meaning = sentence_context(
        message, published_rules, [("response.short", phrase)], use=None
    )
    with pytest.raises(ShoppingContextError):
        verified_context(meaning, message)


def test_partial_sentence_and_source_less_preference_are_rejected(published_rules):
    for message in [
        "find laptop Keep it short",
        "Keep it short with safety certification. find laptop",
    ]:
        meaning = sentence_context(
            message, published_rules, [("response.short", "Keep it short")], use=None
        )
        with pytest.raises(ShoppingContextError):
            verified_context(meaning, message)
    message = "find laptop for online classes"
    meaning = context(message, ("intended_use", "online classes", "for online classes"))
    meaning["responsePreferences"] = ["short"]
    with pytest.raises(ShoppingContextError):
        verified_context(meaning, message)


def test_verified_sentence_mask_keeps_independent_constraint(published_rules):
    message = "find laptop for online classes without nuts. Keep it short."
    meaning = sentence_context(
        message, published_rules, [("response.short", "Keep it short")]
    )
    remaining = contextual_message(verified_context(meaning, message), message)
    assert "without nuts" in remaining
    assert (
        map_discovery_request(gate(message, meaning), message, ShoppingIntent) is None
    )


@pytest.mark.parametrize(
    "phrase,rule",
    [
        ("I'm new here", "background.first_visit"),
        ("Don't assume details I have not given you", "response.no_assumptions"),
        ("Tell me what you can't verify", "response.uncertainty"),
    ],
)
def test_contractions_match_the_same_published_phrases(published_rules, phrase, rule):
    message = "find laptop. " + phrase + "."
    meaning = sentence_context(message, published_rules, [(rule, phrase)], use=None)
    assert phrase not in contextual_message(verified_context(meaning, message), message)


def test_short_reply_limits_products_but_retains_verified_fit_and_disclosures(
    published_rules,
):
    message = "find laptop for online classes. Keep it short. Explain why each suggestion fits."
    meaning = sentence_context(
        message,
        published_rules,
        [
            ("response.short", "Keep it short"),
            ("response.explain_fit", "Explain why each suggestion fits"),
        ],
    )
    plan = ShoppingIntent(
        shopping=True,
        query="laptop",
        category="Laptop",
        max_price="40",
        currency="USD",
        shopping_context=meaning,
    )
    products = [
        Product.model_validate(
            product(
                i,
                name=f"Laptop {i}",
                category="Laptop",
                price=str(i + 20),
                attributes=[],
            )
        )
        for i in range(5)
    ]
    text = render(products, plan, None)
    assert text.count("/products/") == 3
    assert text.count("Why it matches: meets your maximum budget") == 3
    assert "Tax and delivery" in text


def test_tradeoffs_compare_known_prices_without_inventing_performance(published_rules):
    message = "find laptop. Can you explain the tradeoffs?"
    meaning = sentence_context(
        message,
        published_rules,
        [("response.tradeoffs", "Can you explain the tradeoffs")],
        use=None,
    )
    plan = ShoppingIntent(shopping=True, query="laptop", shopping_context=meaning)
    products = [
        Product.model_validate(product(i, name=f"Laptop {i}", price=price))
        for i, price in [(1, "20"), (2, "35")]
    ]
    text = render(products, plan, None)
    assert "20–35 USD" in text
    assert "cannot verify tradeoffs that are absent from the catalog" in text
    assert "better performance" not in text


def test_two_option_preference_caps_text_and_cards_without_inventing_a_second(
    published_rules,
):
    message = "find laptop for working from home under $120. I would rather see two sensible options than a long list."
    meaning = sentence_context(
        message,
        published_rules,
        [
            (
                "response.two_options",
                "I would rather see two sensible options than a long list",
            )
        ],
        use="working from home",
    )
    interpretation = gate(
        message,
        meaning,
        category="laptop",
        price={"operator": "<", "value": 120, "currency": "USD"},
    )
    for count in (1, 4):
        answer, _ = asyncio.run(
            scenario(
                message,
                {},
                [
                    product(
                        i,
                        name=f"Home Laptop {i}",
                        category="Laptop",
                        price=str(90 + i),
                        attributes=[],
                    )
                    for i in range(count)
                ],
                interpretation=interpretation,
                catalog_schema_override=laptop_schema(),
            )
        )
        assert answer.text.count("/products/") == min(count, 2)
        cards = [
            card for block in answer.blocks if block.products for card in block.products
        ]
        assert len(cards) == min(count, 2)
        assert "Suitability for your intended use" in answer.text


@pytest.mark.parametrize("commerce_meaning", [False, True])
def test_one_question_uses_known_product_purpose_budget_and_never_invents_matches(
    published_rules,
    commerce_meaning,
    monkeypatch,
):
    from app.commerce_action_engine.application.shopping_flow.presentation import (
        ShoppingResponder,
    )
    from app.commerce_action_engine.execution.language.shopping_reply import (
        resolve_shopping_reply,
    )

    pending = []
    original = ShoppingResponder.build

    def capture(self, *args, **kwargs):
        if kwargs.get("pending_shopping"):
            pending.append(kwargs["pending_shopping"])
        return original(self, *args, **kwargs)

    monkeypatch.setattr(ShoppingResponder, "build", capture)
    message = (
        "I need a laptop for video editing and my limit is $75. "
        "I am confused. Please ask me just one question to help narrow this down."
    )
    meaning = sentence_context(
        message,
        published_rules,
        [
            ("background.uncertain_selection", "I am confused"),
            (
                "response.one_question",
                "Please ask me just one question to help narrow this down",
            ),
        ],
        use="video editing",
    )
    interpretation = gate(
        message,
        meaning,
        category="laptop",
        price={"operator": "<=", "value": 75, "currency": "USD"},
    )
    answer, requests = asyncio.run(
        scenario(
            message,
            {},
            [],
            interpretation=interpretation,
            catalog_schema_override=laptop_schema(),
            commerce_meaning=commerce_meaning,
        )
    )
    assert requests
    assert answer.text.count("?") == 1
    assert "laptop for video editing" in answer.text.lower()
    assert "Your current maximum is 75 USD" in answer.text
    assert "What maximum budget should I use" in answer.text
    assert "haven’t found a verified match" in answer.text
    assert "/products/" not in answer.text
    assert len(answer.blocks) == 1 and answer.blocks[0].kind == "text"
    assert (
        map_discovery_request(interpretation, message, ShoppingIntent).max_price == "75"
    )
    assert len(pending) == 1 and pending[0].field == "replacement_budget"
    assert pending[0].frame.max_price == "75"
    assert "one_question" not in pending[0].frame.shopping_context.responsePreferences
    for amount in ("50", "75", "100"):
        reply = resolve_shopping_reply(pending[0], amount)
        assert reply.frame.max_price == amount and reply.frame.currency == "USD"
        assert reply.frame.query == pending[0].frame.query
        assert (
            reply.frame.shopping_context.relations
            == pending[0].frame.shopping_context.relations
        )
        assert "one_question" not in reply.frame.shopping_context.responsePreferences
    for unsupported in (
        "yes",
        "no",
        "reading",
        "100 EUR",
        "at least $100",
        "$100 and add to cart",
    ):
        assert resolve_shopping_reply(pending[0], unsupported).frame is None


def test_explanation_with_no_matches_does_not_claim_to_have_recommended_a_product(
    published_rules,
):
    message = "find laptop for gaming under $300. Can you explain why that fits what I asked for?"
    meaning = sentence_context(
        message,
        published_rules,
        [("response.explain_fit", "Can you explain why that fits what I asked for")],
        use="gaming",
    )
    answer, requests = asyncio.run(
        scenario(
            message,
            {},
            [],
            interpretation=gate(
                message,
                meaning,
                category="laptop",
                price={"operator": "<", "value": 300, "currency": "USD"},
            ),
            catalog_schema_override=laptop_schema(),
        )
    )
    assert requests
    assert "no verified matching recommendation to explain" in answer.text
    assert "prices below 300 USD" in answer.text
    assert "/products/" not in answer.text


def test_single_question_keeps_both_known_uses_and_requests_an_answerable_budget(
    published_rules,
):
    message = (
        "find laptop for reading and video calls under $450. Ask me just one question."
    )
    meaning = sentence_context(
        message,
        published_rules,
        [("response.one_question", "Ask me just one question")],
        use="reading",
    )
    meaning["relations"] = context(
        message,
        ("intended_use", "reading", "for reading"),
        ("intended_use", "video calls", "and video calls"),
    )["relations"]
    for relation in meaning["relations"]:
        relation["ruleId"] = "for.activity"
    answer, requests = asyncio.run(
        scenario(
            message,
            {},
            [
                product(
                    name="Office Laptop", category="Laptop", price="400", attributes=[]
                )
            ],
            interpretation=gate(
                message,
                meaning,
                category="laptop",
                price={"operator": "<", "value": 450, "currency": "USD"},
            ),
            catalog_schema_override=laptop_schema(),
        )
    )
    assert requests
    assert answer.text.count("?") == 1
    assert "for reading and video calls" in answer.text
    assert "What maximum budget should I use" in answer.text
    assert "/products/" not in answer.text
    assert all(not block.products for block in answer.blocks)
    assert "current maximum is 450 USD" in answer.text
