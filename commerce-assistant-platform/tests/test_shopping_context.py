"""Contextual vocabulary must not become merchant facts or erase requirements."""

import asyncio
from copy import deepcopy
from uuid import UUID

import pytest
from test_catalog_schema import catalog_schema, schema_attribute
from test_discovery_workflow import resolved
from test_shopping import product, scenario

from app.commerce_action_engine.actions.catalog import CatalogSchema
from app.commerce_action_engine.actions.catalog.workflow import map_discovery_request
from app.commerce_action_engine.actions.shopping.context import (
    ShoppingContextError,
    _published_relationship_rules,
    contextual_message,
    ground_context,
    verified_context,
)
from app.commerce_action_engine.actions.shopping.contracts import ShoppingIntent


def context(message, *relations, core="find laptop"):
    concepts, rules = _published_relationship_rules()
    rows = []
    for role, value, text in relations:
        concept = next(
            concept
            for concept in concepts.values()
            if value in [concept["canonical"], *concept["aliases"]]
        )
        candidates = [
            rule
            for rule in rules.values()
            if rule["relation"] == role
            and rule["targetKind"] == concept["kind"]
            and all(
                concept.get("metadata", {}).get(key) == match
                for key, match in rule.get("targetMetadata", {}).items()
            )
        ]
        explicit = [rule for rule in candidates if rule["marker"] in text]
        rule = max(explicit or candidates, key=lambda rule: len(rule["marker"]))
        if text.startswith("and ") and not explicit:
            rule = next(rule for rule in candidates if rule["marker"] == "for")
        rows.append(
            {
                "relation": role,
                "value": concept["canonical"],
                "text": text,
                "start": message.index(text),
                "end": message.index(text) + len(text),
                "negated": text.startswith("not "),
                "conceptId": concept["id"],
                "ruleId": rule["id"],
            }
        )
    return {"version": 1, "coreText": core, "relations": rows}


def gate(message, meaning, **entities):
    return resolved(
        entities={"productText": "laptop", "shoppingContext": meaning, **entities}
    )


def laptop_schema(attributes=()):
    return {
        **catalog_schema("electronics", list(attributes)),
        "categories": [{"id": str(UUID(int=2)), "name": "Laptop"}],
    }


@pytest.mark.parametrize("commerce_meaning", [False, True])
def test_real_catalog_can_find_product_without_a_literal_online_classes_tag(
    commerce_meaning,
):
    message = "find laptop for my mother for online classes under $500"
    meaning = context(
        message,
        ("recipient", "mother", "for my mother"),
        ("intended_use", "online classes", "for online classes"),
    )
    interpretation = gate(
        message,
        meaning,
        category="laptop",
        price={"operator": "<", "value": 500, "currency": "USD"},
    )
    plan = map_discovery_request(interpretation, message, ShoppingIntent)
    assert plan and plan.intended_use is None and not plan.attributes
    assert plan.max_price == "500"
    answer, requests = asyncio.run(
        scenario(
            message,
            {},
            [
                product(
                    name="School Laptop", category="Laptop", price="400", attributes=[]
                )
            ],
            interpretation=interpretation,
            catalog_schema_override=laptop_schema(),
            commerce_meaning=commerce_meaning,
        )
    )
    assert "School Laptop" in answer.text
    assert "Suitability for your intended use" in answer.text
    assert requests and all(
        "online classes" not in str(call["arguments"]) for call in requests
    )
    assert all(not call["arguments"].get("attributes") for call in requests)


def test_known_use_adds_only_schema_backed_preference_and_never_a_required_tag():
    message = "find laptop for online classes"
    plan = map_discovery_request(
        gate(
            message,
            context(message, ("intended_use", "online classes", "for online classes")),
        ),
        message,
        ShoppingIntent,
    )
    schema = CatalogSchema(
        **laptop_schema(
            [
                schema_attribute(
                    "usage",
                    options=["online_classes"],
                    semantic_role="intended_use",
                    policy="semantic",
                )
            ]
        )
    )
    ground_context(plan, schema)
    assert not plan.attributes and plan.intended_use is None
    assert [(p.name, p.value) for p in plan.preferences] == [
        ("usage", "online_classes")
    ]


def test_source_negation_does_not_exclude_products_with_an_unneeded_capability():
    message = "find laptop not for gaming under $800"
    meaning = context(message, ("intended_use", "gaming", "not for gaming"))
    interpretation = gate(
        message, meaning, price={"operator": "<", "value": 800, "currency": "USD"}
    )
    plan = map_discovery_request(interpretation, message, ShoppingIntent)
    assert plan is not None and plan.shopping_context.relations[0].negated
    ground_context(plan, CatalogSchema(**laptop_schema()))
    assert not plan.attributes and not plan.preferences


@pytest.mark.parametrize(
    "role,value,phrase,field,option",
    [
        ("color", "forest green", "in forest green", "paint", "forest_green"),
        ("origin_country", "Egypt", "made in Egypt", "origin", "egypt"),
        ("audience", "woman", "for women", "audience", "women"),
    ],
)
def test_hard_relationships_require_live_fields_and_verified_product_values(
    role, value, phrase, field, option
):
    message = "find laptop " + phrase
    meaning = context(message, (role, value, phrase))
    extra = {"color": value} if role == "color" else {}
    definition = schema_attribute(field, options=[option], semantic_role=role)
    interpretation = gate(message, meaning, category="laptop", **extra)
    answer, requests = asyncio.run(
        scenario(
            message,
            {},
            [
                product(
                    name="Verified Laptop",
                    category="Laptop",
                    attributes=[{"name": field, "value": f'"{option}"'}],
                ),
                product(2, name="Unverified Laptop", category="Laptop", attributes=[]),
            ],
            interpretation=interpretation,
            catalog_schema_override=laptop_schema([definition]),
        )
    )
    assert "Verified Laptop" in answer.text and "Unverified Laptop" not in answer.text
    assert any(
        call["arguments"].get("attributes") == {field: option} for call in requests
    )


@pytest.mark.parametrize(
    "role,value,phrase",
    [
        ("origin_country", "Egypt", "made in Egypt"),
        ("audience", "women", "for women"),
        ("color", "forest green", "in forest green"),
        ("market_country", "Japan", "for Japan"),
        ("destination_country", "Egypt", "shipping to Egypt"),
    ],
)
def test_unverifiable_hard_relationships_clarify_before_retrieval(role, value, phrase):
    message = "find laptop " + phrase
    meaning = context(message, (role, value, phrase))
    answer, requests = asyncio.run(
        scenario(
            message,
            {},
            [product(name="Laptop", category="Laptop")],
            interpretation=gate(message, meaning),
            catalog_schema_override=laptop_schema(),
        )
    )
    assert "verify" in answer.text
    assert not requests


def test_context_core_cannot_delete_an_independent_safety_requirement():
    message = "find snacks for my mother without nuts"
    meaning = context(
        message, ("recipient", "mother", "for my mother"), core="find snacks"
    )
    verified = verified_context(meaning, message)
    assert "without nuts" in contextual_message(verified, message)
    assert (
        map_discovery_request(gate(message, meaning), message, ShoppingIntent) is None
    )


@pytest.mark.parametrize(
    "alter",
    [
        lambda c: c["relations"][0].update(start=0),
        lambda c: c["relations"][0].update(negated=True),
        lambda c: c["relations"].append(deepcopy(c["relations"][0])),
        lambda c: c.update(unresolved=[{"text": "missing"}]),
        lambda c: c["relations"][0].update(start=True),
    ],
)
def test_invalid_context_evidence_cannot_form_a_catalog_plan(alter):
    message = "find laptop for online classes"
    meaning = context(message, ("intended_use", "online classes", "for online classes"))
    alter(meaning)
    assert (
        map_discovery_request(gate(message, meaning), message, ShoppingIntent) is None
    )


def test_quoted_names_and_embedded_constraints_cannot_be_masked():
    for message, phrase in [
        ('find "Laptop for gaming"', "for gaming"),
        ("find laptop for school without nuts", "for school without nuts"),
        ("find laptop for school and checkout", "for school and checkout"),
    ]:
        with pytest.raises(ShoppingContextError):
            verified_context(
                context(message, ("intended_use", "gaming", phrase)), message
            )


def test_write_routes_cannot_borrow_read_only_context_authority():
    message = "add laptop for online classes"
    meaning = context(message, ("intended_use", "online classes", "for online classes"))
    source = gate(message, meaning).model_copy(update={"legacy_intent": "ADD_TO_CART"})
    assert map_discovery_request(source, message, ShoppingIntent) is None


def test_provider_invented_context_is_discarded_without_a_language_gate():
    fake = context(
        "find shoes made in Egypt", ("origin_country", "Egypt", "made in Egypt")
    )
    answer, requests = asyncio.run(
        scenario(
            "find shoes",
            {"shopping_context": fake},
            [product()],
            catalog_schema_override=catalog_schema("general", []),
        )
    )
    assert "Running shoes" in answer.text and requests
    assert "Egypt" not in answer.text


@pytest.mark.parametrize("commerce_meaning", [False, True])
@pytest.mark.parametrize("separator", [" ", ", "])
def test_coordinated_uses_preserve_both_purposes_without_hard_catalog_filters(
    commerce_meaning,
    separator,
):
    message = (
        "I need a laptop for reading"
        + separator
        + "and video calls and my limit is $450"
    )
    meaning = context(
        message,
        ("intended_use", "reading", "for reading"),
        ("intended_use", "video calls", "and video calls"),
    )
    for relation in meaning["relations"]:
        relation["ruleId"] = "for.activity"
    interpretation = gate(
        message,
        meaning,
        category="laptop",
        price={"operator": "<=", "value": 450, "currency": "USD"},
    )
    answer, requests = asyncio.run(
        scenario(
            message,
            {},
            [
                product(
                    name="Reading Laptop", category="Laptop", price="400", attributes=[]
                )
            ],
            interpretation=interpretation,
            catalog_schema_override=laptop_schema(),
            commerce_meaning=commerce_meaning,
        )
    )
    assert "Reading Laptop" in answer.text
    assert "Suitability for your intended use" in answer.text
    assert all(not request["arguments"].get("attributes") for request in requests)
    assert any(
        str(request["arguments"].get("max_price")) == "450" for request in requests
    )
    plan = map_discovery_request(interpretation, message, ShoppingIntent)
    assert [r.value for r in plan.shopping_context.relations] == [
        "reading",
        "video calls",
    ]


@pytest.mark.parametrize("interruption", [" without nuts ", ". ", " or ", ""])
def test_coordinated_use_cannot_skip_unrelated_text_or_sentence_boundaries(
    interruption,
):
    message = "find laptop for reading" + interruption + "and video calls"
    meaning = context(
        message,
        ("intended_use", "reading", "for reading"),
        ("intended_use", "video calls", "and video calls"),
    )
    for relation in meaning["relations"]:
        relation["ruleId"] = "for.activity"
    with pytest.raises(ShoppingContextError):
        verified_context(meaning, message)


def test_coordinated_use_requires_a_preceding_purpose_and_same_negation():
    message = "find laptop for reading and video calls"
    meaning = context(message, ("intended_use", "video calls", "and video calls"))
    with pytest.raises(ShoppingContextError):
        verified_context(meaning, message)
    meaning = context(
        message,
        ("intended_use", "reading", "for reading"),
        ("intended_use", "video calls", "and video calls"),
    )
    for relation in meaning["relations"]:
        relation["ruleId"] = "for.activity"
    meaning["relations"][1]["negated"] = True
    with pytest.raises(ShoppingContextError):
        verified_context(meaning, message)


def test_both_coordinated_uses_rank_catalog_options_without_becoming_requirements():
    message = "find laptop for reading and for video calls"
    meaning = context(
        message,
        ("intended_use", "reading", "for reading"),
        ("intended_use", "video calls", "and for video calls"),
    )
    for relation in meaning["relations"]:
        relation["ruleId"] = "for.activity"
    plan = map_discovery_request(gate(message, meaning), message, ShoppingIntent)
    assert plan is not None
    ground_context(
        plan,
        CatalogSchema(
            **laptop_schema(
                [
                    schema_attribute(
                        "usage",
                        options=["reading", "video_calls"],
                        semantic_role="intended_use",
                        policy="semantic",
                    )
                ]
            )
        ),
    )
    assert not plan.attributes and plan.intended_use is None
    assert {(preference.name, preference.value) for preference in plan.preferences} == {
        ("usage", "reading"),
        ("usage", "video_calls"),
    }
