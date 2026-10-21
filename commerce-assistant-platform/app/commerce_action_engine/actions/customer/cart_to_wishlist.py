"""Save products or move owned cart quantities with explicit evidence outcomes."""

import re
from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID

from app.commerce_action_engine.actions.catalog.references import (
    exact_products,
    suggestions,
)
from app.commerce_action_engine.actions.shopping.cart_admission import (
    WISHLIST_INTENTS,
    admission_error,
    normalized,
)
from app.commerce_action_engine.actions.shopping.cart_read import CartReader
from app.commerce_action_engine.contracts import AssistantCart
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable


class WishlistActions(CartReader, Protocol):
    async def search_cart_product(self, query: str) -> list[dict[str, Any]]: ...
    async def add_wishlist_item(self, product_id: UUID) -> None: ...
    async def change_cart(self, change: dict[str, Any]) -> AssistantCart: ...


@dataclass(frozen=True)
class WishlistNeedsInput:
    text: str
    cart: AssistantCart | None = None


@dataclass(frozen=True)
class WishlistNeedsChoice:
    text: str
    cart: AssistantCart
    choices: tuple[dict[str, Any], ...]


@dataclass(frozen=True)
class WishlistNotFound:
    text: str
    cart: AssistantCart


@dataclass(frozen=True)
class WishlistAddUnverified:
    """The destination write has no acknowledgement; do not remove or retry."""

    text: str
    cart: AssistantCart
    product_id: UUID


@dataclass(frozen=True)
class WishlistRemovalUnverified:
    """Wishlist addition was acknowledged; no current cart snapshot is available."""

    text: str
    product_id: UUID
    name: str


@dataclass(frozen=True)
class WishlistRemovalMismatch:
    """Wishlist addition succeeded, but the cart did not confirm the expected quantity."""

    text: str
    cart: AssistantCart
    product_id: UUID
    expected_remaining: int
    actual_remaining: int


@dataclass(frozen=True)
class WishlistSaved:
    """The save was acknowledged; no cart removal was requested."""

    text: str
    cart: AssistantCart
    product_id: UUID


@dataclass(frozen=True)
class WishlistMoved:
    """The save was acknowledged and the returned cart verifies the exact removal."""

    text: str
    cart: AssistantCart
    product_id: UUID
    removed_quantity: int


type WishlistResult = (
    WishlistNeedsInput
    | WishlistNeedsChoice
    | WishlistNotFound
    | WishlistAddUnverified
    | WishlistRemovalUnverified
    | WishlistRemovalMismatch
    | WishlistSaved
    | WishlistMoved
)


async def execute(
    result: InterpretedRequest,
    message: str,
    tools: WishlistActions,
    *,
    selected_product: dict[str, Any] | None = None,
) -> WishlistResult:
    if result.legacy_intent not in WISHLIST_INTENTS:
        return WishlistNeedsInput(
            "Please provide a complete cart instruction before I make a change."
        )
    if rejection := admission_error(result):
        return WishlistNeedsInput(rejection)
    cart = await tools.cart()
    query = result.entities.get("productText")
    if not isinstance(query, str) or not query.strip():
        match = re.search(
            r"(?:move|transfer|add|put|save)\s+(.+?)\s+(?:to|into|in|on)\s+(?:my\s+)?(?:wishlist|wish\s+list|favorites|favourites)",
            message.strip(),
            re.IGNORECASE,
        )
        query = match.group(1).strip() if match else None
    if not isinstance(query, str) or not query.strip():
        return WishlistNeedsInput(
            "Which product would you like to save to your wishlist?", cart
        )

    candidates = [
        item for item in cart.items if normalized(item.name) == normalized(query)
    ]
    if not candidates:
        candidates = [
            item
            for item in cart.items
            if f" {normalized(item.name)} " in f" {normalized(message)} "
        ]
    moving = (
        bool(
            re.match(
                r"\s*(?:pls\s+|please\s+)?(?:move|transfer)\b", message, re.IGNORECASE
            )
        )
        or result.legacy_intent == "CART_MOVE_TO_WISHLIST"
        or result.entities.get("sourceCollection") == "cart"
    )
    if moving and len(candidates) != 1:
        return WishlistNeedsInput(
            "Please specify the full name of one item in your cart to move to your wishlist. No items were moved.",
            cart,
        )
    product_id: UUID | None = (
        candidates[0].product_id if moving and len(candidates) == 1 else None
    )
    name = candidates[0].name if len(candidates) == 1 else query
    quantity = result.entities.get("quantity")
    remove_quantity: int | None = None
    if moving and len(candidates) == 1 and quantity is not None:
        if type(quantity) is not int or not 1 <= quantity <= candidates[0].quantity:
            return WishlistNeedsInput(
                "Please specify a whole number no greater than the quantity in your cart.",
                cart,
            )
        remove_quantity = quantity
    if product_id is None:
        products = (
            [selected_product]
            if selected_product is not None
            else await tools.search_cart_product(query)
        )
        exact = (
            products
            if selected_product is not None
            else exact_products(products, query)
        )
        if len(exact) != 1:
            choices = list({str(p["id"]): p for p in products}.values())[:5]
            if not choices:
                return WishlistNotFound(suggestions(choices), cart)
            return WishlistNeedsChoice(suggestions(choices), cart, tuple(choices))
        product_id, name = UUID(str(exact[0]["id"])), exact[0]["name"]

    try:
        await tools.add_wishlist_item(product_id)
    except ToolUnavailable:
        return WishlistAddUnverified(
            "I couldn't confirm the wishlist update. Please check your wishlist before trying again.",
            cart,
            product_id,
        )
    if moving and len(candidates) == 1:
        remove: dict[str, Any] = {"action": "remove", "product_id": str(product_id)}
        if remove_quantity is not None:
            remove["quantity"] = remove_quantity
        try:
            updated = await tools.change_cart(remove)
        except ToolDenied as error:
            error.completed_action = "wishlist_add"
            raise
        except ToolUnavailable:
            return WishlistRemovalUnverified(
                "The item was saved to your wishlist, but I couldn't remove it from your cart. Please check both collections.",
                product_id,
                name,
            )
        remaining = next(
            (item.quantity for item in updated.items if item.product_id == product_id),
            0,
        )
        expected = (
            candidates[0].quantity - remove_quantity
            if remove_quantity is not None
            else 0
        )
        if remaining != expected:
            return WishlistRemovalMismatch(
                "The item was saved to your wishlist, but the cart did not confirm its removal. Please check both collections before retrying.",
                updated,
                product_id,
                expected,
                remaining,
            )
        return WishlistMoved(
            f"Moved {name} to your wishlist.",
            updated,
            product_id,
            candidates[0].quantity - expected,
        )
    return WishlistSaved(f"Saved {name} to your wishlist.", cart, product_id)
