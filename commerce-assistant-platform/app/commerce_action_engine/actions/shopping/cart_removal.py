"""Resolve removal within the current cart and return verified receipt facts."""

import re
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol
from uuid import UUID

from app.commerce_action_engine.actions.catalog.references import exact_products, key
from app.commerce_action_engine.contracts import (
    AssistantCart,
    AssistantCartItem,
    AssistantCartRemoval,
)
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.shared.errors import ToolUnavailable


class RemovalActions(Protocol):
    async def cart(self) -> AssistantCart: ...
    async def change_cart(self, change: dict[str, Any]) -> AssistantCart: ...
    async def search_cart_product(self, query: str) -> list[dict[str, Any]]: ...


@dataclass(frozen=True)
class RemovalNeedsInput:
    """The request needs correction before an item can be removed."""

    text: str
    cart: AssistantCart | None = None
    status: Literal["needs_input"] = field(default="needs_input", init=False)


@dataclass(frozen=True)
class RemovalNeedsChoice:
    """Only these current, owned cart items may be selected."""

    text: str
    cart: AssistantCart
    choices: tuple[AssistantCartItem, ...]
    status: Literal["needs_choice"] = field(default="needs_choice", init=False)


@dataclass(frozen=True)
class RemovalNeedsConfirmation:
    """An exact item is resolved, but its removal has not been authorized."""

    text: str
    cart: AssistantCart
    item: AssistantCartItem
    quantity: int
    status: Literal["needs_confirmation"] = field(
        default="needs_confirmation", init=False
    )

    @property
    def choices(self) -> tuple[AssistantCartItem, ...]:
        return (self.item,)


@dataclass(frozen=True)
class RemovalNoChange:
    """The current cart cannot satisfy the request; no write was attempted."""

    text: str
    cart: AssistantCart
    reason: Literal["empty_cart", "not_found", "stale_selection"]
    status: Literal["no_change"] = field(default="no_change", init=False)


@dataclass(frozen=True)
class RemovalCompleted:
    """A write completed and its authoritative cart response verified the receipt."""

    text: str
    cart: AssistantCart
    receipt: AssistantCartRemoval
    status: Literal["completed"] = field(default="completed", init=False)


@dataclass(frozen=True)
class RemovalUnverified:
    """A write was attempted; its effect must not be claimed or replayed."""

    text: str
    reason: Literal["write_unavailable", "receipt_mismatch"]
    cart: AssistantCart | None = None
    status: Literal["unverified"] = field(default="unverified", init=False)


type RemovalResult = (
    RemovalNeedsInput
    | RemovalNeedsChoice
    | RemovalNeedsConfirmation
    | RemovalNoChange
    | RemovalCompleted
    | RemovalUnverified
)


async def remove_from_cart(
    result: InterpretedRequest,
    message: str,
    tools: RemovalActions,
    *,
    selected_product_id: UUID | None = None,
    confirmed: bool = False,
) -> RemovalResult:
    if (
        result.status != "RESOLVED"
        or result.confidence.raw < 0.65
        or result.request_type
        or result.missing
        or result.legacy_intent != "REMOVE_FROM_CART"
        or set(result.entities)
        - {"productText", "quantity", "category", "destination", "product_reference"}
        or result.entities.get("destination", "cart") != "cart"
    ):
        return RemovalNeedsInput(
            "Please provide a complete removal instruction. Your cart has not been changed."
        )
    quantity = result.entities.get("quantity")
    if quantity is not None and (
        type(quantity) is not int or not 1 <= quantity <= 1000000
    ):
        return RemovalNeedsInput(
            "Please specify a whole quantity of at least 1 to remove. Your cart has not been changed."
        )

    cart = await tools.cart()
    if selected_product_id is not None:
        candidates = [
            item for item in cart.items if item.product_id == selected_product_id
        ]
        if not candidates:
            return RemovalNoChange(
                "That item is no longer in your cart. No changes have been made.",
                cart,
                reason="stale_selection",
            )
    else:
        query = result.entities.get("productText")
        if not isinstance(query, str) or not query.strip():
            # Preserve existing fully named instructions when the parser omitted the slot.
            candidates = [
                item
                for item in cart.items
                if re.search(
                    r"(?<!\w)" + re.escape(key(item.name)) + r"(?!\w)", key(message)
                )
            ]
            query = candidates[0].name if len(candidates) == 1 else ""
        wanted = key(query)
        if not wanted:
            if not cart.items:
                return RemovalNoChange(
                    "Your cart is empty. There are no items to remove.",
                    cart,
                    reason="empty_cart",
                )
            return RemovalNeedsChoice(
                "Choose an item below to remove from your cart.",
                cart,
                tuple(cart.items[:5]),
            )
        candidates = [item for item in cart.items if key(item.name) == wanted]
        if not candidates and len(wanted) >= 3:
            # Whole words only, within this customer's cart. Never fuzzy-authorize a write.
            pattern = re.compile(r"(?<!\w)" + re.escape(wanted) + r"(?!\w)")
            candidates = [item for item in cart.items if pattern.search(key(item.name))]
        if not candidates:
            products = await tools.search_cart_product(query)
            ids = {str(item.product_id) for item in cart.items}
            products = [p for p in products if str(p["id"]) in ids]
            exact = exact_products(products, query)
            if len(exact) == 1:
                candidates = [
                    item
                    for item in cart.items
                    if str(item.product_id) == str(exact[0]["id"])
                ]
            else:
                suggested_ids = {str(p["id"]) for p in products}
                choices = tuple(
                    item for item in cart.items if str(item.product_id) in suggested_ids
                )[:5]
                if not choices:
                    return RemovalNoChange(
                        "I couldn't find that item in your cart. Please check its name or SKU.",
                        cart,
                        reason="not_found",
                    )
                return RemovalNeedsChoice(
                    "Which cart item did you mean? Choose it below.",
                    cart,
                    choices,
                )
        if len(candidates) != 1:
            return RemovalNeedsChoice(
                "Several cart items match. Which one would you like to remove?",
                cart,
                tuple(candidates[:5]),
            )

    item = candidates[0]
    if quantity is not None and quantity > item.quantity:
        return RemovalNeedsInput(
            f"There are only {item.quantity} × {item.name} in your cart. Please choose a quantity no greater than that.",
            cart,
        )
    removed = item.quantity if quantity is None else quantity
    # Only the explicit confirmation follow-up with an exact product ID and
    # displayed quantity may mutate. Recheck membership and quantity above.
    if not confirmed or selected_product_id is None or quantity is None:
        return RemovalNeedsConfirmation(
            f"Please confirm removal of {removed} × {item.name} from your cart.",
            cart,
            item,
            removed,
        )
    change: dict[str, Any] = {"action": "remove", "product_id": str(item.product_id)}
    if quantity is not None:
        change["quantity"] = quantity
    try:
        updated = await tools.change_cart(change)
    except ToolUnavailable:
        return RemovalUnverified(
            "I couldn't confirm the removal. Please check your cart before trying again.",
            reason="write_unavailable",
        )
    remaining = next(
        (p.quantity for p in updated.items if p.product_id == item.product_id), 0
    )
    if remaining != item.quantity - removed:
        return RemovalUnverified(
            "The cart response did not confirm the expected removal. Please check your cart before trying again.",
            reason="receipt_mismatch",
            cart=updated,
        )
    receipt = AssistantCartRemoval(
        product_id=item.product_id,
        name=item.name,
        quantity=removed,
        remaining_quantity=remaining,
        cart_quantity=sum(p.quantity for p in updated.items),
        cart_subtotal=updated.subtotal,
        currency=updated.currency,
    )
    return RemovalCompleted(
        f"Removed {removed} × {item.name} from your cart.", updated, receipt=receipt
    )
