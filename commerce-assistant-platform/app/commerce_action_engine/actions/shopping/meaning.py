"""Adapters from bounded customer text and catalog facts to the pure meaning engines."""

import json
import re
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Literal, cast

from app.commerce_action_engine.actions.catalog import CatalogSchema, Product
from app.commerce_action_engine.contracts.action import ActorContext, Freshness
from app.commerce_action_engine.execution.agents import Principal
from app.commerce_action_engine.execution.core.meaning import (
    Clarification,
    ConstraintFrame,
    Requirement,
    Span,
    Value,
    clarify,
    merge_requirements,
    verify,
)
from app.commerce_action_engine.execution.core.policy import (
    Action,
    PolicyDecision,
    PolicyFacts,
    evaluate,
)
from app.commerce_contracts.comparisons import (
    intersect_bound,
)
from app.commerce_resolution_engine.contracts import Message

if TYPE_CHECKING:
    from app.commerce_action_engine.actions.shopping import ShoppingIntent


class MeaningConflict(ValueError):
    pass


def literal_requirements(
    text: str, schema: CatalogSchema, turn: int = 0
) -> tuple[Requirement, ...]:
    rows: list[Requirement] = []
    from .constraints import (
        explicit_field_for_value,
        explicit_field_label_spans,
        literal_category_spans,
        literal_preference,
    )

    category_spans = literal_category_spans(text, schema)
    field_label_spans = explicit_field_label_spans(text, schema)

    def add(
        field: str,
        value: Value,
        match: re.Match[str],
        operator: Literal["eq", "neq", "required", "lt", "lte", "gt", "gte"] = "eq",
        soft: bool = False,
        scope: Literal["product", "basket", "delivery", "action", "goal"] = "product",
    ) -> None:
        rows.append(
            Requirement(
                field=field,
                scope=scope,
                operator=operator,
                value=value,
                strength="soft" if soft else "hard",
                source="current_customer",
                confidence=1.0,
                evidence=(Span(turn=turn, start=match.start(), end=match.end()),),
            )
        )

    for definition in schema.attributes:
        if not definition.filterable:
            continue
        option_matches = []
        for option in definition.options:
            aliases = {
                option.code.replace("_", " "),
                option.label,
                *option.labels.values(),
            }
            pattern = (
                r"(?<!\w)(?:"
                + "|".join(
                    re.escape(a) for a in sorted(aliases, key=len, reverse=True) if a
                )
                + r")(?!\w)"
            )
            for match in re.finditer(pattern, text, re.IGNORECASE):
                option_matches.append((option, match))
        for option, match in option_matches:
            if any(
                left <= match.start() and match.end() <= right
                for left, right in (*category_spans, *field_label_spans)
            ):
                continue
            if any(
                other.start() <= match.start()
                and match.end() <= other.end()
                and other.span() != match.span()
                for _, other in option_matches
            ):
                continue
            prefix = re.split(r"[,;.!]", text[: match.start()])[-1]
            explicit = explicit_field_for_value(
                text, schema, match.start(), match.end()
            )
            if explicit and explicit[0].code != definition.code:
                continue
            soft = literal_preference(
                text, explicit[1][0] if explicit else match.start()
            )
            negative = bool(
                re.search(
                    r"\b(?:not|no|without|exclude|excluding)\s*$",
                    re.split(r"[,;.!]", text[: explicit[1][0]])[-1]
                    if explicit
                    else prefix,
                    re.IGNORECASE,
                )
            )
            if (
                definition.source_policy == "semantic"
                and not explicit
                and not re.search(r"\b(?:must|required|only)\b", prefix, re.IGNORECASE)
            ):
                soft = True
            add(
                definition.code,
                Value(kind="text", text=option.code),
                match,
                "neq"
                if negative
                else "required"
                if definition.data_type == "multiselect"
                else "eq",
                soft and not negative,
            )
    from .constraints import numeric_constraints

    try:
        numeric = numeric_constraints(text, schema)
    except ValueError as error:
        raise MeaningConflict(str(error)) from error
    for constraint, (start, end) in numeric:
        assert constraint.operator != "contains"
        rows.append(
            Requirement(
                field=constraint.name,
                scope="product",
                operator=constraint.operator,
                value=Value(kind="number", number=constraint.value),
                strength="soft" if literal_preference(text, start) else "hard",
                source="current_customer",
                confidence=1.0,
                evidence=(Span(turn=turn, start=start, end=end),),
            )
        )
    from .quantity_language import quantity_comparisons

    try:
        quantities = quantity_comparisons(text)
    except ValueError as error:
        raise MeaningConflict(str(error)) from error
    from .pricing import iter_price_bounds

    try:
        price_bounds = iter_price_bounds(
            text,
            ignore_spans=tuple(span for _, span in numeric)
            + tuple((quantity.start, quantity.end) for quantity in quantities),
        )
    except ValueError as error:
        raise MeaningConflict(str(error)) from error
    for bound in price_bounds:
        # Money meaning requires an explicit currency. Store defaults and the
        # scope of unqualified amounts remain the price/basket adapters' work.
        if bound.currency is None:
            continue
        rows.append(
            Requirement(
                field="price",
                scope="product",
                operator=bound.operator,
                value=Value(kind="money", number=bound.amount, unit=bound.currency),
                strength="hard",
                source="current_customer",
                confidence=1.0,
                evidence=(Span(turn=turn, start=bound.start, end=bound.end),),
            )
        )
    for match in re.finditer(r"\b(?:in stock|available now)\b", text, re.IGNORECASE):
        add("in_stock", Value(kind="boolean", boolean=True), match)
    for quantity in quantities:
        rows.append(
            Requirement(
                field="quantity",
                scope="basket",
                operator=quantity.operator,
                value=Value(
                    kind="quantity", number=quantity.amount, unit=quantity.unit
                ),
                strength="hard",
                source="current_customer",
                confidence=1.0,
                evidence=(Span(turn=turn, start=quantity.start, end=quantity.end),),
            )
        )
    for match in re.finditer(
        r"\bdelivery\s+(before|after|by|on)\s+(\d{4}-\d{2}-\d{2})\b",
        text,
        re.IGNORECASE,
    ):
        try:
            timestamp = str(
                int(
                    datetime.strptime(match[2], "%Y-%m-%d")
                    .replace(tzinfo=UTC)
                    .timestamp()
                )
            )
        except ValueError:
            raise MeaningConflict("Please provide a valid delivery date.") from None
        delivery_ops: dict[str, Literal["lt", "gt", "lte", "eq"]] = {
            "before": "lt",
            "after": "gt",
            "by": "lte",
            "on": "eq",
        }
        op = delivery_ops[match[1].lower()]
        add(
            "delivery_at",
            Value(kind="time", number=timestamp, unit="unix_seconds"),
            match,
            op,
            scope="delivery",
        )
    return tuple(rows)


def interpret(
    message: str, schema: CatalogSchema, history: tuple[Message, ...] = ()
) -> ConstraintFrame:
    previous: tuple[Requirement, ...] = ()
    continuation = bool(
        re.match(
            r"\s*(?:actually|instead|also|change|make that)\b", message, re.IGNORECASE
        )
    )
    if continuation:
        for i, row in enumerate(history[-6:]):
            if row.role == "user":
                current = literal_requirements(row.text, schema, i)
                replacing = (
                    frozenset(r.field for r in current)
                    if re.match(
                        r"\s*(?:actually|instead|change|make that)\b",
                        row.text,
                        re.IGNORECASE,
                    )
                    else frozenset()
                )
                previous = merge_requirements(
                    previous, current, replace_fields=replacing
                ).requirements
        previous = tuple(r.model_copy(update={"source": "session"}) for r in previous)
    current = literal_requirements(message, schema, len(history[-6:]))
    replacing = (
        frozenset(r.field for r in current)
        if continuation and not re.match(r"\s*also\b", message, re.IGNORECASE)
        else frozenset()
    )
    # A terse brand update preserves the prior preference's strength; other fields survive.
    current = tuple(
        r.model_copy(update={"strength": "soft"})
        if r.field in replacing
        and any(old.field == r.field and old.strength == "soft" for old in previous)
        and not re.search(r"\b(?:must|required|only)\b", message, re.IGNORECASE)
        else r
        for r in current
    )
    return merge_requirements(previous, current, replace_fields=replacing)


def apply_meaning(
    plan: "ShoppingIntent",
    message: str,
    schema: CatalogSchema,
    history: tuple[Message, ...] = (),
    *,
    record_meaning: Callable[[ConstraintFrame, Clarification], None] | None = None,
) -> ConstraintFrame:
    from app.commerce_action_engine.actions.shopping import (
        Constraint,
        preserve_schema_constraints,
        structured_filters,
    )

    frame = interpret(message, schema, history)
    decision = clarify(frame)
    if record_meaning is not None:
        record_meaning(frame, decision)
    if decision.required:
        fields = ", ".join(decision.fields)
        raise MeaningConflict(
            f"Your requirements conflict for {fields}. Which value or range should I use?"
        )
    managed = {r.field for r in frame.requirements}
    # Field labels from language are aliases of the current merchant schema.
    # Canonicalize names before replacing constraints interpreted from their spans.
    from .constraints import literal_preference, normalized, schema_value

    for attribute in plan.attributes:
        definitions = [
            d
            for d in schema.attributes
            if normalized(attribute.name) in {normalized(d.code), normalized(d.label)}
        ]
        if len(definitions) == 1:
            attribute.name = definitions[0].code
    # The legacy schema guard still checks unhandled explicit numeric/unknown constraints.
    remaining = [a for a in plan.attributes if a.name not in managed]
    masked = list(message)
    for requirement in frame.requirements:
        for span in requirement.evidence:
            if span.turn == len(history[-6:]):
                masked[span.start : span.end] = " " * (span.end - span.start)
    literal = preserve_schema_constraints("".join(masked), remaining, schema)
    literal = [a for a in literal if a.name not in managed]
    # Provider-proposed values need literal customer evidence to become hard.
    additions = []
    plan.attributes = []
    for attribute in literal:
        match = re.search(
            r"(?<!\w)" + re.escape(attribute.value) + r"(?!\w)", message, re.IGNORECASE
        )
        soft = literal_preference(message, match.start()) if match else False
        strength: Literal["soft", "hard", "inferred"] = (
            "soft" if soft else "hard" if match else "inferred"
        )
        definition = next(
            (d for d in schema.attributes if d.code == attribute.name), None
        )
        # Labeled language values arrive as strings, while catalog numeric facts
        # are JSON numbers. Keep the schema's type through evidence verification.
        value = (
            Value(kind="number", number=str(schema_value(definition, attribute.value)))
            if definition is not None
            and definition.data_type in {"integer", "decimal", "measurement", "price"}
            else Value(kind="text", text=attribute.value)
        )
        # A selected multiselect option means membership, even when the
        # catalog filter arrives as equality. Keep scalar equality strict.
        requirement = Requirement(
            field=attribute.name,
            operator="required"
            if attribute.operator == "contains"
            or (
                attribute.operator == "eq"
                and definition is not None
                and definition.data_type == "multiselect"
            )
            else attribute.operator,
            value=value,
            strength=strength,
            source="current_customer" if match else "model",
            confidence=1.0 if match else 0.5,
            evidence=(
                Span(turn=len(history[-6:]), start=match.start(), end=match.end()),
            )
            if match
            else (),
        )
        additions.append(requirement)
        (plan.attributes if strength == "hard" else plan.preferences).append(attribute)
    frame = merge_requirements(frame.requirements, tuple(additions))
    plan.preferences = [a for a in plan.preferences if a.name not in managed]
    for r in frame.requirements:
        if r.field == "price":
            plan.currency = r.value.unit
            amount = r.value.number or "0"
            if r.operator in {"eq", "lt", "lte"}:
                plan.max_price, plan.exclusive_max = intersect_bound(
                    plan.max_price,
                    plan.exclusive_max,
                    amount,
                    r.operator == "lt",
                    "max",
                )
            if r.operator in {"eq", "gt", "gte"}:
                plan.min_price, plan.exclusive_min = intersect_bound(
                    plan.min_price,
                    plan.exclusive_min,
                    amount,
                    r.operator == "gt",
                    "min",
                )
        elif r.field == "in_stock":
            plan.in_stock = True
        elif r.operator in {"eq", "required", "neq", "gt", "gte", "lt", "lte"}:
            operator = cast(
                Literal["eq", "contains", "neq", "gt", "gte", "lt", "lte"],
                "contains" if r.operator == "required" else r.operator,
            )
            row = Constraint(
                name=r.field,
                value=r.value.text or r.value.number or "",
                operator=operator,
            )
            (plan.attributes if r.strength == "hard" else plan.preferences).append(row)
    # Contradictory model additions never silently weaken explicit constraints.
    structured_filters(plan.attributes, schema, allow_evidence_only=True)
    # Retrieval should not require a soft brand token to appear in the product name.
    for r in frame.requirements:
        if r.strength != "hard" and r.value.text:
            plan.query = re.sub(
                r"\b" + re.escape(r.value.text) + r"\b",
                "",
                plan.query,
                flags=re.IGNORECASE,
            ).strip()
    if not plan.query:
        plan.query = "*"
    return frame


def product_facts(product: Product) -> dict[str, Value]:
    facts = {
        "price": Value(kind="money", number=product.price, unit=product.currency),
    }
    if product.in_stock is not None:
        facts["in_stock"] = Value(kind="boolean", boolean=product.in_stock)
    seen: set[str] = set()
    for attribute in product.attributes:
        if attribute.name in {"price", "in_stock"}:
            continue
        if attribute.name in seen:
            facts.pop(attribute.name, None)
            continue
        seen.add(attribute.name)
        if attribute.source in {"AI_INFERRED", "DERIVED"}:
            continue
        try:
            value = json.loads(attribute.value)
        except (ValueError, TypeError):
            continue
        if isinstance(value, bool):
            facts[attribute.name] = Value(kind="boolean", boolean=value)
        elif isinstance(value, (int, float)):
            facts[attribute.name] = Value(kind="number", number=str(value))
        elif isinstance(value, str) and 0 < len(value) <= 200:
            facts[attribute.name] = Value(kind="text", text=value)
        elif (
            isinstance(value, list) and value and all(isinstance(v, str) for v in value)
        ):
            facts[attribute.name] = Value(kind="set", items=tuple(value))
    return facts


def verified_products(
    products: list[Product],
    frame: ConstraintFrame,
    *,
    on_checks: Callable[[list[dict[str, object]]], None] | None = None,
) -> list[Product]:
    now = int(time.time())
    freshness = Freshness(observed_at=now, expires_at=now + 30)
    if on_checks is not None:
        # Reuse each actual verification result. Never rerun predicates or change
        # which products are eligible merely because diagnostics are enabled.
        failures = [
            verify(frame, product_facts(p), now=now, freshness=freshness)
            for p in products
        ]
        remaining = set(range(len(products)))
        checks: list[dict[str, object]] = []

        def observe(label: str, rejected: set[int], reason: str) -> None:
            before = len(remaining)
            remaining.difference_update(rejected)
            checks.append(
                {
                    "check": label,
                    "before": before,
                    "after": len(remaining),
                    "rejection_reason": reason,
                    "effect": "ordered_verification_results",
                }
            )

        if frame.conflicts:
            observe(
                "Conflicting requirements",
                set(range(len(products))),
                "requirement_conflict",
            )
        hard = [
            (i, r) for i, r in enumerate(frame.requirements) if r.strength == "hard"
        ]
        for i, requirement in hard[:20]:
            rejected = {
                j
                for j, issues in enumerate(failures)
                if any(i in issue.requirement_indexes for issue in issues)
            }
            label = {"price": "Price", "in_stock": "Stock"}.get(
                requirement.field, requirement.field
            )
            observe(
                f"{label} requirement ({requirement.operator})",
                rejected,
                "requirement_unverified_or_unmet",
            )
        if len(hard) > 20:
            observe(
                "Remaining requirements",
                {i for i, issues in enumerate(failures) if issues},
                "requirements_unverified_or_unmet",
            )
        if not checks:
            observe("Product requirement verification", set(), "no_hard_requirements")
        on_checks(checks)
        return [p for p, issues in zip(products, failures, strict=True) if not issues]
    return [
        p
        for p in products
        if not verify(frame, product_facts(p), now=now, freshness=freshness)
    ]


def assess_action(
    principal: Principal, action: Action, *, request_id: str, now: int | None = None
) -> PolicyDecision:
    """Tenant-bound catalog/proposal adapter. Mutating execution stays at Rust's gate.

    No confirmation or authentication freshness is inferred from user/model text.
    """
    now = int(time.time()) if now is None else now
    tenant = str(principal.tenant)
    # Principal currently carries tenant, not a separately addressable store. Gateway is tenant-isolated.
    context = ActorContext(
        tenant_id=tenant,
        store_id=tenant,
        session_id=request_id,
        request_id=request_id,
        actor_id=str(principal.subject) if principal.subject else None,
        channel="storefront",
    )
    return evaluate(
        PolicyFacts(
            context=context,
            action=action,
            resource_tenant=tenant,
            resource_store=tenant,
            available=True,
            authorized=action in {"catalog_read", "recommend", "cart_apply"},
            evidence_verified=True,
            fresh_until=now + 30,
        ),
        now=now,
    )
