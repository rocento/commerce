"""English comparison vocabulary and pure bound rules shared by both engines.

Field binding, money, measurement units and executable quantities belong to the
consumer. This module only defines what a comparison phrase means.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from decimal import Decimal
from typing import Literal

ComparisonOperator = Literal["eq", "neq", "lt", "lte", "gt", "gte"]
ComparisonDomain = Literal["price", "attribute", "quantity", "basket"]
COMPARISON_VERSION = 1

# Attribute-only minimum/maximum and symbolic forms retain their existing scope.
# Longer phrases must win over their embedded shorter comparisons.
COMPARISON_PHRASES: tuple[tuple[str, ComparisonOperator], ...] = (
    ("no more than", "lte"),
    ("no less than", "gte"),
    ("greater than", "gt"),
    ("less than", "lt"),
    ("more than", "gt"),
    ("at least", "gte"),
    ("at most", "lte"),
    ("up to", "lte"),
    ("under", "lt"),
    ("below", "lt"),
    ("above", "gt"),
    ("over", "gt"),
    ("exactly", "eq"),
    ("minimum", "gte"),
    ("maximum", "lte"),
)
COMPARISON_SYMBOLS: dict[ComparisonOperator, str] = {
    "eq": "=",
    "neq": "!=",
    "lt": "<",
    "lte": "<=",
    "gt": ">",
    "gte": ">=",
}
COMPARISON_WORDING: dict[ComparisonOperator, str] = {
    "eq": "exactly",
    "neq": "not equal to",
    "lt": "under",
    "lte": "at most",
    "gt": "above",
    "gte": "at least",
}
_ATTRIBUTE_ONLY = frozenset({"minimum", "maximum"})


def comparison_phrases(
    domain: ComparisonDomain = "price",
) -> dict[str, ComparisonOperator]:
    return {
        phrase: operator
        for phrase, operator in COMPARISON_PHRASES
        if domain == "attribute" or phrase not in _ATTRIBUTE_ONLY
    }


def comparison_operator(phrase: str) -> ComparisonOperator:
    normalized = " ".join(phrase.casefold().split())
    for text, operator in COMPARISON_PHRASES:
        if normalized == text:
            return operator
    for operator, symbol in COMPARISON_SYMBOLS.items():
        if normalized == symbol:
            return operator
    raise ValueError("Unsupported comparison phrase")


def comparison_pattern(
    domain: ComparisonDomain = "price",
    *,
    include_symbols: bool = False,
    operators: Iterable[ComparisonOperator] | None = None,
) -> str:
    allowed = set(operators) if operators is not None else None
    phrases = comparison_phrases(domain)
    if include_symbols:
        # Numeric attribute syntax historically supports equality and ranges.
        phrases.update(
            {symbol: op for op, symbol in COMPARISON_SYMBOLS.items() if op != "neq"}
        )
    return "|".join(
        re.escape(phrase).replace(r"\ ", r"\s+")
        for phrase in sorted(phrases, key=lambda text: (-len(text), text))
        if allowed is None or phrases[phrase] in allowed
    )


def intersect_bound(
    old: str | None,
    old_exclusive: bool,
    amount: str,
    exclusive: bool,
    direction: Literal["min", "max"],
) -> tuple[str, bool]:
    """Intersect conjunctions; an equal strict bound always remains strict.

    Replacing a prior conversational limit is a separate domain operation.
    """
    if old is None:
        return amount, exclusive
    new_value, old_value = Decimal(amount), Decimal(old)
    if new_value > old_value if direction == "min" else new_value < old_value:
        return amount, exclusive
    if new_value == old_value:
        return old, old_exclusive or exclusive
    return old, old_exclusive
