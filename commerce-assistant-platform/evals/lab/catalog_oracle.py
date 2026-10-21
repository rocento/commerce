"""Independent frozen-catalog checks, with no imports from shopping selection.

This deliberately does not implement lexical retrieval or subjective ranking.
It checks declared factual constraints and question choices against complete
sellable offers, never against the bounded cards returned by the assistant.
"""

import json
from decimal import Decimal, InvalidOperation

from evals.lab.models import ClarificationExpectation, Expectation, Failure, Predicate


def decoded(value):
    try:
        return json.loads(value, parse_float=Decimal)
    except (ValueError, TypeError):
        return value


def scalar_key(value):
    if isinstance(value, bool):
        return ("boolean", value)
    if isinstance(value, (int, float, Decimal)):
        number = Decimal(str(value))
        return ("number", number) if number.is_finite() else ("invalid", None)
    if isinstance(value, str):
        return ("string", value.casefold().strip())
    return ("invalid", None)


def facts(product):
    return {a.name: (decoded(a.value), a.source) for a in product.attributes}


def attribute_type(definition):
    # Both spellings are existing merchant schema types. Normalize metadata
    # vocabulary without adding a product fact or reusing runtime selection.
    return {
        "single_select": "select",
        "multi_select": "multiselect",
        "float": "number",
    }.get(definition.data_type, definition.data_type)


def satisfies(product, predicate, schema):
    definition = next((a for a in schema.attributes if a.code == predicate.code), None)
    fact = facts(product).get(predicate.code)
    if definition is None or fact is None or fact[1] not in predicate.trusted_sources:
        return False
    actual, _ = fact
    kind = attribute_type(definition)
    if kind in {"integer", "decimal", "number"}:
        if isinstance(actual, bool) or isinstance(predicate.value, (bool, str)):
            return False
        try:
            number, limit = Decimal(str(actual)), Decimal(str(predicate.value))
        except (InvalidOperation, ValueError):
            return False
        if not number.is_finite() or not limit.is_finite():
            return False
        return {
            "eq": number == limit,
            "neq": number != limit,
            "contains": number == limit,
            "gte": number >= limit,
            "gt": number > limit,
            "lte": number <= limit,
            "lt": number < limit,
        }.get(predicate.operator, False)
    if predicate.operator == "contains":
        return (
            any(scalar_key(value) == scalar_key(predicate.value) for value in actual)
            if isinstance(actual, list)
            else scalar_key(actual) == scalar_key(predicate.value)
        )
    if predicate.operator == "neq" and kind == "multiselect":
        return isinstance(actual, list) and all(
            scalar_key(value) != scalar_key(predicate.value) for value in actual
        )
    if predicate.operator not in {"eq", "neq"} or isinstance(actual, (dict, list)):
        return False
    if kind == "boolean" and not isinstance(actual, bool):
        return False
    same = scalar_key(actual) == scalar_key(predicate.value)
    return same if predicate.operator == "eq" else not same


def eligible_products(snapshot, expected, predicates=None):
    predicates = expected.predicates if predicates is None else predicates
    result = []
    category_scope = set(expected.category_ids)
    while True:
        expanded = category_scope | {
            str(c.id)
            for c in snapshot.catalog_schema.categories
            if c.parent_id is not None and str(c.parent_id) in category_scope
        }
        if expanded == category_scope:
            break
        category_scope = expanded
    for product in snapshot.products:
        # Parent aggregate facts cannot establish a simultaneously purchasable
        # combination. Every constraint must hold on this single offer.
        if product.product_type.casefold() not in {"simple", "variant"}:
            continue
        if str(product.id) in expected.excluded_ids:
            continue
        if (
            category_scope
            and not (
                {str(product.category_id)}
                | {str(cid) for cid in product.category_ids}
                | set(snapshot.category_memberships.get(str(product.id), []))
            )
            & category_scope
        ):
            continue
        if expected.currency and product.currency != expected.currency:
            continue
        if expected.in_stock and product.in_stock is not True:
            continue
        price = Decimal(product.price)
        if expected.max_price is not None:
            upper = Decimal(expected.max_price)
            if price >= upper if expected.exclusive_max else price > upper:
                continue
        if expected.min_price is not None:
            lower = Decimal(expected.min_price)
            if price <= lower if expected.exclusive_min else price < lower:
                continue
        if all(
            satisfies(product, predicate, snapshot.catalog_schema)
            for predicate in predicates
        ):
            result.append(product)
    return result


def observed_choices(products, code, schema):
    definition = next((a for a in schema.attributes if a.code == code), None)
    if definition is None:
        return {}
    counts = {}
    for product in products:
        fact = facts(product).get(code)
        if fact is None or fact[1] not in {"MERCHANT", "VERIFIED", "IMPORTED"}:
            continue
        actual = fact[0]
        values = (
            actual
            if attribute_type(definition) == "multiselect" and isinstance(actual, list)
            else [actual]
        )
        # A multiselect product contributes once per value, not once per tag
        # occurrence; counts are overlapping populations, not disjoint bins.
        for key in {scalar_key(value) for value in values}:
            if key[0] != "invalid":
                counts[key] = counts.get(key, 0) + 1
    return counts


def frozen_profile(snapshot, arguments):
    """In-process structured-query simulation, explicitly not search recall.

    Profile options use every scoped frozen offer, independently of the replay
    page. Lexical/semantic retrieval remains the external observation's job.
    """
    query = arguments.get("query", "*").strip().casefold()
    if query != "*":
        matching = [
            category
            for category in snapshot.catalog_schema.categories
            if query
            in {
                category.name.casefold(),
                *(alias.casefold() for alias in category.aliases),
            }
        ]
        if len(matching) != 1:
            return None
        arguments = {**arguments, "category_id": str(matching[0].id)}
    predicates = []
    definitions = {a.code: a for a in snapshot.catalog_schema.attributes}
    raw = arguments.get("attributes", {})
    attributes = {a["name"]: a["value"] for a in raw} if isinstance(raw, list) else raw
    for code, value in attributes.items():
        definition = definitions.get(code)
        if definition is None:
            raise ValueError("Unknown structured replay attribute")
        if definition is not None:
            predicates.append(
                Predicate(
                    code=code,
                    operator="contains"
                    if attribute_type(definition) == "multiselect"
                    else "eq",
                    value=value,
                )
            )
    for predicate in arguments.get("predicates", []):
        code = predicate.get("name")
        if code not in definitions:
            raise ValueError("Unknown structured replay predicate")
        if code in definitions:
            predicates.append(
                Predicate(
                    code=code, operator=predicate["operator"], value=predicate["value"]
                )
            )
    category = arguments.get("category_id")
    scope = Expectation(category_ids=[category] if category else [])
    expected = scope.model_copy(
        update={
            "predicates": predicates,
            "min_price": arguments.get("min_price"),
            "exclusive_min": arguments.get("exclusive_min", False),
            "max_price": arguments.get("max_price"),
            "exclusive_max": arguments.get("exclusive_max", False),
            "in_stock": arguments.get("in_stock", False),
            "excluded_ids": arguments.get("excluded_product_ids", []),
        }
    )
    products = eligible_products(snapshot, expected)
    facets = []
    for attribute in snapshot.catalog_schema.attributes:
        if not attribute.facetable:
            continue
        counts = observed_choices(products, attribute.code, snapshot.catalog_schema)
        available = {}
        for product in products:
            fact = facts(product).get(attribute.code)
            if fact is None:
                continue
            actual = fact[0]
            values = (
                actual
                if attribute_type(attribute) == "multiselect"
                and isinstance(actual, list)
                else [actual]
            )
            for value in values:
                key = scalar_key(value)
                if key in counts:
                    available[key] = value
        entries = []
        for key in sorted(counts, key=str)[:24]:
            value = available[key]
            if isinstance(value, Decimal):
                number = float(value)
                if Decimal(str(number)) != value:
                    continue
                value = number
            option = next(
                (o for o in attribute.options if scalar_key(o.code) == key), None
            )
            entries.append(
                {
                    "value": value,
                    "label": option.label if option else str(value),
                    "count": counts[key],
                }
            )
        covered = sum(
            any(
                a.name == attribute.code
                and a.source in {"MERCHANT", "VERIFIED", "IMPORTED"}
                for a in product.attributes
            )
            for product in products
        )
        facets.append(
            {
                "code": attribute.code,
                "label": attribute.label,
                "data_type": attribute.data_type,
                "unit": attribute.unit,
                "covered_count": covered,
                "values": entries,
                "values_complete": len(counts) <= 24 and len(entries) == len(counts),
            }
        )
    prices = []
    for currency in sorted({p.currency for p in products}):
        values = [Decimal(p.price) for p in products if p.currency == currency]
        prices.append(
            {
                "currency": currency,
                "min": str(min(values)),
                "max": str(max(values)),
                "count": len(values),
            }
        )
    return {
        "revision": snapshot.catalog_schema.version,
        "scope": "current_sellable_category"
        if category
        else "current_sellable_catalog",
        "complete": snapshot.catalog_complete
        and len(eligible_products(snapshot, scope)) <= 1_000,
        "candidate_count": len(eligible_products(snapshot, scope)),
        "matched_count": len(products),
        "facets": facets[:30],
        "facets_complete": len(facets) <= 30,
        "prices": prices,
    }


def path_value(frame, path):
    for key in path.split("."):
        if isinstance(frame, dict):
            frame = frame.get(key)
        elif isinstance(frame, list) and key.isdigit() and int(key) < len(frame):
            frame = frame[int(key)]
        else:
            return None
    return frame


def dynamic_assertions(blocks, snapshot, expected, pending=None, frame=None):
    failures = []

    def check(ok, assertion, layer="understanding", safety=False):
        if not ok:
            failures.append(Failure(assertion=assertion, layer=layer, safety=safety))

    cards = [product for block in blocks for product in block.products or []]
    check(
        not expected.forbid_results or not cards,
        "unresolved_requirement_presented_as_match",
        safety=True,
    )
    if (
        expected.predicates
        or expected.category_ids
        or expected.excluded_ids
        or expected.min_price is not None
    ):
        eligible = {str(p.id) for p in eligible_products(snapshot, expected)}
        for card in cards:
            check(
                str(card.id) in eligible,
                "typed_hard_constraint_or_sellable_variant",
                safety=True,
            )
    if expected.require_eligible:
        check(
            snapshot.catalog_complete, "complete_oracle_snapshot_required", "retrieval"
        )
        if snapshot.catalog_complete and eligible_products(snapshot, expected):
            question_fields = {a.code for a in snapshot.catalog_schema.attributes} | {
                "budget",
                "category",
            }
            useful_question = bool(
                expected.allow_clarification
                and pending
                and pending.get("field") in question_fields
                and pending.get("question")
            )
            check(bool(cards) or useful_question, "false_no_match", "retrieval")
    question = expected.clarification
    if question is None and pending is not None:
        question = ClarificationExpectation(scope_predicates=expected.predicates)
    if question is not None:
        check(pending is not None, "required_clarification_missing")
        if pending is not None:
            check(
                snapshot.catalog_complete,
                "complete_question_scope_required",
                "retrieval",
            )
            field = pending.get("field")
            check(
                question.field is None or field == question.field, "clarification_field"
            )
            choices = pending.get("choices", [])
            keys = [scalar_key(choice.get("value")) for choice in choices]
            check(len(keys) >= question.min_choices, "clarification_choice_count")
            check(len(keys) == len(set(keys)), "duplicate_clarification_choice")
            check(
                all(scalar_key(v) in keys for v in question.required_choices),
                "required_clarification_choice",
            )
            check(
                all(scalar_key(v) not in keys for v in question.forbidden_choices),
                "irrelevant_clarification_choice",
                safety=True,
            )
            if question.optional is not None:
                check(
                    pending.get("optional") == question.optional,
                    "clarification_optional_policy",
                )
            if field not in {"budget", "category"} and snapshot.catalog_complete:
                scoped = eligible_products(
                    snapshot, expected, question.scope_predicates
                )
                available = observed_choices(scoped, field, snapshot.catalog_schema)
                check(
                    all(key in available for key in keys),
                    "unsupported_or_zero_count_clarification_choice",
                    "retrieval",
                    True,
                )
            elif field == "category":
                known = {
                    cid
                    for p in eligible_products(
                        snapshot, expected, question.scope_predicates
                    )
                    for cid in {
                        str(p.category_id),
                        *(str(cid) for cid in p.category_ids),
                        *snapshot.category_memberships.get(str(p.id), []),
                    }
                }
                check(
                    all(str(choice.get("value")) in known for choice in choices),
                    "unsupported_category_choice",
                    "retrieval",
                    True,
                )
            elif field == "budget":
                scoped = eligible_products(
                    snapshot, expected, question.scope_predicates
                )
                currencies = {p.currency for p in scoped}
                check(
                    currencies == {pending.get("currency")},
                    "clarification_budget_currency",
                    "retrieval",
                    True,
                )
                values = [Decimal(p.price) for p in scoped]
                for choice in choices:
                    raw = choice.get("value")
                    try:
                        ceiling = Decimal(str(raw))
                    except InvalidOperation:
                        ceiling = Decimal("NaN")
                    check(
                        not isinstance(raw, bool)
                        and ceiling.is_finite()
                        and choice.get("operator") in {"lt", "lte"}
                        and values
                        and min(values) <= ceiling < max(values),
                        "unsupported_or_non_narrowing_budget_choice",
                        "retrieval",
                        True,
                    )
    if expected.preserved_paths:
        actual = frame or (pending or {}).get("frame", {})
        for path, value in expected.preserved_paths.items():
            check(
                path_value(actual, path) == value,
                "follow_up_preserved:" + path,
                safety=True,
            )
    return failures
