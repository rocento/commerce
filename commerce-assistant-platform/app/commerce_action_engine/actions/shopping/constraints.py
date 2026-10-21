"""Validate catalog constraints against verified product facts."""

import json
import re
from decimal import Decimal, InvalidOperation

from app.commerce_action_engine.actions.catalog import (
    CatalogSchema,
    Product,
    SchemaAttribute,
)
from app.commerce_action_engine.actions.shopping.contracts import (
    Constraint,
    ShoppingIntent,
)
from app.commerce_action_engine.actions.shopping.evidence import attribute_evidence
from app.commerce_contracts.comparisons import comparison_operator, comparison_pattern


def normalized(value: str) -> str:
    return " ".join(value.casefold().replace("_", " ").split())


def _phrase_matches(text: str, alias: str) -> list[tuple[int, int]]:
    words = re.findall(r"\w+", normalized(alias))
    if not words:
        return []
    pattern = r"(?<!\w)" + r"[\W_]+".join(re.escape(word) for word in words) + r"(?!\w)"
    return [match.span() for match in re.finditer(pattern, text, re.IGNORECASE)]


def category_tokens(text: str) -> list[str]:
    def singular(word: str) -> str:
        if len(word) > 4 and word.endswith("ies"):
            return word[:-3] + "y"
        if len(word) > 4 and word.endswith(("ches", "shes", "sses", "xes", "zes")):
            return word[:-2]
        return word[:-1] if len(word) > 3 and word.endswith("s") else word

    return [singular(w) for w in re.findall(r"\w+", normalized(text))]


def category_phrase_matches(text: str, alias: str) -> list[tuple[int, int]]:
    """Whole phrase matches with conservative English inflection normalization."""
    words = list(re.finditer(r"[^\W_]+", text))
    actual, wanted = category_tokens(text), category_tokens(alias)
    if not wanted:
        return []
    return [
        (words[i].start(), words[i + len(wanted) - 1].end())
        for i in range(len(actual) - len(wanted) + 1)
        if actual[i : i + len(wanted)] == wanted
    ]


def literal_category_spans(
    text: str, schema: CatalogSchema
) -> tuple[tuple[int, int], ...]:
    """Merchant category names are targets, not incidental attribute values."""
    return tuple(
        sorted(
            {
                span
                for category in schema.categories
                for alias in {category.name, *category.aliases}
                for span in category_phrase_matches(text, alias)
                # An explicit field value remains a requirement, even when its
                # spelling also names a category (e.g. Texture: serum).
                if not any(
                    re.search(
                        r"(?<!\w)" + re.escape(normalized(label)) + r"\s*[:=]?\s*$",
                        normalized(text[: span[0]]),
                    )
                    for definition in schema.attributes
                    for label in {definition.code, definition.label}
                )
            }
        )
    )


def literal_preference(text: str, start: int) -> bool:
    """The nearest explicit preference or requirement cue owns this clause."""
    prefix = re.split(r"[,;.!?]", text[:start])[-1]
    cues = list(
        re.finditer(
            r"\b(prefer(?:ably|red)?|ideally|if possible|must|required|only|not|no|without|exclude|excluding)\b",
            prefix,
            re.IGNORECASE,
        )
    )
    return bool(
        cues
        and cues[-1][1].casefold()
        in {
            "prefer",
            "preferably",
            "preferred",
            "ideally",
            "if possible",
        }
    )


def explicit_field_for_value(
    text: str,
    schema: CatalogSchema,
    start: int,
    end: int,
) -> tuple[SchemaAttribute, tuple[int, int]] | None:
    """Resolve the longest label/code immediately introducing this value span.

    Preserve source offsets. Nested labels such as Size and Ring Size US do not
    both claim one value; an independent later Size clause still resolves itself.
    """
    candidates = []
    category_spans = literal_category_spans(text, schema)
    # The Gold token in "Metal: Rose Gold" is introduced by Metal too. Treat
    # complete managed phrases as one value before checking their field prefix.
    value_starts = {start}
    # A managed alias such as US 6 can overlap the suffix of Ring Size US.
    # Its inner numeric value still belongs to the more specific full label.
    value_starts.update(
        start + match.start()
        for match in re.finditer(r"\d+(?:\.\d+)?", text[start:end])
    )
    for definition in schema.attributes:
        for option in definition.options:
            for alias in {option.code, option.label, *option.labels.values()}:
                for left, right in _phrase_matches(text, alias):
                    if left <= start and end <= right:
                        value_starts.add(left)
    for definition in schema.attributes:
        for alias in {definition.code, definition.label}:
            for left, right in _phrase_matches(text, alias):
                if any(a <= left and right <= b for a, b in category_spans):
                    continue
                if not any(
                    right <= value_start
                    and re.fullmatch(
                        rf"\s*[:=]?\s*(?:(?:{comparison_pattern('attribute', include_symbols=True)})\s*)?",
                        text[right:value_start],
                        re.IGNORECASE,
                    )
                    for value_start in value_starts
                ):
                    continue
                candidates.append((right - left, definition, (left, right)))
    if not candidates:
        return None
    longest = max(item[0] for item in candidates)
    winners = [item for item in candidates if item[0] == longest]
    if len({item[1].code for item in winners}) != 1:
        return None
    _, definition, span = winners[0]
    return definition, span


def explicit_field_label_spans(
    text: str, schema: CatalogSchema
) -> tuple[tuple[int, int], ...]:
    """Labels introducing literal catalog values cannot also be option values."""
    spans = set()
    values = {
        span
        for definition in schema.attributes
        for option in definition.options
        for alias in {option.code, option.label, *option.labels.values()}
        for span in _phrase_matches(text, alias)
    }
    values.update(match.span() for match in re.finditer(r"\d+(?:\.\d+)?", text))
    for start, end in values:
        explicit = explicit_field_for_value(text, schema, start, end)
        if explicit:
            spans.add(explicit[1])
    return tuple(sorted(spans))


def category_parts(category: str) -> list[str]:
    # Split joined departments, preserving multiword department names.
    return list(
        dict.fromkeys(
            part.strip()
            for part in re.split(r"\s*&\s*|\s+and\s+", normalized(category))
            if part.strip()
        )
    )[:4]


def matches_category(product: Product, category: str) -> bool:
    def words(value: str) -> list[str]:
        return [
            word[:-2]
            if word.endswith(("ches", "shes", "sses", "xes", "zes"))
            else word[:-1]
            if len(word) > 3 and word.endswith("s")
            else word
            for word in re.findall(r"\w+", normalized(value))
        ]

    names = [product.category_name, *product.category_names, product.name]
    for part in category_parts(category):
        expected = words(part)
        if expected and any(
            any(
                actual[i : i + len(expected)] == expected
                for i in range(len(actual) - len(expected) + 1)
            )
            for actual in map(words, names)
        ):
            return True
    return False


def values(product: Product) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for attr in product.attributes:
        try:
            value = json.loads(attr.value)
        except ValueError:
            value = attr.value
        items = value if isinstance(value, list) else [value]
        result[normalized(attr.name)] = [
            normalized(str(v)) for v in items if isinstance(v, (str, int, float, bool))
        ]
    return result


def schema_value(attribute: SchemaAttribute, raw: str) -> str | int | float | bool:
    if attribute.options:
        matches = [
            o.code
            for o in attribute.options
            if normalized(raw)
            in {
                normalized(o.code),
                normalized(o.label),
                *(normalized(v) for v in o.labels.values()),
            }
        ]
        if len(matches) != 1:
            raise ValueError("Unknown or ambiguous managed option")
        return matches[0]
    if attribute.data_type == "boolean":
        if normalized(raw) not in {"true", "false"}:
            raise ValueError("Invalid boolean")
        return normalized(raw) == "true"
    if attribute.data_type in {"integer", "decimal", "measurement", "price"}:
        text = raw.strip()
        if attribute.unit and text.endswith(" " + attribute.unit):
            text = text[: -(len(attribute.unit) + 1)]
        number = Decimal(text)
        if not number.is_finite() or (
            attribute.data_type == "integer" and number != number.to_integral()
        ):
            raise ValueError("Invalid numeric constraint")
        if (attribute.min is not None and number < Decimal(str(attribute.min))) or (
            attribute.max is not None and number > Decimal(str(attribute.max))
        ):
            raise ValueError("Constraint outside schema bounds")
        return int(number) if attribute.data_type == "integer" else float(number)
    return raw


def structured_filters(
    constraints: list[Constraint],
    schema: CatalogSchema,
    *,
    allow_evidence_only: bool = False,
) -> dict[str, str | int | float | bool]:
    filters: dict[str, str | int | float | bool] = {}
    validated: dict[str, str | int | float | bool] = {}
    for constraint in constraints:
        definitions = [
            d
            for d in schema.attributes
            if normalized(constraint.name) in {normalized(d.code), normalized(d.label)}
            and (d.filterable or allow_evidence_only)
        ]
        if len(definitions) != 1:
            raise ValueError("Unknown or unavailable catalog filter")
        definition = definitions[0]
        value = schema_value(definition, constraint.value)
        if constraint.operator in {
            "gt",
            "gte",
            "lt",
            "lte",
        } and definition.data_type not in {
            "integer",
            "decimal",
            "measurement",
            "price",
        }:
            raise ValueError("Range predicate requires a numeric field")
        if (
            constraint.operator == "eq"
            and definition.code in validated
            and validated[definition.code] != value
        ):
            raise ValueError("Conflicting constraints")
        if constraint.operator == "eq":
            validated[definition.code] = value
        if definition.filterable and constraint.operator in {"eq", "contains"}:
            filters[definition.code] = value
        constraint.name = definition.code
        constraint.value = str(value)
    return filters


def numeric_constraints(
    message: str,
    schema: CatalogSchema,
) -> list[tuple[Constraint, tuple[int, int]]]:
    """Literal typed comparisons, including units, for any runtime field."""
    ops = comparison_pattern("attribute", include_symbols=True)
    rows: list[tuple[Constraint, tuple[int, int]]] = []
    category_spans = literal_category_spans(message, schema)
    quoted_spans = tuple(
        match.span() for match in re.finditer(r'"[^"\n]*"|“[^”\n]*”', message)
    )
    for definition in schema.attributes:
        if not definition.filterable or definition.data_type not in {
            "integer",
            "decimal",
            "measurement",
            "price",
        }:
            continue
        aliases = {normalized(definition.code), normalized(definition.label)}
        short_aliases: set[str] = set()
        if definition.unit:
            suffix = " " + normalized(definition.unit)
            short_aliases = {
                alias[: -len(suffix)] for alias in aliases if alias.endswith(suffix)
            } - aliases
        names = "|".join(
            re.escape(alias).replace(r"\ ", r"[ _]+")
            for alias in sorted(aliases, key=len, reverse=True)
            if alias
        )
        unit = rf"(?:\s*{re.escape(definition.unit)})?" if definition.unit else ""
        name_pattern = rf"(?:{names})"
        # A shortened label such as Storage cannot read '1 TB SSD' as 1 GB.
        # Require its declared unit; the complete code/label is unambiguous.
        short_names = "|".join(
            re.escape(alias) for alias in sorted(short_aliases, key=len, reverse=True)
        )
        patterns = [
            rf"(?<!\w){name_pattern}\s*[:=]?\s*(?:({ops})\s*)?(\d+(?:\.\d{{1,6}})?){unit}(?!\w|\.\d)"
        ]
        if short_names and definition.unit:
            patterns.append(
                rf"(?<!\w)(?:{short_names})\s*[:=]?\s*(?:({ops})\s*)?(\d+(?:\.\d{{1,6}})?)\s*{re.escape(definition.unit)}(?!\w|\.\d)"
            )
        hits = [
            match
            for pattern in patterns
            for match in re.finditer(pattern, message, re.IGNORECASE)
        ]
        for match in hits:
            if any(
                left < match.end() and match.start() < right
                for left, right in quoted_spans
            ):
                continue
            if any(
                left <= match.start() and match.end() <= right
                for left, right in category_spans
            ):
                continue
            explicit = explicit_field_for_value(
                message, schema, match.start(2), match.end(2)
            )
            if explicit and explicit[0].code != definition.code:
                continue
            # A code can imply its declared unit when omitted, but an explicit
            # different unit must never be read as that unit (1 TB != 1 GB).
            trailing = message[match.end() :]
            if definition.unit and re.match(
                r"\s*(?:[kmgt]?b|[mkc]?g|mm|cm|m|ml|l|mah|wh|hz|khz|mhz|ghz|inch(?:es)?|in|ct|karats?)\b",
                trailing,
                re.IGNORECASE,
            ):
                raise ValueError("Please use the catalog field's declared unit")
            operator = comparison_operator(match[1]) if match[1] else "eq"
            if re.search(
                r"\b(?:not|without|exclude)\s*$",
                message[: explicit[1][0] if explicit else match.start()],
                re.IGNORECASE,
            ):
                if operator != "eq":
                    raise ValueError("Negated range requires clarification")
                operator = "neq"
            rows.append(
                (
                    Constraint(name=definition.code, value=match[2], operator=operator),
                    match.span(),
                )
            )
    return rows


def preserve_schema_constraints(
    message: str, constraints: list[Constraint], schema: CatalogSchema
) -> list[Constraint]:
    result = list(constraints)
    text = normalized(message)
    category_spans = literal_category_spans(text, schema)
    field_label_spans = explicit_field_label_spans(text, schema)
    candidates: dict[str, list[tuple[SchemaAttribute, str]]] = {}
    preferred_values: set[tuple[str, str]] = set()
    required_values: set[tuple[str, str]] = set()
    explicit_clauses: list[tuple[str, tuple[int, int]]] = []
    for definition in schema.attributes:
        if not definition.filterable:
            continue
        # Prefer a complete option phrase over contained words ("rose gold" vs "gold").
        # A separate occurrence of the shorter option still remains a conflict.
        aliases = sorted(
            {
                (normalized(alias), option.code)
                for option in definition.options
                for alias in {option.code, option.label, *option.labels.values()}
            },
            key=lambda item: -len(item[0]),
        )
        spans: list[tuple[int, int]] = []
        for alias, code in aliases:
            hits = [
                match.span()
                for match in re.finditer(
                    r"(?<!\w)" + re.escape(alias) + r"(?!\w)", text
                )
            ]
            remaining = [
                (start, end)
                for start, end in hits
                if not any(
                    left <= start and end <= right and (left, right) != (start, end)
                    for left, right in spans
                )
                and not any(
                    left <= start and end <= right for left, right in category_spans
                )
                and not any(
                    left <= start and end <= right for left, right in field_label_spans
                )
                and (
                    (explicit := explicit_field_for_value(text, schema, start, end))
                    is None
                    or explicit[0].code == definition.code
                )
            ]
            if remaining:
                candidates.setdefault(alias, []).append((definition, code))
                spans.extend(remaining)
                for start, end in remaining:
                    explicit = explicit_field_for_value(text, schema, start, end)
                    if explicit:
                        explicit_clauses.append(
                            (definition.code, (explicit[1][0], end))
                        )
                    destination = (
                        preferred_values
                        if literal_preference(
                            text, explicit[1][0] if explicit else start
                        )
                        else required_values
                    )
                    destination.add((definition.code, code))
    numeric = numeric_constraints(text, schema)
    managed_numeric = {c.name for c, _ in numeric}
    # A provider's generic Size=6 must not survive beside an authoritative
    # "Ring size US 6" interpretation. Only suppress an actually nested field,
    # and retain separately expressed clauses for that generic field.
    shadowed = set()
    explicit_clauses.extend((c.name, span) for c, span in numeric)
    explicit_fields = {code for code, _ in explicit_clauses}
    for code, span in explicit_clauses:
        for other in schema.attributes:
            if other.code == code or other.code in explicit_fields:
                continue
            if any(
                a >= span[0] and b <= span[1]
                for alias in {other.code, other.label}
                for a, b in _phrase_matches(text, alias)
            ):
                shadowed.add(other.code)
    result = [c for c in result if c.name not in managed_numeric | shadowed]
    result.extend(c for c, (start, _) in numeric if not literal_preference(text, start))
    for alias, matches in candidates.items():
        unique = {(d.code, value): d for d, value in matches}
        if len(unique) != 1:
            # Ambiguous values need an explicit schema field in the model plan.
            if not any((c.name, c.value) in unique for c in result):
                raise ValueError("Ambiguous option")
            continue
        (code, value), definition = next(iter(unique.items()))
        if (code, value) in preferred_values - required_values:
            result = [
                c
                for c in result
                if not (c.name == code and normalized(c.value) == normalized(value))
            ]
            continue
        if definition.source_policy == "semantic" and not re.search(
            r"\bmust\b|\brequired\b", text
        ):
            continue
        field_names = "|".join(
            re.escape(normalized(n)) for n in (definition.code, definition.label)
        )
        negative = bool(
            re.search(
                r"\b(?:not|without|exclude)\s+(?:(?:"
                + field_names
                + r")\s*[:=]?\s*)?"
                + re.escape(alias),
                text,
            )
        )
        if any(
            c.name == code
            and normalized(c.value) == normalized(value)
            and c.operator == "neq"
            for c in result
        ):
            negative = True
        if any(
            c.name == code
            and c.operator == "eq"
            and not negative
            and normalized(c.value) != normalized(value)
            for c in result
        ):
            # Multiple distinct literal values cannot be silently collapsed to one scalar.
            raise ValueError("Conflicting managed option")
        if not any(
            c.name == code and c.operator == ("neq" if negative else "eq")
            for c in result
        ):
            result.append(
                Constraint(name=code, value=value, operator="neq" if negative else "eq")
            )
    return result


def matches_attribute(
    product: Product, constraint: Constraint, *, allow_inferred: bool = False
) -> bool:
    evidence = attribute_evidence(
        product, constraint.name, constraint.value, allow_inferred=allow_inferred
    )
    # JSON 200 and 200.0 express the same numeric fact. Preserve strict types
    # while matching exact Decimal values consistently with backend predicates.
    numeric_rows = [
        row
        for row in product.attributes
        if normalized(row.name) == normalized(constraint.name)
        and (allow_inferred or row.source not in {"DERIVED", "AI_INFERRED"})
    ]
    numeric_values = []
    for row in numeric_rows:
        try:
            raw = json.loads(row.value)
        except ValueError:
            break
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            break
        numeric_values.append(Decimal(str(raw)))
    else:
        if (
            numeric_values
            and len(set(numeric_values)) == 1
            and constraint.operator in {"eq", "neq"}
        ):
            try:
                wanted = Decimal(constraint.value)
            except InvalidOperation:
                return False
            if not wanted.is_finite() or not numeric_values[0].is_finite():
                return False
            return (
                (numeric_values[0] == wanted)
                if constraint.operator == "eq"
                else (numeric_values[0] != wanted)
            )
    if constraint.operator in {"eq", "contains"}:
        return evidence.status == "verified"
    if constraint.operator == "neq":
        return evidence.status == "contradicted"
    rows = [
        a
        for a in product.attributes
        if normalized(a.name) == normalized(constraint.name)
        and (allow_inferred or a.source not in {"DERIVED", "AI_INFERRED"})
    ]
    actual_values = []
    for row in rows:
        try:
            raw = json.loads(row.value)
        except ValueError:
            return False
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            return False
        actual_values.append(Decimal(str(raw)))
    if not actual_values or len(set(actual_values)) != 1:
        return False
    try:
        wanted = Decimal(constraint.value)
    except InvalidOperation:
        return False
    actual = actual_values[0]
    if not wanted.is_finite() or not actual.is_finite():
        return False
    return {
        "gt": actual > wanted,
        "gte": actual >= wanted,
        "lt": actual < wanted,
        "lte": actual <= wanted,
    }.get(constraint.operator, False)


def mismatches(
    product: Product, plan: ShoppingIntent, reference: Product | None
) -> list[str]:
    failures = []
    price = Decimal(product.price)
    if plan.currency and product.currency != plan.currency:
        failures.append("currency")
    if plan.min_price is not None and (
        price < Decimal(plan.min_price)
        or (plan.exclusive_min and price == Decimal(plan.min_price))
    ):
        failures.append("minimum budget")
    if plan.max_price is not None and (
        price > Decimal(plan.max_price)
        or (plan.exclusive_max and price == Decimal(plan.max_price))
    ):
        failures.append("maximum budget")
    if (
        plan.category
        and not plan.category_id
        and not matches_category(product, plan.category)
    ):
        failures.append("category")
    if plan.brand and not matches_attribute(
        product, Constraint(name="brand", value=plan.brand)
    ):
        failures.append("brand")
    for constraint in plan.attributes:
        evidence = attribute_evidence(product, constraint.name, constraint.value)
        if not matches_attribute(product, constraint):
            failures.append(f"{constraint.name}={constraint.value} ({evidence.status})")
    # Composite listings are not proof that one purchasable SKU has the required combination.
    if product.product_type != "simple":
        failures.append("select a specific SKU")
    if plan.in_stock and product.in_stock is not True:
        failures.append("verified stock")
    if reference and (
        product.id == reference.id
        or product.category_id != reference.category_id
        or product.currency != reference.currency
        or price >= Decimal(reference.price)
    ):
        failures.append("same category and currency, strictly cheaper")
    return failures
