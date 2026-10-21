"""Bind published language relationships to customer text and live catalog facts."""

import json
import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, cast

from app.commerce_action_engine.actions.catalog import CatalogSchema, SchemaAttribute

from .constraints import normalized, schema_value
from .contracts import (
    Constraint,
    ResponsePreference,
    ShoppingContext,
    ShoppingIntent,
    ShoppingRelation,
)


class ShoppingContextError(ValueError):
    """A contextual interpretation cannot safely express this request."""


@dataclass(frozen=True)
class GroundedRelationship:
    constraint: Constraint
    relation: ShoppingRelation


_COMPILED_KNOWLEDGE = (
    Path(__file__).resolve().parents[3]
    / "commerce_language_engine"
    / "data"
    / "compiled.json"
)


def _sentence_phrase(text: str) -> str:
    """Mirror published utterance normalization; never remove interior clauses."""
    text = (
        unicodedata.normalize("NFKC", text.lower()).replace("−", "-").replace("’", "'")
    )
    for source, target in {
        "don't": "do not",
        "can't": "can not",
        "i'm": "i am",
        "didn't": "did not",
        "hasn't": "has not",
        "haven't": "have not",
        "isn't": "is not",
        "wasn't": "was not",
        "won't": "will not",
        "wheres": "where is",
    }.items():
        text = re.sub(r"\b" + re.escape(source) + r"\b", target, text)
    text = re.sub(r"[^a-z0-9$€£.,'\s-]", " ", text)
    text = re.sub(r"[.,](?!\d)", " ", text)
    text = " ".join(text.split())
    text = re.sub(r"^(?:please|pls|plz|kindly)\s+", "", text)
    return re.sub(r"\s+(?:please|pls|plz|kindly)$", "", text)


@lru_cache(maxsize=2)
def _read_sentence_rules(stamp: tuple[int, int]) -> dict[str, dict[str, Any]]:
    # The exported release is the same database-backed artifact consumed by the
    # language engine. A source pack edit alone cannot authorize masking text.
    del stamp
    compiled = json.loads(_COMPILED_KNOWLEDGE.read_text())
    rules = compiled.get("languageKnowledge", {}).get("utteranceRules", [])
    return {rule["id"]: rule for rule in rules if rule["role"] != "budget_update"}


def _published_sentence_rules() -> dict[str, dict[str, Any]]:
    try:
        stat = _COMPILED_KNOWLEDGE.stat()
        return _read_sentence_rules((stat.st_mtime_ns, stat.st_size))
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ShoppingContextError(
            "Please clarify the product and its requirements."
        ) from error


def recommendation_reference(message: str) -> str | None:
    """Recognize reviewed whole follow-ups in saved history, without product IDs."""
    if (
        len(message.encode("utf-16-le", errors="surrogatepass")) // 2 > 500
        or re.search(r"""[\n;:"“”]|(?:^|\s)'[^'\n]+'(?:\s|$)""", message)
        or not message
        or not all(c.isalpha() or c.isspace() or c in "'’.,!?-" for c in message)
    ):
        return None
    phrase = _sentence_phrase(message)
    for rule in _published_sentence_rules().values():
        if (
            rule.get("role") == "recommendation_followup"
            and rule.get("reference") == "FIRST"
            and phrase in {_sentence_phrase(text) for text in rule.get("phrases", [])}
        ):
            return "FIRST"
    return None


def _knowledge_tokens(text: str) -> tuple[str, ...]:
    """Mirror published token matching without discarding unknown source words."""
    return tuple(
        word
        for token in re.findall(r"[^\W_]+(?:[-'’][^\W_]+)*", text)
        for word in _sentence_phrase(token).split()
    )


@lru_cache(maxsize=2)
def _read_relationship_rules(
    stamp: tuple[str, int, int],
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    del stamp
    pack = json.loads(_COMPILED_KNOWLEDGE.read_text())["languageKnowledge"]
    return (
        {concept["id"]: concept for concept in pack["concepts"]},
        {rule["id"]: rule for rule in pack["rules"]},
    )


def _published_relationship_rules() -> tuple[
    dict[str, dict[str, Any]], dict[str, dict[str, Any]]
]:
    try:
        stat = _COMPILED_KNOWLEDGE.stat()
        return _read_relationship_rules(
            (str(_COMPILED_KNOWLEDGE), stat.st_mtime_ns, stat.st_size)
        )
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ShoppingContextError(
            "Please clarify the product and its requirements."
        ) from error


@lru_cache(maxsize=2)
def _read_budget_rules(stamp: tuple[str, int, int]) -> list[dict[str, Any]]:
    del stamp
    return cast(
        list[dict[str, Any]],
        json.loads(_COMPILED_KNOWLEDGE.read_text())
        .get("languageKnowledge", {})
        .get("budgetRules", []),
    )


def published_budget_rules() -> list[dict[str, Any]]:
    try:
        stat = _COMPILED_KNOWLEDGE.stat()
        return _read_budget_rules(
            (str(_COMPILED_KNOWLEDGE), stat.st_mtime_ns, stat.st_size)
        )
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ShoppingContextError("Please clarify the budget.") from error


def _target_matches(
    words: tuple[str, ...],
    concept: dict[str, Any],
    concepts: dict[str, dict[str, Any]],
) -> bool:
    if words and words[0] in {"a", "an", "the"}:
        words = words[1:]
    if words and words[0] in {"my", "our", "his", "her", "their", "your"}:
        if concept["kind"] not in {"person", "device", "occasion"}:
            return False
        words = words[1:]
    positions = [words]
    if concept["kind"] in {"occasion", "device"}:
        for owner in concepts.values():
            if owner["kind"] != "person":
                continue
            for form in [owner["canonical"], *owner["aliases"]]:
                owner_words = _knowledge_tokens(form)
                possessive = (*owner_words[:-1], owner_words[-1] + "'s")
                if words[: len(possessive)] == possessive:
                    positions.append(words[len(possessive) :])
    forms = {
        _knowledge_tokens(form) for form in [concept["canonical"], *concept["aliases"]]
    }
    return any(position in forms for position in positions)


def _verify_relation_meaning(
    relation: ShoppingRelation,
    previous: ShoppingRelation | None,
    message: str,
    concepts: dict[str, dict[str, Any]],
    rules: dict[str, dict[str, Any]],
) -> None:
    """The release authorizes a meaning; the complete source span proves it."""
    concept, rule = concepts.get(relation.conceptId), rules.get(relation.ruleId)
    if (
        concept is None
        or rule is None
        or rule.get("requiresClarification") is True
        or relation.value != concept["canonical"]
        or rule["relation"] != relation.relation
        or rule["targetKind"] != concept["kind"]
        or any(
            concept.get("metadata", {}).get(key) != value
            for key, value in rule.get("targetMetadata", {}).items()
        )
        or not all(
            char.isalnum() or char.isspace() or char in "'’.,&()/-"
            for char in relation.text
        )
        or any(char in relation.text for char in "\n\r")
        or any(
            not _sentence_phrase(token)
            for token in re.findall(r"[^\W_]+(?:[-'’][^\W_]+)*", relation.text)
        )
    ):
        raise ShoppingContextError("Please clarify the relationship to the product.")
    words = _knowledge_tokens(relation.text)
    coordinated = words[:1] == ("and",)
    if coordinated:
        if previous is None or not re.fullmatch(
            r"\s*,?\s+", message[previous.end : relation.start]
        ):
            raise ShoppingContextError(
                "Please clarify each product requirement separately."
            )
        words = words[1:]
    explicit_not = words[:1] == ("not",)
    if explicit_not:
        words = words[1:]
    if explicit_not and rule.get("negated"):
        raise ShoppingContextError("Please clarify the double negative requirement.")
    negated = explicit_not or rule.get("negated") is True
    if negated != relation.negated:
        raise ShoppingContextError("Please clarify which requirements should apply.")
    marker = _knowledge_tokens(rule["marker"])
    if rule["marker"] == "modifier":
        if (
            coordinated
            or negated
            or concept.get("metadata", {}).get("ambiguous")
            or concept.get("metadata", {}).get("requiresContext")
        ):
            raise ShoppingContextError(
                "Please clarify the relationship to the product."
            )
    elif words[: len(marker)] == marker:
        words = words[len(marker) :]
        if marker[:1] == ("who",) and (
            previous is None
            or previous.relation not in {"recipient", "audience"}
            or previous.negated
            or not re.fullmatch(r"\s*,?\s+", message[previous.end : relation.start])
        ):
            raise ShoppingContextError("Please clarify whose intended use you mean.")
    elif not (
        coordinated
        and previous is not None
        and not explicit_not
        and (not previous.negated or rule.get("negated") is True)
        and rules.get(previous.ruleId, {}).get("marker") == rule["marker"]
    ):
        raise ShoppingContextError("Please clarify the relationship to the product.")
    if rule.get("targetPossessive") is True:
        target_words = words[1:] if words[:1] in {("a",), ("an",), ("the",)} else words
        inherited_owner = (
            coordinated
            and previous is not None
            and rules.get(previous.ruleId, {}).get("targetPossessive") is True
            and _knowledge_tokens(relation.text)[1 : 1 + len(marker)] != marker
        )
        if (
            target_words[:1]
            not in {("my",), ("our",), ("his",), ("her",), ("their",), ("your",)}
            and not inherited_owner
        ):
            raise ShoppingContextError("Please clarify who will receive the product.")
    target_matches = (
        words
        in {
            _knowledge_tokens(form)
            for form in [concept["canonical"], *concept["aliases"]]
        }
        if rule["marker"] == "modifier"
        else _target_matches(words, concept, concepts)
    )
    if (
        not target_matches
        or concept["kind"] == "country"
        and concept.get("metadata", {}).get("ambiguous") is True
        and rule["marker"] in {"for", "from"}
    ):
        raise ShoppingContextError(
            "Please clarify each product requirement separately."
        )


def verified_context(value: object, message: str) -> ShoppingContext:
    """Only exact, nonoverlapping source spans can be removed from word parsing.

    The engine is the vocabulary authority; source evidence still cannot swallow
    another action, price, safety requirement, or quoted product identity.
    """
    context = ShoppingContext.model_validate(value, strict=True)
    quoted = [m.span() for m in re.finditer(r'["“][^"”\n]*["”]', message)]
    quoted += [
        match.span() for match in re.finditer(r"(?:^|\s)'[^'\n]+'(?:\s|$)", message)
    ]
    previous = -1
    previous_relation: ShoppingRelation | None = None
    seen: dict[tuple[str, str], bool] = {}
    concepts, relationship_rules = (
        _published_relationship_rules() if context.relations else ({}, {})
    )
    for relation in context.relations:
        if (
            relation.start < previous
            or relation.end <= relation.start
            or relation.end > len(message)
            or message[relation.start : relation.end] != relation.text
            or any(a < relation.end and relation.start < b for a, b in quoted)
            or relation.start > 0
            and (
                message[relation.start - 1].isalnum()
                or message[relation.start - 1] in "_'’-"
            )
            or relation.end < len(message)
            and (message[relation.end].isalnum() or message[relation.end] in "_'’-")
        ):
            raise ShoppingContextError(
                "Please clarify the product and its requirements."
            )
        previous = relation.end
        _verify_relation_meaning(
            relation, previous_relation, message, concepts, relationship_rules
        )
        identity = relation.relation, relation.conceptId
        if identity in seen and seen[identity] != relation.negated:
            raise ShoppingContextError(
                "Please clarify which conflicting requirement should apply."
            )
        seen[identity] = relation.negated
        previous_relation = relation
    rules = _published_sentence_rules() if context.sentenceRoles else {}
    preferences = set()
    spans = [(relation.start, relation.end) for relation in context.relations]
    for sentence in context.sentenceRoles:
        rule = rules.get(sentence.ruleId)
        before, after = message[: sentence.start], message[sentence.end :]
        if (
            sentence.end <= sentence.start
            or sentence.end > len(message)
            or message[sentence.start : sentence.end] != sentence.text
            or any(a < sentence.end and sentence.start < b for a, b in quoted + spans)
            or not all(
                c.isalpha() or c.isspace() or c in "'’.,!?-" for c in sentence.text
            )
            or bool(before.strip())
            and re.search(r"[.!?]\s*$", before) is None
            or re.match(r"^\s*(?:[.!?]|$)", after) is None
            or rule is None
            or rule.get("role") != sentence.role
            or _sentence_phrase(sentence.text)
            not in {_sentence_phrase(phrase) for phrase in rule.get("phrases", [])}
        ):
            raise ShoppingContextError(
                "Please clarify the product and its requirements."
            )
        spans.append((sentence.start, sentence.end))
        if sentence.role == "response_preference":
            preferences.add(rule.get("preference"))
    if preferences != set(context.responsePreferences):
        raise ShoppingContextError(
            "Please clarify how you would like the answer presented."
        )
    return context


def contextual_message(context: ShoppingContext, message: str) -> str:
    """Mask source spans only. coreText never authorizes deleting other words."""
    verified_context(context.model_dump(), message)
    chars = list(message)
    spans = [(relation.start, relation.end) for relation in context.relations]
    spans += [(sentence.start, sentence.end) for sentence in context.sentenceRoles]
    for start, end in spans:
        chars[start:end] = " " * (end - start)
    return "".join(chars)


def _matches(definition: SchemaAttribute, relation: ShoppingRelation) -> list[str]:
    phrase = re.sub(
        r"^(?:not\s+)?(?:(?:for|and|from|made\s+in|(?:shipping|delivery)\s+to|"
        r"in(?:\s+colou?r)?|colou?red|colou?r)\s+)?"
        r"(?:(?:my|our|the|a|an|his|her|their|your)\s+)?",
        "",
        relation.text,
        flags=re.IGNORECASE,
    )
    wanted = {normalized(relation.value), normalized(phrase)}
    if definition.options:
        return list(
            dict.fromkeys(
                option.code
                for option in definition.options
                if wanted.intersection(
                    normalized(n)
                    for n in (option.code, option.label, *option.labels.values())
                )
            )
        )
    if definition.data_type == "text":
        return [str(schema_value(definition, relation.value))]
    return []


def ground_context(
    plan: ShoppingIntent, schema: CatalogSchema
) -> tuple[GroundedRelationship, ...]:
    """Soft context can rank verified options; hard relationships must be expressible."""
    if not plan.shopping_context:
        return ()
    grounded_requirements: list[GroundedRelationship] = []
    roles = {
        "color": {"color", "colour"},
        "material": {"material", "metal", "composition"},
        "audience": {"audience", "target_audience", "gender", "age_group"},
        "origin_country": {
            "origin_country",
            "country_of_origin",
            "made_in",
            "manufacturing_country",
        },
        "market_country": {"market_country", "target_market", "market_region"},
    }
    for relation in plan.shopping_context.relations:
        if relation.relation == "recipient":
            continue  # No age, gender, medical need, or preference inference.
        if relation.relation in {"intended_use", "occasion"}:
            if relation.negated:
                continue  # Not using a capability does not ban capable products.
            matches = {
                (definition.code, value)
                for definition in schema.attributes
                if definition.filterable
                and definition.semantic_role == "intended_use"
                and definition.options
                for value in _matches(definition, relation)
            }
            if len(matches) == 1 and len(plan.preferences) < 5:
                name, value = next(iter(matches))
                preference = Constraint(name=name, value=value)
                if (
                    preference not in plan.preferences
                    and preference not in plan.attributes
                ):
                    plan.preferences.append(preference)
            continue
        if relation.relation == "destination_country":
            raise ShoppingContextError(
                f"You requested delivery to {relation.value}. Please select a delivery address so this store can verify its delivery coverage."
            )
        fields = roles[relation.relation]
        matches = {
            (definition.code, value)
            for definition in schema.attributes
            if definition.filterable
            and (definition.semantic_role in fields or definition.code in fields)
            for value in _matches(definition, relation)
        }
        if len(matches) != 1:
            label = relation.relation.replace("_", " ")
            raise ShoppingContextError(
                f"I understood your {label} requirement ({relation.value}), but this catalog does not provide one clear field and value to verify it. Please choose a listed product or clarify the required feature."
            )
        name, value = next(iter(matches))
        required = Constraint(
            name=name, value=value, operator="neq" if relation.negated else "eq"
        )
        # Generic language color names yield to the merchant's actual field.
        if relation.relation == "color":
            plan.attributes = [
                c
                for c in plan.attributes
                if not (
                    c.name in {"color", "colour"}
                    and normalized(c.value) == normalized(relation.value)
                )
            ]
        if any(
            c.name == name
            and (
                c.operator == required.operator == "eq"
                and c.value != value
                or c.operator != required.operator
                and c.value == value
            )
            for c in plan.attributes
        ):
            raise ShoppingContextError(
                "Please clarify which value should apply to your product requirement."
            )
        if required not in plan.attributes:
            plan.attributes.append(required)
        grounded_requirements.append(
            GroundedRelationship(
                required.model_copy(deep=True), relation.model_copy(deep=True)
            )
        )
        if len(plan.attributes) > 10:
            raise ShoppingContextError(
                "Please narrow the number of required product features."
            )
    return tuple(grounded_requirements)


def context_note(plan: ShoppingIntent) -> str | None:
    if plan.shopping_context and any(
        r.relation == "intended_use" for r in plan.shopping_context.relations
    ):
        return "These are product matches. Suitability for your intended use is only verified where the catalog explicitly lists that use."
    return None


def response_preferences(plan: ShoppingIntent) -> set[str]:
    return (
        set(plan.shopping_context.responsePreferences)
        if plan.shopping_context
        else set()
    )


def response_product_limit(plan: ShoppingIntent, default: int = 5) -> int:
    preferences = response_preferences(plan)
    if "two_options" in preferences:
        return min(default, 2)
    return (
        min(default, 3)
        if preferences.intersection({"short", "practical_start"})
        else default
    )


def consume_response_preference(
    plan: ShoppingIntent, preference: ResponsePreference
) -> ShoppingIntent:
    """Copy an answered response preference out of the server-owned continuation."""
    frame = plan.model_copy(deep=True)
    context = frame.shopping_context
    if context is not None and preference in context.responsePreferences:
        rules = _published_sentence_rules()
        context.responsePreferences.remove(preference)
        context.sentenceRoles = [
            role
            for role in context.sentenceRoles
            if rules.get(role.ruleId, {}).get("preference") != preference
        ]
        if not context.relations and not context.sentenceRoles:
            frame.shopping_context = None
    return frame
