"""Retain explicit price limits independently of language/provider extraction."""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Literal

from app.commerce_contracts.comparisons import (
    ComparisonOperator,
    comparison_operator,
    comparison_pattern,
    intersect_bound,
)

if TYPE_CHECKING:
    from .contracts import ShoppingIntent

_CURRENCY_NAMES = {
    **{
        code.lower(): code
        for code in (
            "USD",
            "GBP",
            "EUR",
            "EGP",
            "KWD",
            "JPY",
            "SAR",
            "AED",
            "AUD",
            "CAD",
            "BHD",
            "OMR",
            "CHF",
        )
    },
    "us dollar": "USD",
    "us dollars": "USD",
    "euro": "EUR",
    "euros": "EUR",
    "british pound": "GBP",
    "british pounds": "GBP",
    "pounds sterling": "GBP",
    "egyptian pound": "EGP",
    "egyptian pounds": "EGP",
    "kuwaiti dinar": "KWD",
    "kuwaiti dinars": "KWD",
    "japanese yen": "JPY",
    "saudi riyal": "SAR",
    "saudi riyals": "SAR",
    "uae dirham": "AED",
    "uae dirhams": "AED",
    "australian dollar": "AUD",
    "australian dollars": "AUD",
    "canadian dollar": "CAD",
    "canadian dollars": "CAD",
    "bahraini dinar": "BHD",
    "bahraini dinars": "BHD",
    "omani rial": "OMR",
    "omani rials": "OMR",
    "swiss franc": "CHF",
    "swiss francs": "CHF",
    "$": "USD",
    "£": "GBP",
    "€": "EUR",
}
_CURRENCY = "|".join(
    re.escape(name).replace(r"\ ", r"\s+")
    for name in sorted(_CURRENCY_NAMES, key=len, reverse=True)
    if name not in {"$", "£", "€"}
)
_MONEY = (
    rf"([$£€]|(?:{_CURRENCY})(?=\s|\d))?\s*"
    r"(\d+(?:,\d{3})*(?:\.\d{1,6})?)"
    rf"(?:\s*({_CURRENCY})\b)?"
    r"(?!\w|\.\w|,\d|-)"
)
_BOUND = re.compile(
    rf"\b({comparison_pattern()})\s*" + _MONEY,
    re.IGNORECASE,
)
_RANGE = re.compile(r"\bbetween\s+" + _MONEY + r"\s+and\s+" + _MONEY, re.IGNORECASE)
_BOUND_START = re.compile(
    rf"\b(?:{comparison_pattern()})\s*"
    rf"(?=(?:[$£€]|(?:{_CURRENCY})(?=\s|\d))?\s*\d)",
    re.IGNORECASE,
)
_NON_MONEY_UNIT = re.compile(
    r"\s*(?:pieces?|items?|units?|packs?|bottles?|kg|kilograms?|grams?|g|lbs?|"
    r"pounds?|oz|ounces?|ml|milliliters?|liters?|litres?|l|[kmgt]?b|mah|wh|"
    r"hz|khz|mhz|ghz|mm|cm|m|inch(?:es)?|ct|carats?|karats?|volts?|"
    r"watts?|w|v|percent|%)(?!\w)",
    re.IGNORECASE,
)


@dataclass(frozen=True, slots=True)
class PriceBound:
    start: int
    end: int
    operator: ComparisonOperator
    amount: str
    currency: str | None


def iter_price_bounds(
    message: str,
    *,
    ignore_spans: tuple[tuple[int, int], ...] = (),
) -> tuple[PriceBound, ...]:
    """Read monetary syntax without binding it to a product or basket.

    Consumers supply proven non-money spans and own the remaining scope. Quoted
    identities are literals. Source offsets always refer to the original text.
    """
    ignored = (
        *ignore_spans,
        *(m.span() for m in re.finditer(r'"[^"\n]*"|“[^”\n]*”', message)),
    )
    rows: list[PriceBound] = []
    matches = list(_BOUND.finditer(message))
    matched_starts = {match.start() for match in matches}
    for head in _BOUND_START.finditer(message):
        if head.start() not in matched_starts and not any(
            start <= head.start() < end for start, end in ignored
        ):
            raise ValueError(
                "Please give a complete numeric amount for this price comparison."
            )

    def add(
        match: re.Match[str],
        operator: ComparisonOperator,
        prefix: str | None,
        amount: str,
        suffix: str | None,
    ) -> None:
        if any(start < match.end() and match.start() < end for start, end in ignored):
            return
        if _NON_MONEY_UNIT.match(message[match.end() :]):
            raise ValueError(
                "Please specify the product attribute and catalog unit for this comparison."
            )
        if re.search(
            r"\b(?:not|never|no)\s*$", message[: match.start()], re.IGNORECASE
        ):
            raise ValueError("Please clarify the negated price limit.")
        currencies = {
            _CURRENCY_NAMES[re.sub(r"\s+", " ", value.casefold())]
            for value in (prefix, suffix)
            if value
        }
        if len(currencies) > 1:
            raise ValueError("Please use one currency for the price range.")
        rows.append(
            PriceBound(
                start=match.start(),
                end=match.end(),
                operator=operator,
                amount=amount.replace(",", ""),
                currency=next(iter(currencies), None),
            )
        )

    for match in matches:
        add(match, comparison_operator(match[1]), match[2], match[3], match[4])
    for match in _RANGE.finditer(message):
        prefix, low, suffix, high_prefix, high, high_suffix = match.groups()
        # A currency declared on either side belongs to the same range. Distinct
        # currencies remain explicit so the consuming domain can reject them.
        low_currency, high_currency = prefix or suffix, high_prefix or high_suffix
        add(match, "gte", prefix or high_currency, low, suffix)
        add(match, "lte", high_prefix or low_currency, high, high_suffix)
    return tuple(sorted(rows, key=lambda bound: (bound.start, bound.end)))


def retain_price_bounds(
    data: dict[str, Any],
    message: str,
    *,
    literal_ties: bool = False,
    ignore_spans: tuple[tuple[int, int], ...] = (),
) -> dict[str, Any]:
    if literal_ties:
        # Extraction may misread inclusive wording. Fold all literal constraints
        # first, then let their operator win a tie with the extracted amount.
        explicit = retain_price_bounds({}, message, ignore_spans=ignore_spans)
        retained = retain_price_bounds(data, message, ignore_spans=ignore_spans)
        for direction in ("min", "max"):
            field, flag = f"{direction}_price", f"exclusive_{direction}"
            if explicit.get(field) is not None and Decimal(explicit[field]) == Decimal(
                retained[field]
            ):
                retained[flag] = explicit[flag]
        return retained
    data = dict(data)
    currencies = set()
    for bound in iter_price_bounds(message, ignore_spans=ignore_spans):
        if bound.currency:
            currencies.add(bound.currency)
        directions: tuple[Literal["min", "max"], ...] = (
            ("min", "max")
            if bound.operator == "eq"
            else ("min",)
            if bound.operator in {"gt", "gte"}
            else ("max",)
        )
        strict = bound.operator in {"gt", "lt"}
        for direction in directions:
            field, flag = f"{direction}_price", f"exclusive_{direction}"
            data[field], data[flag] = intersect_bound(
                data.get(field),
                bool(data.get(flag)),
                bound.amount,
                strict,
                direction,
            )
    if len(currencies) > 1:
        raise ValueError("Please use one currency for the price range.")
    if currencies:
        data["currency"] = currencies.pop()
    return data


def empty_price_range(plan: ShoppingIntent) -> bool:
    if plan.min_price is None or plan.max_price is None:
        return False
    low, high = Decimal(plan.min_price), Decimal(plan.max_price)
    return low > high or (low == high and (plan.exclusive_min or plan.exclusive_max))
