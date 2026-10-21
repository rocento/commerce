"""Recover a bounded source spelling for a tenant-backed exact-name lookup."""

import json
import re
from decimal import Decimal, InvalidOperation

from app.commerce_action_engine.actions.catalog import CatalogSchema, Product
from app.commerce_action_engine.actions.shopping.constraints import normalized


def source_name(
    message: str, product_text: str, *, include_tail: bool = False
) -> str | None:
    """Match normalized engine tokens, returning original punctuation/diacritics.

    This only proposes a catalog read. It grants no identity or attribute facts;
    the caller must find one exact merchant name or SKU before using it.
    Ambiguous source occurrences and normalization that shifts offsets abstain.
    """
    lowered = message.lower()
    if len(lowered) != len(message):
        return None
    wanted = re.findall(r"[a-z0-9]+", product_text.lower())
    tokens = list(re.finditer(r"[a-z0-9]+", lowered))
    if len(wanted) < 2:
        return None
    matches = [
        (tokens[i].start(), tokens[i + len(wanted) - 1].end())
        for i in range(len(tokens) - len(wanted) + 1)
        if [t.group() for t in tokens[i : i + len(wanted)]] == wanted
    ]
    if len(matches) != 1:
        return None
    start, end = matches[0]
    if (
        start
        and message[start - 1].isalnum()
        or end < len(message)
        and message[end].isalnum()
    ):
        return None
    if include_tail:
        end = len(message.rstrip(".!? "))
    return message[start:end] if end - start <= 200 else None


def without_name(message: str, name: str) -> str:
    return re.sub(
        r"(?<!\w)" + re.escape(name) + r"(?!\w)",
        " ",
        message,
        count=1,
        flags=re.IGNORECASE,
    )


def contains_value(message: str, value: str) -> bool:
    return bool(
        re.search(
            r"(?<!\w)" + re.escape(value.replace("_", " ")) + r"(?!\w)",
            message,
            re.IGNORECASE,
        )
    )


def matches_name(query: str, product: Product, schema: CatalogSchema) -> bool:
    """Allow only exact names/SKUs or a verified numeric-unit variant suffix.

    A model suffix such as Pro/Plus is never discarded. Units and numeric values
    must both come from this merchant's schema and this returned product.
    """
    wanted, name = normalized(query), normalized(product.name)
    if wanted in {name, normalized(product.sku)}:
        return True
    if not name.startswith(wanted + " "):
        return False
    suffix = name[len(wanted) :].strip()
    for definition in schema.attributes:
        if not definition.unit or definition.data_type not in {
            "integer",
            "decimal",
            "number",
        }:
            continue
        match = re.fullmatch(
            r"(\d+(?:\.\d+)?)\s*" + re.escape(normalized(definition.unit)), suffix
        )
        if not match:
            continue
        for attribute in product.attributes:
            if attribute.name != definition.code:
                continue
            try:
                value = json.loads(attribute.value)
                if (
                    isinstance(value, (str, int, float))
                    and not isinstance(value, bool)
                    and Decimal(str(value)) == Decimal(match[1])
                ):
                    return True
            except (ValueError, InvalidOperation):
                continue
    return False
