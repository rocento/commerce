"""Pure admission and name normalization shared by cart and wishlist actions."""

import re

from app.commerce_action_engine.contracts.interpretation import InterpretedRequest

WISHLIST_INTENTS = frozenset({"ADD_TO_WISHLIST", "CART_MOVE_TO_WISHLIST"})

WRITE_INTENTS = {
    "ADD_TO_CART",
    "REMOVE_FROM_CART",
    "CLEAR_CART",
    "UPDATE_CART_QUANTITY",
    "ADD_TO_WISHLIST",
    "CART_MOVE_TO_WISHLIST",
}
CHECKOUT_INTENTS = {"START_CHECKOUT", "CONTINUE_CHECKOUT", "CREATE_ORDER"}


def normalized(value: str) -> str:
    return " ".join(re.findall(r"\w+", value.casefold()))


def admission_error(result: InterpretedRequest) -> str | None:
    if (
        result.status != "RESOLVED"
        or result.confidence.raw < 0.65
        or result.request_type
        or result.missing
        or result.legacy_intent not in WRITE_INTENTS | CHECKOUT_INTENTS
    ):
        return "Please provide a complete cart instruction before I make a change."
    # Descriptive words can be part of an exact catalog name (e.g. Silver Moon
    # Necklace). Wishlist identity matching below must still prove the full name;
    # a separate attribute or price constraint is not permission to ignore it.
    name_attributes = set()
    if result.legacy_intent in {"ADD_TO_WISHLIST", "CART_MOVE_TO_WISHLIST"}:
        product_text = result.entities.get("productText")
        if isinstance(product_text, str):
            for key in ("material", "color", "brand", "size"):
                value = result.entities.get(key)
                if (
                    isinstance(value, str)
                    and value.strip()
                    and f" {normalized(value)} " in f" {normalized(product_text)} "
                ):
                    name_attributes.add(key)
    if (
        set(result.entities)
        - name_attributes
        - {
            "productText",
            "quantity",
            "unit",
            "category",
            "destination",
            "sourceCollection",
            "product_reference",
        }
        or result.entities.get(
            "destination",
            "wishlist"
            if result.legacy_intent in {"ADD_TO_WISHLIST", "CART_MOVE_TO_WISHLIST"}
            else "cart",
        )
        != (
            "wishlist"
            if result.legacy_intent in {"ADD_TO_WISHLIST", "CART_MOVE_TO_WISHLIST"}
            else "cart"
        )
        or (
            "category" in result.entities
            and (
                not isinstance(result.entities["category"], str)
                or not result.entities["category"].strip()
            )
        )
        or (
            "unit" in result.entities
            and result.entities["unit"]
            not in {"kg", "g", "mg", "l", "ml", "cl", "oz", "lb", "lbs"}
        )
    ):
        return "I can't apply all of these conditions to a cart change yet. [Open your cart](/cart) to review them. Your cart has not been changed."
    return None
