"""Bind narrowly expressed follow-ups to UI selections, never to arbitrary text."""

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class ShoppingFollowup:
    message: str
    intent: str
    product: bool = False
    confirmed: bool = False


def shopping_followup(
    message: str, *, product: bool, cart: bool
) -> ShoppingFollowup | None:
    text = (
        re.sub(r"^(?:please|pls)\s+", "", message.strip().lower()).rstrip("?.!").strip()
    )
    read_text = text.rstrip(" /?.!").strip()
    if product:
        confirmation = re.fullmatch(
            r"confirm removal of ([1-9]\d{0,5}|1000000) from my cart", text
        )
        if confirmation:
            return ShoppingFollowup(
                f"remove {confirmation.group(1)} selected product from cart",
                "REMOVE_FROM_CART",
                True,
                True,
            )
        if text in {"save this to my wishlist", "add this to my wishlist"}:
            return ShoppingFollowup(
                "add selected product to wishlist", "ADD_TO_WISHLIST", True
            )
        if re.fullmatch(
            r"(?:how much(?: is (?:it|this|that|this product))?|(?:what is|what's) (?:its|the) price|price|check (?:its )?price)",
            read_text,
        ):
            return ShoppingFollowup("check price", "CHECK_PRICE", True)
        if re.fullmatch(
            r"(?:is (?:it|this|that) (?:in stock|available)|(?:check )?(?:its )?(?:stock|availability))",
            read_text,
        ):
            return ShoppingFollowup("check stock", "CHECK_STOCK", True)
        if re.fullmatch(
            r"(?:tell me about (?:it|this|that)|(?:show(?: me)? )?(?:its |product )?details|what is (?:it|this|that))",
            read_text,
        ):
            return ShoppingFollowup("selected product details", "PRODUCT_DETAILS", True)
        amount = r"([1-9]\d{0,6}|one|two|three|four|five|six|seven|eight|nine|ten)"
        add = re.fullmatch(
            rf"add(?: {amount}(?: of)?)?(?: (?:it|this|that|this product))?(?: to (?:my |the )?cart)?",
            text,
        )
        if add:
            return ShoppingFollowup(
                f"add {add.group(1) or 'one'} selected product to cart",
                "ADD_TO_CART",
                True,
            )
        remove = re.fullmatch(
            rf"remove(?: {amount}(?: of)?)? (?:it|this|that)(?: from (?:my |the )?cart)?",
            text,
        )
        if remove:
            quantity = f"{remove.group(1)} " if remove.group(1) else ""
            return ShoppingFollowup(
                f"remove {quantity}selected product from cart", "REMOVE_FROM_CART", True
            )
    if cart and re.fullmatch(
        r"(?:what(?:'s| is) in (?:it|there)|(?:show|view)(?: me)? (?:it|the items)|how much(?: is (?:it|the total))?|(?:what is|what's) (?:the |its )?total|total|how many(?: items)?(?: are (?:there|in it))?)",
        read_text,
    ):
        return ShoppingFollowup("show my cart", "VIEW_CART")
    return None
