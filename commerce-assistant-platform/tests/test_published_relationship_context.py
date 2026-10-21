"""Python verifies the same published grammar evidence as the language runtime."""

import json
from copy import deepcopy
from pathlib import Path

import pytest
from test_shopping_context import context

from app.commerce_action_engine.actions.shopping import context as shopping_context
from app.commerce_action_engine.actions.shopping.context import (
    ShoppingContextError,
    contextual_message,
    verified_context,
)


@pytest.fixture(autouse=True)
def candidate_release(tmp_path, monkeypatch):
    pack = json.loads(
        (
            Path(__file__).resolve().parents[1]
            / "app/commerce_language_engine/data/knowledge/shopping-en-v1.json"
        ).read_text()
    )
    artifact = tmp_path / "compiled.json"
    artifact.write_text(json.dumps({"languageKnowledge": pack}))
    monkeypatch.setattr(shopping_context, "_COMPILED_KNOWLEDGE", artifact)
    shopping_context._read_relationship_rules.cache_clear()
    yield pack, artifact
    shopping_context._read_relationship_rules.cache_clear()


@pytest.mark.parametrize(
    "role,value,phrase,rule_id",
    [
        (
            "intended_use",
            "remote work",
            "to use for telecommuting",
            "activity.to_use_for",
        ),
        (
            "intended_use",
            "online classes",
            "for use during remote lessons",
            "activity.for_use_during",
        ),
        ("recipient", "mother", "as a gift for my mom", "recipient.as_a_gift_for"),
        ("occasion", "wedding", "to wear at a wedding", "occasion.to_wear_at"),
        ("occasion", "birthday", "for my mother's birthday", "for.occasion"),
        ("occasion", "birthday", "for my best friend's birthday", "for.occasion"),
    ],
)
def test_published_markers_aliases_and_possessives_verify_complete_literal_spans(
    role, value, phrase, rule_id
):
    message = "Find headphones " + phrase + " under $60"
    meaning = context(message, (role, value, phrase))
    meaning["relations"][0]["ruleId"] = rule_id
    verified = verified_context(meaning, message)
    masked = contextual_message(verified, message)
    assert phrase not in masked
    assert "headphones" in masked and "under $60" in masked


def test_relative_use_is_bound_to_the_immediately_preceding_positive_person():
    message = (
        "Find laptop for my mother, who mainly uses it for virtual meetings under $800"
    )
    meaning = context(
        message,
        ("recipient", "mother", "for my mother"),
        ("intended_use", "video calls", "who mainly uses it for virtual meetings"),
    )
    meaning["relations"][1]["ruleId"] = "activity.who_mainly_uses_it_for"
    assert verified_context(meaning, message).relations[1].value == "video calls"
    for altered in [
        meaning["relations"][1:],
        [meaning["relations"][1], meaning["relations"][0]],
    ]:
        with pytest.raises(ShoppingContextError):
            verified_context({**meaning, "relations": altered}, message)
    interrupted = message.replace(", who", " without nuts, who")
    tampered = deepcopy(meaning)
    second = tampered["relations"][1]
    second["start"] = interrupted.index(second["text"])
    second["end"] = second["start"] + len(second["text"])
    with pytest.raises(ShoppingContextError):
        verified_context(tampered, interrupted)


@pytest.mark.parametrize(
    "suffix,role,value,rule_id,negated",
    [
        ("and gaming", "intended_use", "gaming", "for.activity", False),
        ("and for gaming", "intended_use", "gaming", "for.activity", False),
        ("and not for gaming", "intended_use", "gaming", "for.activity", True),
        ("and a birthday", "occasion", "birthday", "for.occasion", False),
    ],
)
def test_coordination_inherits_marker_not_semantic_kind(
    suffix, role, value, rule_id, negated
):
    message = "Find laptop for my mother " + suffix
    meaning = context(
        message, ("recipient", "mother", "for my mother"), (role, value, suffix)
    )
    meaning["relations"][1].update(ruleId=rule_id, negated=negated)
    assert len(verified_context(meaning, message).relations) == 2


@pytest.mark.parametrize(
    "change",
    [
        {"ruleId": "rule.invented"},
        {"conceptId": "test.0"},
        {"value": "gaming"},
        {"conceptId": "activity.gaming", "value": "gaming"},
        {"ruleId": "for.recipient"},
        {"negated": True},
    ],
)
def test_relation_metadata_cannot_disagree_with_release_or_source(change):
    message = "Find laptop for online classes"
    meaning = context(message, ("intended_use", "online classes", "for online classes"))
    meaning["relations"][0].update(change)
    with pytest.raises(ShoppingContextError):
        verified_context(meaning, message)


@pytest.mark.parametrize(
    "phrase,value",
    [
        ("for online classes and checkout", "online classes"),
        ("for online classes without nuts", "online classes"),
        ("for my unknown friend's birthday", "birthday"),
        ("for somebody's birthday", "birthday"),
        ("for gaming $600", "gaming"),
        ("for 通話 gaming", "gaming"),
    ],
)
def test_known_marker_cannot_discard_unrecognized_suffix_or_owner(phrase, value):
    role = "occasion" if value == "birthday" else "intended_use"
    message = "Find laptop " + phrase
    meaning = context(message, (role, value, phrase))
    with pytest.raises(ShoppingContextError):
        verified_context(meaning, message)


@pytest.mark.parametrize(
    "message,phrase",
    [
        ("Find 'laptop for gaming'", "for gaming"),
        ("Find laptop notfor gaming", "for gaming"),
        ("Find laptop for gaming-laptops", "for gaming"),
        ("Find laptop for gaming's sake", "for gaming"),
    ],
)
def test_source_spans_cannot_start_inside_tokens_or_quoted_product_names(
    message, phrase
):
    meaning = context(message, ("intended_use", "gaming", phrase))
    with pytest.raises(ShoppingContextError):
        verified_context(meaning, message)


def test_new_reviewed_alias_and_marker_activate_from_artifact_without_code_changes(
    candidate_release,
):
    pack, artifact = candidate_release
    concept = next(row for row in pack["concepts"] if row["id"] == "activity.gaming")
    concept["aliases"].append("playing strategy games")
    pack["rules"].append(
        {
            "id": "activity.reviewed_purpose",
            "marker": "for the purpose of",
            "targetKind": "activity",
            "relation": "intended_use",
            "scope": "product",
            "priority": 140,
        }
    )
    artifact.write_text(json.dumps({"languageKnowledge": pack}))
    message = "Find laptop for the purpose of playing strategy games"
    meaning = context(
        message, ("intended_use", "gaming", "for the purpose of playing strategy games")
    )
    meaning["relations"][0]["ruleId"] = "activity.reviewed_purpose"
    assert verified_context(meaning, message).relations[0].value == "gaming"
