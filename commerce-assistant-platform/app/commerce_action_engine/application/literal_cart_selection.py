"""Bind a complete literal add command to one current catalog identity.

This only supplies product context. Published language rules still admit the
normalized command, and the cart handler re-fetches the product before writing.
"""

import re
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID

from app.commerce_action_engine.actions.catalog.references import exact_products
from app.commerce_action_engine.shared.errors import ToolUnavailable

CatalogLookup = Callable[[str], Awaitable[list[dict[str, Any]]]]


async def literal_cart_selection(
    message: str, lookup: CatalogLookup
) -> tuple[UUID, int] | None:
    match = re.fullmatch(
        r"(?:please\s+|pls\s+)?add\s+(?:(?P<quantity>[1-9]\d{0,5}|1000000)\s+)?(?P<name>.+?)\s+(?:to|into)\s+(?:my\s+|the\s+)?(?:cart|basket)[.!]?",
        message.strip(),
        re.IGNORECASE,
    )
    if not match:
        return None
    name = match["name"].strip()
    if len(name) > 200:
        return None
    if len(name) > 2 and (name[0], name[-1]) in {('"', '"'), ("“", "”")}:
        name = name[1:-1]
    try:
        products = exact_products(await lookup(name), name)
    except ToolUnavailable:
        return None
    if len(products) != 1:
        return None
    try:
        product_id = UUID(str(products[0]["id"]))
    except (ValueError, KeyError):
        return None
    return product_id, int(match["quantity"] or 1)
