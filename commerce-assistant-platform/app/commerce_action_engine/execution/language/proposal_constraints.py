"""Conservative meaning checks across an untrusted language rewrite."""

import re
from collections import Counter
from typing import Any

from app.commerce_action_engine.actions.shopping.pricing import retain_price_bounds


def preserves_entities(original: dict[str, Any], proposed: dict[str, Any]) -> bool:
    """UNKNOWN may still contain facts which the rewrite must preserve.

    Compare every extracted field, including future fields, rather than silently
    discarding a constraint this bridge does not yet understand. Additional
    fields remain subject to the domain's original-message checks.
    """
    return all(
        key in proposed and value == proposed[key] for key, value in original.items()
    )


def _units(text: str) -> Counter[str]:
    return Counter(
        "box" if word == "boxes" else word.rstrip("s")
        for word in re.findall(
            r"(?<![a-z])(?:kg|kilograms?|grams?|g|lbs?|pounds?|oz|ounces?|"
            r"ml|milliliters?|l|liters?|litres?|packs?|bottles?|box(?:es)?|pieces?)\b",
            text.casefold(),
        )
    )


def preserves_literals(original: str, canonical: str) -> bool:
    try:
        # Flat extraction can retain just one bound from a compound request.
        # Independently compare all original monetary limits and their strictness.
        prices_match = retain_price_bounds({}, original) == retain_price_bounds(
            {}, canonical
        )
    except ValueError:
        return False
    return prices_match and _units(original) == _units(canonical)


def asks_about_action(message: str) -> bool:
    """Questions about doing an action must not become a write command.

    Polite requests such as 'could you add ...' remain supported. This bounded
    check is deliberately conservative; it is not a semantic-equivalence proof.
    """
    return bool(
        re.search(
            r"^\s*(?:please\s+)?(?:how|why|when|whether|what happens|is it possible|"
            r"(?:can|could|should|would|may)\s+(?:i|we)|"
            r"(?:tell|show)\s+me\s+how|explain\s+how)\b",
            message,
            re.IGNORECASE,
        )
    )
