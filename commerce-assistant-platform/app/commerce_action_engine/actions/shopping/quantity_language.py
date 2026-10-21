"""Read labelled quantity comparisons without admitting executable mutations."""

import re
from dataclasses import dataclass

from app.commerce_contracts.comparisons import (
    ComparisonOperator,
    comparison_operator,
    comparison_pattern,
)


@dataclass(frozen=True, slots=True)
class QuantityComparison:
    start: int
    end: int
    operator: ComparisonOperator
    amount: str
    unit: str


_QUANTITY = re.compile(
    rf"\bquantity\s+(?:({comparison_pattern('quantity')})\s+)?"
    r"(\d+)(?!\d|[.,+-]\d)\s*(pieces?|kg|g|l|ml)?(?!\w|[.,+-]\d)",
    re.IGNORECASE,
)
_NUMERIC_ATTEMPT = re.compile(
    rf"\bquantity\s+(?:(?:{comparison_pattern('quantity')})\s+)?(?=[+-]?\d)",
    re.IGNORECASE,
)


def quantity_comparisons(message: str) -> tuple[QuantityComparison, ...]:
    """Preserve complete integer quantities, their units and source spans.

    Ranges here describe requirements. Cart mutation quantity validation and
    supported executable quantity ranges remain separate domain decisions.
    """
    quoted_spans = tuple(
        match.span() for match in re.finditer(r'"[^"\n]*"|“[^”\n]*”', message)
    )

    def quoted(start: int, end: int) -> bool:
        return any(left < end and start < right for left, right in quoted_spans)

    rows = tuple(
        QuantityComparison(
            start=match.start(),
            end=match.end(),
            operator=comparison_operator(match[1]) if match[1] else "eq",
            amount=match[2],
            unit=(match[3] or "piece").casefold().removesuffix("s"),
        )
        for match in _QUANTITY.finditer(message)
        if not quoted(match.start(), match.end())
    )
    valid_starts = {row.start for row in rows}
    if any(
        match.start() not in valid_starts and not quoted(match.start(), match.end())
        for match in _NUMERIC_ATTEMPT.finditer(message)
    ):
        raise ValueError(
            "Please clarify the quantity using a whole number and a supported unit."
        )
    return rows
