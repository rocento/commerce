"""Commerce meaning extension v1: pure, provider-independent contracts and algebra.

Inputs are typed facts supplied by adapters. No provider, transport or execution authority.
"""

from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.commerce_action_engine.contracts.action import Code, Freshness


class MeaningContract(BaseModel):
    model_config = ConfigDict(
        extra="forbid", frozen=True, strict=True, allow_inf_nan=False
    )
    schema_version: Literal["1.0"] = "1.0"


class Span(MeaningContract):
    turn: int = Field(ge=0)
    start: int = Field(ge=0)
    end: int = Field(ge=1)

    @model_validator(mode="after")
    def ordered(self) -> "Span":
        if self.end <= self.start:
            raise ValueError("Empty evidence span")
        return self


class Value(MeaningContract):
    kind: Literal[
        "text", "number", "money", "quantity", "time", "set", "boolean", "reference"
    ]
    text: str | None = Field(default=None, min_length=1, max_length=200)
    number: Annotated[str, Field(pattern=r"^-?\d{1,18}(\.\d{1,6})?$")] | None = None
    unit: str | None = Field(default=None, min_length=1, max_length=30)
    items: tuple[str, ...] = Field(default=(), max_length=30)
    boolean: bool | None = None

    @model_validator(mode="after")
    def shape(self) -> "Value":
        numeric = self.kind in {"number", "money", "quantity", "time"}
        if numeric != (self.number is not None):
            raise ValueError("Numeric kind/value mismatch")
        if (self.kind in {"text", "reference"}) != (self.text is not None):
            raise ValueError("Text kind/value mismatch")
        if (self.kind == "boolean") != (self.boolean is not None):
            raise ValueError("Boolean kind/value mismatch")
        if (self.kind == "set") != bool(self.items):
            raise ValueError("Set kind/value mismatch")
        if (self.kind in {"money", "quantity", "time"}) != (self.unit is not None):
            raise ValueError("Unit kind/value mismatch")
        return self


Source = Literal[
    "current_customer",
    "session",
    "durable_goal",
    "explicit_preference",
    "observed_behavior",
    "merchant_policy",
    "industry_policy",
    "system_safety",
    "model",
]
PROTECTED = {"merchant_policy", "industry_policy", "system_safety"}


class Requirement(MeaningContract):
    field: Code
    operator: Literal[
        "eq",
        "neq",
        "lt",
        "lte",
        "gt",
        "gte",
        "in",
        "not_in",
        "required",
        "forbidden",
        "compatible",
    ]
    value: Value
    strength: Literal["hard", "soft", "inferred"]
    source: Source
    scope: Literal["product", "basket", "delivery", "action", "goal"] = "product"
    confidence: float = Field(ge=0, le=1)
    evidence: tuple[Span, ...] = Field(default=(), max_length=10)
    freshness: Freshness | None = None

    @model_validator(mode="after")
    def valid(self) -> "Requirement":
        if self.source in {"model", "observed_behavior"} and self.strength == "hard":
            raise ValueError("Inference cannot create a hard requirement")
        if self.source in PROTECTED and self.strength != "hard":
            raise ValueError("Authority restrictions must be hard")
        if self.operator in {"lt", "lte", "gt", "gte"} and self.value.number is None:
            raise ValueError("Ordered constraints need numeric values")
        if self.operator in {"in", "not_in"} and self.value.kind != "set":
            raise ValueError("Membership needs a set")
        if self.operator == "compatible" and self.value.kind != "reference":
            raise ValueError("Compatibility needs a reference")
        return self


ConflictCode = Literal["contradiction", "unit_mismatch", "unknown_fact", "stale_fact"]


class Conflict(MeaningContract):
    field: Code
    scope: str
    code: ConflictCode
    requirement_indexes: tuple[int, ...]


class ConstraintFrame(MeaningContract):
    requirements: tuple[Requirement, ...] = Field(default=(), max_length=100)
    conflicts: tuple[Conflict, ...] = Field(default=(), max_length=100)


def accepts(requirement: Requirement, fact: Value) -> bool:
    """Closed, exact predicates; unknown or incompatible facts never satisfy hard rules."""
    wanted = requirement.value
    op = requirement.operator
    if op in {"in", "not_in"}:
        if fact.kind not in {"text", "set"}:
            return False
        actual = set(fact.items) if fact.kind == "set" else {fact.text or ""}
        return (
            bool(actual & set(wanted.items))
            if op == "in"
            else not bool(actual & set(wanted.items))
        )
    if wanted.kind == "text" and fact.kind == "set":
        if op == "required":
            return wanted.text in fact.items
        if op in {"neq", "forbidden"}:
            return wanted.text not in fact.items
    if wanted.kind != fact.kind or wanted.unit != fact.unit:
        return False
    if wanted.number is not None and fact.number is not None:
        a, b = Decimal(fact.number), Decimal(wanted.number)
        return {
            "eq": a == b,
            "neq": a != b,
            "lt": a < b,
            "lte": a <= b,
            "gt": a > b,
            "gte": a >= b,
        }.get(op, False)
    same = (wanted.text, wanted.boolean, wanted.items) == (
        fact.text,
        fact.boolean,
        fact.items,
    )
    return (
        not same
        if op in {"neq", "forbidden"}
        else same
        if op in {"eq", "required", "compatible"}
        else False
    )


def merge_requirements(
    previous: tuple[Requirement, ...],
    current: tuple[Requirement, ...],
    *,
    replace_fields: frozenset[str] = frozenset(),
) -> ConstraintFrame:
    """Only explicit updates replace customer constraints; protected rules always survive."""
    explicit = {
        r.field
        for r in current
        if r.source in {"current_customer", "explicit_preference"} and r.evidence
    }
    replace = {
        (r.field, r.scope) for r in current if r.field in replace_fields & explicit
    }
    kept = tuple(
        r
        for r in previous
        if (r.field, r.scope) not in replace or r.source in PROTECTED
    )
    requirements = kept + current
    return ConstraintFrame(
        requirements=requirements, conflicts=contradictions(requirements)
    )


def contradictions(requirements: tuple[Requirement, ...]) -> tuple[Conflict, ...]:
    results: list[Conflict] = []
    groups: dict[tuple[str, str], list[tuple[int, Requirement]]] = {}
    for i, r in enumerate(requirements):
        if r.strength == "hard":
            groups.setdefault((r.scope, r.field), []).append((i, r))
    for (scope, field), rows in groups.items():
        for position, (i, a) in enumerate(rows):
            for j, b in rows[position + 1 :]:
                bad = False
                code: ConflictCode = "contradiction"
                if a.value.unit != b.value.unit:
                    bad, code = True, "unit_mismatch"
                # Exact facts take precedence over membership regardless of
                # requirement order: a known set can satisfy several members.
                elif a.operator in {"eq", "compatible"}:
                    bad = not accepts(b, a.value)
                elif b.operator in {"eq", "compatible"}:
                    bad = not accepts(a, b.value)
                elif (
                    a.operator == b.operator == "required"
                    and a.value.kind == b.value.kind == "text"
                ):
                    bad = False
                elif "required" in {a.operator, b.operator}:
                    member, other = (a, b) if a.operator == "required" else (b, a)
                    if member.value.kind == "text" and other.operator == "in":
                        # An eligible set can contain the required member and
                        # a different permitted member at the same time.
                        bad = False
                    else:
                        bad = not accepts(other, member.value)
                elif a.value.number is not None and b.value.number is not None:
                    lower, upper = (a, b) if a.operator in {"gt", "gte"} else (b, a)
                    if lower.operator in {"gt", "gte"} and upper.operator in {
                        "lt",
                        "lte",
                    }:
                        low, high = (
                            Decimal(lower.value.number or "0"),
                            Decimal(upper.value.number or "0"),
                        )
                        bad = low > high or (
                            low == high
                            and (lower.operator == "gt" or upper.operator == "lt")
                        )
                elif a.operator == b.operator == "in":
                    bad = not bool(set(a.value.items) & set(b.value.items))
                elif {a.operator, b.operator} == {"in", "not_in"}:
                    inc, exc = (a, b) if a.operator == "in" else (b, a)
                    bad = set(inc.value.items) <= set(exc.value.items)
                if bad:
                    results.append(
                        Conflict(
                            field=field,
                            scope=scope,
                            code=code,
                            requirement_indexes=(i, j),
                        )
                    )
    return tuple(results)


def verify(
    frame: ConstraintFrame,
    facts: dict[str, Value],
    *,
    now: int,
    freshness: Freshness | None = None,
) -> tuple[Conflict, ...]:
    failures = list(frame.conflicts)
    for i, r in enumerate(frame.requirements):
        if r.strength != "hard":
            continue
        code: ConflictCode | None = None
        if (
            r.freshness is not None
            and not r.freshness.observed_at <= now < r.freshness.expires_at
        ) or (
            freshness is not None
            and not freshness.observed_at <= now < freshness.expires_at
        ):
            code = "stale_fact"
        elif r.field not in facts:
            code = "unknown_fact"
        elif not accepts(r, facts[r.field]):
            code = "contradiction"
        if code:
            failures.append(
                Conflict(
                    field=r.field, scope=r.scope, code=code, requirement_indexes=(i,)
                )
            )
    return tuple(failures)


class IntentCandidate(MeaningContract):
    name: Code
    confidence: float = Field(ge=0, le=1)
    evidence: tuple[Span, ...]
    language: Literal["en", "und"]
    missing: tuple[Code, ...] = ()
    ambiguity: tuple[Code, ...] = ()


class IntentFrame(MeaningContract):
    candidates: tuple[IntentCandidate, ...]
    route: Code | None = None
    compound: bool = False


class Clarification(MeaningContract):
    required: bool
    reason: Literal[
        "safety",
        "feasibility",
        "hard_constraint",
        "material_benefit",
        "reversible_assumption",
    ]
    fields: tuple[Code, ...] = ()


def clarify(
    frame: ConstraintFrame,
    *,
    safety_missing: tuple[str, ...] = (),
    feasibility_missing: tuple[str, ...] = (),
) -> Clarification:
    if safety_missing:
        return Clarification(required=True, reason="safety", fields=safety_missing)
    if frame.conflicts:
        return Clarification(
            required=True,
            reason="hard_constraint",
            fields=tuple(dict.fromkeys(c.field for c in frame.conflicts)),
        )
    if feasibility_missing:
        return Clarification(
            required=True, reason="feasibility", fields=feasibility_missing
        )
    return Clarification(required=False, reason="reversible_assumption")
