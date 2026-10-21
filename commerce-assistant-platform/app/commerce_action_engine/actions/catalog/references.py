"""Exact merchant identities; partial references are suggestions, never authority."""

import unicodedata
from typing import Any


def key(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def exact_products(
    products: list[dict[str, Any]], reference: str
) -> list[dict[str, Any]]:
    wanted = key(reference)
    return list(
        {
            str(p["id"]): p
            for p in products
            if wanted
            and any(key(str(p.get(field, ""))) == wanted for field in ("name", "sku"))
        }.values()
    )


def suggestions(products: list[dict[str, Any]]) -> str:
    names = "; ".join(
        f"{p['name']} (SKU: {p['sku']})" if p.get("sku") else p["name"]
        for p in products[:5]
    )
    return (
        f"Please choose a product: {names}. Use its full name or SKU in your request. No changes have been made."
        if names
        else "I couldn't find that product. Please check its full name or SKU. No changes have been made."
    )
