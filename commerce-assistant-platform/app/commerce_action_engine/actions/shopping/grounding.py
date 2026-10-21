"""Catalog-driven read grounding and scoped clarification selection.

Catalog categories/options establish the target. Linguistic quality words only
establish uncertainty, never a product fact or a merchant-defined quality tier.
Unknown modifiers stay required; explicit requirements never become preferences.
"""

import re
from dataclasses import dataclass
from decimal import Decimal

from app.commerce_action_engine.actions.catalog import (
    CatalogProfile,
    CatalogSchema,
    SchemaAttribute,
)

from .constraints import (
    category_phrase_matches as _hits,
)
from .constraints import (
    category_tokens as _tokens,
)
from .constraints import (
    explicit_field_for_value,
    explicit_field_label_spans,
    literal_preference,
    normalized,
    numeric_constraints,
)
from .contracts import (
    Constraint,
    ShoppingChoice,
    ShoppingClarification,
    ShoppingIntent,
    UnresolvedRequirement,
)
from .pricing import iter_price_bounds
from .quantity_language import quantity_comparisons


def observed_schema(
    schema: CatalogSchema, profile: CatalogProfile | None
) -> CatalogSchema:
    """Use current category observations to ground free-text attribute values."""
    if (
        profile is None
        or not profile.complete
        or not profile.facets_complete
        or profile.revision != schema.version
    ):
        return schema
    from app.commerce_action_engine.actions.catalog.contracts import SchemaOption

    result = schema.model_copy(deep=True)
    facets = {f.code: f for f in profile.facets if f.values_complete}
    for definition in result.attributes:
        facet = facets.get(definition.code)
        if (
            not definition.filterable
            or definition.data_type != "text"
            or definition.options
            or facet is None
        ):
            continue
        observed: dict[str, SchemaOption] = {}
        for v in sorted(facet.values, key=lambda item: -item.count):
            if v.count > 0 and isinstance(v.value, str) and 0 < len(v.value) <= 100:
                observed.setdefault(
                    normalized(v.value),
                    SchemaOption(code=v.value, label=v.label or v.value, labels={}),
                )
        definition.options = list(observed.values())
    return result


# Language semantics shared by every catalog, not store-specific attribute/value
# mappings. Every other unmatched modifier requires clarification.
_QUALITY = frozenset(
    {
        "good",
        "great",
        "best",
        "nice",
        "better",
        "top",
        "popular",
        "recommended",
        "luxury",
        "premium",
        "excellent",
        "high-end",
        "high end",
        # Subjective style/appeal, usable across jewelry, devices and personal care.
        "elegant",
        "stylish",
        "chic",
        "classy",
        "sophisticated",
        "beautiful",
        "gorgeous",
        "stunning",
        "lovely",
        "attractive",
        "fashionable",
        "trendy",
        "sleek",
        "refined",
        "fancy",
        "luxurious",
        "exquisite",
        "tasteful",
        # General quality language must not invent a catalog quality tier.
        "amazing",
        "awesome",
        "fantastic",
        "wonderful",
        "impressive",
        "exceptional",
        "outstanding",
        "superb",
        "high-quality",
        "high quality",
        "top-quality",
        "top quality",
        # Subjective food preferences; freshness/dietary/health claims stay strict.
        "delicious",
        "tasty",
        "yummy",
        "appetizing",
        "appetising",
        "flavorful",
        "flavourful",
        "scrumptious",
        "delightful",
    }
)
_GLUE = frozenset(
    {
        "a",
        "an",
        "the",
        "some",
        "any",
        "my",
        "for",
        "with",
        "and",
        "but",
        "of",
        "product",
        "products",
        "item",
        "items",
        "something",
        "anything",
        "please",
        "find",
        "show",
        "me",
        "recommend",
        "need",
        "want",
        "i",
        "without",
        "not",
        "no",
        "only",
        "must",
        "be",
        "required",
        "prefer",
        "preferred",
        "preferably",
        "ideally",
        "if",
        "possible",
    }
)


@dataclass(frozen=True)
class GroundedDiscovery:
    frame: ShoppingIntent
    literal_query: str | None = None
    required_constraints: tuple[Constraint, ...] = ()


def ground_request(
    plan: ShoppingIntent,
    message: str,
    schema: CatalogSchema,
    *,
    product_text: str | None = None,
) -> GroundedDiscovery:
    """Split a schema-backed target from descriptors without guessing facts.

    The caller probes literal identity before accepting the decomposed frame. If no
    target is known, keep lexical retrieval, including cross-store product requests.
    """
    frame = plan.model_copy(deep=True)
    if not frame.shopping or frame.presentation not in {"search", "recommend"}:
        return GroundedDiscovery(frame)
    initial_browse = frame.query == "*"
    query = (
        (product_text if product_text and product_text.strip() != "*" else None)
        or (frame.category if initial_browse else frame.query)
        or ""
    ).strip()
    if not query or query == "*" or len(query) > 200:
        return GroundedDiscovery(frame)
    if '"' in query or "“" in query or "”" in query:
        return GroundedDiscovery(frame)
    if any(
        normalized(query) == normalized(match[1])
        for match in re.finditer(r'["“]([^"”\n]+)["”]', message)
    ):
        return GroundedDiscovery(frame)
    try:
        numeric = numeric_constraints(message, schema)
    except ValueError:
        return GroundedDiscovery(plan.model_copy(deep=True))
    covered: list[tuple[int, int]] = list(explicit_field_label_spans(query, schema))
    for constraint, _ in numeric:
        definition = next(d for d in schema.attributes if d.code == constraint.name)
        covered.extend(_hits(query, definition.code))
        covered.extend(_hits(query, definition.label))
    grounded_constraints = []
    categories = []
    for category in schema.categories:
        spans = [
            hit
            for alias in {category.name, *category.aliases}
            for hit in _hits(query, alias)
            if not any(left <= hit[0] and hit[1] <= right for left, right in covered)
        ]
        if spans:
            categories.append(
                (max(end - start for start, end in spans), category, spans)
            )
    if categories:
        longest = max(item[0] for item in categories)
        winners = [item for item in categories if item[0] == longest]
        if len({item[1].id for item in winners}) != 1:
            return GroundedDiscovery(frame)
        _, category, spans = winners[0]
        frame.category_id = str(category.id)
        frame.category = category.name
        covered.extend(spans)
        # A schema-matched category may be introduced by structural wording.
        # Cover only the label directly before that category, not arbitrary
        # unknown words or independent requirements elsewhere in the request.
        for start, _ in spans:
            label = re.search(
                r"\b(?:(?:in|from)\s+(?:the\s+)?)?category\s*:?\s*$",
                query[:start],
                re.IGNORECASE,
            )
            if label:
                covered.append(label.span())

    # Runtime options supply target/use/brand/features, including new demos.
    option_hits: dict[tuple[int, int], list[tuple[SchemaAttribute, str]]] = {}
    for definition in schema.attributes:
        if not definition.filterable:
            continue
        for option in definition.options:
            for alias in {
                option.code.replace("_", " "),
                option.label,
                *option.labels.values(),
            }:
                for span in _hits(query, alias):
                    option_hits.setdefault(span, []).append((definition, option.code))
    target = bool(frame.category_id)
    purpose_matched = False
    classification_matched = False
    ambiguous_spans: list[tuple[int, int]] = []
    for (start, end), entries in sorted(
        option_hits.items(), key=lambda item: -(item[0][1] - item[0][0])
    ):
        if any(left <= start and end <= right for left, right in covered):
            continue
        explicit_field = explicit_field_for_value(query, schema, start, end)
        if explicit_field is not None:
            entries = [
                (definition, value)
                for definition, value in entries
                if definition.code == explicit_field[0].code
            ]
        unique = {(definition.code, value): definition for definition, value in entries}
        if len(unique) != 1:
            if len(unique) > 1:
                ambiguous_spans.append((start, end))
            continue
        (code, value), definition = next(iter(unique.items()))
        if explicit_field is None:
            # Generic language entities (e.g. Material=silver) cannot override
            # a value observed in a different merchant field (Metal=Silver).
            def keep(c: Constraint, code: str = code, value: str = value) -> bool:
                return (
                    c.name == code
                    or normalized(c.value) != normalized(value)
                    or any(
                        (named := explicit_field_for_value(message, schema, a, b))
                        is not None
                        and named[0].code == c.name
                        for a, b in _hits(message, c.value)
                    )
                )

            frame.attributes = [c for c in frame.attributes if keep(c)]
            frame.preferences = [c for c in frame.preferences if keep(c)]
        if definition.semantic_role in {"classification", "intended_use"}:
            target = True
        prefix_end = explicit_field[1][0] if explicit_field else start
        negative = bool(
            re.search(
                r"\b(?:without|not|no|exclude)\s*$", query[:prefix_end], re.IGNORECASE
            )
        )
        constraint = Constraint(
            name=code, value=value, operator="neq" if negative else "eq"
        )
        source_spans = _hits(message, query[start:end])
        preferred = literal_preference(query, prefix_end)
        if len(source_spans) == 1:
            source_start, source_end = source_spans[0]
            source_field = explicit_field_for_value(
                message, schema, source_start, source_end
            )
            preferred = literal_preference(
                message, source_field[1][0] if source_field else source_start
            )
        if (
            definition.semantic_role == "classification"
            and not frame.category_id
            and not negative
        ):
            frame.category = value
            classification_matched = True
        if definition.semantic_role == "intended_use":
            if not negative and not preferred:
                frame.intended_use = value
                purpose_matched = True
            elif frame.intended_use == value:
                frame.intended_use = None
        # All schema-backed values remain in the normal meaning/constraint path;
        # grounding itself cannot prove a factual modifier or soften a must.
        destination = (
            frame.preferences
            if not negative
            and (preferred or definition.semantic_role == "intended_use")
            else frame.attributes
        )
        if constraint not in destination:
            destination.append(constraint)
        if destination is frame.attributes:
            grounded_constraints.append(constraint.model_copy(deep=True))
        covered.append((start, end))
        if explicit_field is not None:
            covered.append(explicit_field[1])
    if not target and not ambiguous_spans:
        return GroundedDiscovery(plan.model_copy(deep=True))
    if frame.category and not frame.category_id and not classification_matched:
        category_spans = _hits(query, frame.category)
        if category_spans and all(
            any(left <= start and end <= right for left, right in covered)
            for start, end in category_spans
        ):
            # A language noun represented by a real attribute is not a second
            # invented category constraint (e.g. Cream texture in Skincare).
            frame.category = None
    # Managed measurements carry their own unit and must never become money.
    query_numeric = numeric_constraints(query, schema)
    for constraint, span in numeric:
        definition = next(d for d in schema.attributes if d.code == constraint.name)
        covered.extend(_hits(query, definition.code))
        covered.extend(_hits(query, definition.label))
        covered.extend(_hits(query, constraint.value))
        if definition.unit:
            covered.extend(_hits(query, definition.unit))
        for _, query_span in query_numeric:
            covered.append(query_span)
        preferred = literal_preference(message, span[0])
        destination = frame.preferences if preferred else frame.attributes
        if constraint not in destination:
            destination.append(constraint)
        if not preferred and constraint not in grounded_constraints:
            grounded_constraints.append(constraint.model_copy(deep=True))
    covered.extend(_hits(query, "in stock"))
    covered.extend(_hits(query, "available now"))
    # Budget and already-structured values must not become residual adjectives.
    for bound in iter_price_bounds(
        query,
        ignore_spans=tuple(span for _, span in query_numeric)
        + tuple(
            (quantity.start, quantity.end) for quantity in quantity_comparisons(query)
        ),
    ):
        covered.append((bound.start, bound.end))
    for c in [*frame.attributes, *frame.preferences]:
        covered.extend(
            (a, b)
            for a, b in _hits(query, c.value)
            if not any(left < b and a < right for left, right in ambiguous_spans)
        )
    lexical_target = None
    if not target:
        # With no matching category, retain the product-name words for lexical
        # retrieval instead of inventing category membership or browsing '*'.
        name_tokens = [
            token
            for token in re.finditer(r"[\w-]+", query)
            if normalized(token.group()) not in _GLUE
            and not any(
                a <= token.start() and token.end() <= b
                for a, b in covered + ambiguous_spans
            )
        ]
        if not name_tokens:
            return GroundedDiscovery(plan.model_copy(deep=True))
        lexical_target = " ".join(token.group() for token in name_tokens)
        covered.extend((token.start(), token.end()) for token in name_tokens)
    quality_spans = [span for quality in _QUALITY for span in _hits(query, quality)]
    unresolved = []
    for token in re.finditer(r"[\w-]+", query):
        if any(start <= token.start() and token.end() <= end for start, end in covered):
            continue
        word = normalized(token.group())
        if word in _GLUE:
            continue
        source = re.search(
            r"(?<!\w)" + re.escape(token.group()) + r"(?!\w)", message, re.IGNORECASE
        )
        if source is None:
            # Provider words absent from the customer cannot become requirements.
            return GroundedDiscovery(plan.model_copy(deep=True))
        hard = bool(
            re.search(
                r"\b(?:must|required|only|without|not|no)\s+(?:be\s+)?(?:a\s+)?$",
                message[: source.start()],
                re.IGNORECASE,
            )
        )
        unresolved.append(
            UnresolvedRequirement(
                text=source.group(),
                start=source.start(),
                end=source.end(),
                kind="ambiguous"
                if any(
                    start <= token.start() and token.end() <= end
                    for start, end in ambiguous_spans
                )
                else "preference"
                if (
                    word in _QUALITY
                    or any(
                        start <= token.start() and token.end() <= end
                        for start, end in quality_spans
                    )
                )
                and not hard
                else "required",
            )
        )
    if len(unresolved) > 10:
        return GroundedDiscovery(plan.model_copy(deep=True))
    frame.unresolved_requirements = unresolved
    if frame.category_id:
        frame.query = "*"
    elif frame.category:
        frame.query = query if frame.intended_use and not purpose_matched else "*"
    elif frame.intended_use:
        # Existing purpose_filter revalidates the target and the independent
        # meaning path retains concrete attributes such as cream texture.
        frame.query = frame.intended_use
    else:
        frame.query = lexical_target or "*"
    # Broad "something for ..." merits a useful optional refinement too.
    if not unresolved and re.search(
        r"\b(?:something|anything)\b", message, re.IGNORECASE
    ):
        optional_match = re.search(
            r"\b(?:something|anything)\b", message, re.IGNORECASE
        )
        assert optional_match is not None
        frame.unresolved_requirements = [
            UnresolvedRequirement(
                text=optional_match.group(),
                kind="preference",
                start=optional_match.start(),
                end=optional_match.end(),
            )
        ]
    return GroundedDiscovery(
        frame,
        query
        if not initial_browse and frame.query != query and len(_tokens(query)) > 1
        else None,
        tuple(grounded_constraints),
    )


def attribute_clarification(
    plan: ShoppingIntent, message: str, schema: CatalogSchema
) -> ShoppingClarification | None:
    """Ask which schema field a shared value belongs to, one phrase at a time."""
    ambiguous = [r for r in plan.unresolved_requirements if r.kind == "ambiguous"]
    if not ambiguous:
        return None
    first = min(ambiguous, key=lambda r: r.start)
    matches: dict[tuple[str, str], tuple[SchemaAttribute, str, int, int]] = {}
    for definition in schema.attributes:
        if not definition.filterable:
            continue
        for option in definition.options:
            for alias in {
                option.code.replace("_", " "),
                option.label,
                *option.labels.values(),
            }:
                for start, end in _hits(message, alias):
                    if start <= first.start and first.end <= end:
                        matches[(definition.code, option.code)] = (
                            definition,
                            option.label,
                            start,
                            end,
                        )
    if not matches:
        return None
    longest = max(matches.values(), key=lambda item: item[3] - item[2])
    start, end = longest[2:]
    matches = {key: item for key, item in matches.items() if item[2:] == (start, end)}
    if not 2 <= len(matches) <= 8:
        return None
    # Exclusions need a negative filter, not a positive selection.
    if re.search(r"\b(?:not|no|without|exclude)\s*$", message[:start], re.IGNORECASE):
        return None
    resolves = [r for r in ambiguous if start <= r.start and r.end <= end]
    frame = plan.model_copy(deep=True)

    # An inferred field must not preselect the answer. Separately named fields
    # remain explicit requirements and are checked for conflicts on reply.
    def explicit(constraint: Constraint) -> bool:
        return any(
            (field := explicit_field_for_value(message, schema, a, b)) is not None
            and field[0].code == constraint.name
            for a, b in _hits(message, constraint.value)
        )

    inferred_values = {normalized(value) for _, value in matches}
    frame.attributes = [
        c
        for c in frame.attributes
        if normalized(c.value) not in inferred_values or explicit(c)
    ]
    frame.preferences = [
        c
        for c in frame.preferences
        if normalized(c.value) not in inferred_values or explicit(c)
    ]
    for (code, value), (definition, _, _, _) in matches.items():
        if explicit(Constraint(name=code, value=value)):
            continue
        if (
            definition.semantic_role == "brand"
            and frame.brand
            and normalized(frame.brand) == normalized(value)
        ):
            frame.brand = None
        if (
            definition.semantic_role == "intended_use"
            and frame.intended_use
            and normalized(frame.intended_use) == normalized(value)
        ):
            frame.intended_use = None
    labels = [f"{d.label}: {label}"[:120] for d, label, _, _ in matches.values()]
    if len({label.casefold() for label in labels}) != len(labels):
        labels = [f"{code}: {value}"[:120] for code, value in matches]
    if len({label.casefold() for label in labels}) != len(labels):
        return None
    return ShoppingClarification(
        question=f"Which product feature do you mean by ‘{message[start:end]}’?",
        field="attribute",
        choices=[
            ShoppingChoice(label=label, field=code, value=value)
            for label, (code, value) in zip(labels, matches)
        ],
        frame=frame,
        descriptor_revision=schema.version,
        optional=False,
        currency=frame.currency,
        resolves=resolves,
    )


def required_uncertainty(plan: ShoppingIntent) -> str | None:
    required = [r.text for r in plan.unresolved_requirements if r.kind != "preference"]
    if not required:
        return None
    text = ", ".join(dict.fromkeys(required))
    return (
        f"I couldn’t verify the requirement ‘{text}’ from this store’s product information. "
        "Please specify the catalog feature you need, or change that requirement."
    )


def plan_clarification(
    plan: ShoppingIntent,
    schema: CatalogSchema,
    profile: CatalogProfile | None,
) -> ShoppingClarification | None:
    """One optional question using eligible SKU statistics, never card counts."""
    if (
        plan.gift_context
        and not plan.discovery_refined
        and plan.query == "*"
        and not plan.category_id
        and not plan.category
        and not required_uncertainty(plan)
    ):
        available = [
            c for c in schema.categories if c.sellable_count > 0 and len(c.name) <= 100
        ]
        ids = {c.id for c in available}
        roots = [c for c in available if c.parent_id not in ids]
        categories = roots if len(roots) > 1 else available
        if len(categories) > 1:
            return ShoppingClarification(
                question="What type of gift would you like? Choose a category, or show the available options.",
                field="gift_category",
                choices=[
                    ShoppingChoice(label=c.name, value=str(c.id))
                    for c in sorted(
                        categories, key=lambda c: (-c.sellable_count, c.name)
                    )[:5]
                ],
                frame=plan.model_copy(deep=True),
                descriptor_revision=schema.version,
                currency=plan.currency,
            )
    if (
        profile is None
        or not profile.complete
        or profile.revision != schema.version
        or profile.matched_count < 2
        or plan.discovery_refined
        or (not plan.unresolved_requirements and not plan.gift_context)
        or required_uncertainty(plan)
    ):
        return None
    current = {c.name for c in [*plan.attributes, *plan.preferences]}
    prices = [
        p
        for p in profile.prices
        if p.count > 1
        and len(profile.prices) == 1
        and p.count == profile.matched_count
        and Decimal(p.max) > Decimal(p.min)
        and (not plan.currency or p.currency == plan.currency)
    ]
    if len(prices) == 1 and plan.max_price is None and plan.min_price is None:
        price = prices[0]
        midpoint = (Decimal(price.min) + Decimal(price.max)) / 2
        return ShoppingClarification(
            question=(
                "What is your budget for the gift? You can give a maximum amount, or show the available options."
                if plan.gift_context
                else "What is your budget? You can give a maximum amount, or show the available options."
            ),
            field="budget",
            choices=[
                ShoppingChoice(
                    label=f"Up to {midpoint:.2f} {price.currency}",
                    value=f"{midpoint:.2f}",
                    operator="lte",
                )
            ],
            frame=plan.model_copy(deep=True),
            descriptor_revision=profile.revision,
            currency=prices[0].currency,
        )
    fields = {d.code: d for d in schema.attributes if d.filterable}
    usable = []
    for facet in profile.facets:
        definition = fields.get(facet.code)
        if (
            definition is None
            or facet.code in current
            or not facet.values_complete
            or definition.semantic_role == "classification"
            or facet.covered_count < max(2, profile.matched_count / 2)
        ):
            continue
        options = [v for v in facet.values if 0 < v.count < profile.matched_count]
        if len(options) < 2:
            continue
        # Overlapping multiselect memberships are not probabilities. This is a
        # bounded narrowing/coverage proxy, not entropy of disjoint choices.
        reduction = sum(profile.matched_count - v.count for v in options) / len(options)
        score = reduction * facet.covered_count / profile.matched_count
        usable.append((score, facet, options))
    if not usable:
        return None
    _, facet, options = max(usable, key=lambda item: (item[0], item[1].code))
    choices = [
        ShoppingChoice(label=v.label or str(v.value), value=v.value)
        for v in sorted(options, key=lambda value: (-value.count, value.label))[:5]
    ]
    return ShoppingClarification(
        question=f"Which {facet.label.lower()} would you prefer?",
        field=facet.code,
        choices=choices,
        frame=plan.model_copy(deep=True),
        descriptor_revision=profile.revision,
        currency=plan.currency,
    )
