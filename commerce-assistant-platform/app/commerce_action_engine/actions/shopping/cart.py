"""Execute explicit cart instructions using authoritative product identities."""

import re
from dataclasses import dataclass
from typing import Any, Literal, Protocol, assert_never
from uuid import UUID

from app.commerce_action_engine.actions.catalog.references import (
    exact_products,
    suggestions,
)
from app.commerce_action_engine.actions.customer import cart_to_wishlist
from app.commerce_action_engine.actions.shopping.cart_admission import (
    CHECKOUT_INTENTS as CHECKOUT_INTENTS,  # noqa: PLC0414 -- compatibility export
)
from app.commerce_action_engine.actions.shopping.cart_admission import (
    WISHLIST_INTENTS as WISHLIST_INTENTS,  # noqa: PLC0414 -- shared routing contract
)
from app.commerce_action_engine.actions.shopping.cart_admission import (
    WRITE_INTENTS as WRITE_INTENTS,  # noqa: PLC0414 -- compatibility export
)
from app.commerce_action_engine.actions.shopping.cart_admission import (
    admission_error,
)
from app.commerce_action_engine.actions.shopping.cart_admission import (
    normalized as normalized,  # noqa: PLC0414 -- compatibility export
)
from app.commerce_action_engine.actions.shopping.cart_read import (
    CartReader as CartReader,  # noqa: PLC0414 -- compatibility export
)
from app.commerce_action_engine.contracts import AssistantCart
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.shared.errors import ToolUnavailable


class CartMutationActions(CartReader, Protocol):
    """Narrow authority used by cart changes and checkout handoff."""

    async def change_cart(self, change: dict[str, Any]) -> AssistantCart: ...
    async def search_cart_product(self, query: str) -> list[dict[str, Any]]: ...


class CartActions(CartMutationActions, Protocol):
    """Authorized operations needed by cart and cart-to-wishlist journeys.

    Implementations own capability checks and transport. Writes return the
    authoritative snapshot and must not be retried after an uncertain outcome.
    """

    async def add_wishlist_item(self, product_id: UUID) -> None: ...


@dataclass(frozen=True)
class CartNeedsInput:
    text: str
    cart: AssistantCart | None = None


@dataclass(frozen=True)
class CartNeedsChoice:
    text: str
    cart: AssistantCart
    choices: tuple[dict[str, Any], ...]


@dataclass(frozen=True)
class CartNoChange:
    """No mutation was attempted."""

    text: str
    cart: AssistantCart
    reason: Literal["empty_cart", "not_found"]


@dataclass(frozen=True)
class CartUpdated:
    """The existing mutation port acknowledged the write with its cart response."""

    text: str
    cart: AssistantCart


@dataclass(frozen=True)
class CartUpdateUnverified:
    """A write was attempted; no current snapshot or retry is safe to infer."""

    text: str


@dataclass(frozen=True)
class CartCheckoutReady:
    """An admitted checkout request has a nonempty cart; no order was placed."""

    text: str
    cart: AssistantCart


type CartResult = (
    CartNeedsInput
    | CartNeedsChoice
    | CartNoChange
    | CartUpdated
    | CartUpdateUnverified
    | CartCheckoutReady
)


def _legacy_cart_result(
    outcome: CartResult,
) -> tuple[str, AssistantCart | None, list[dict[str, Any]]]:
    if isinstance(outcome, CartNeedsChoice):
        return outcome.text, outcome.cart, list(outcome.choices)
    if isinstance(outcome, CartUpdateUnverified):
        return outcome.text, None, []
    if isinstance(
        outcome, (CartNeedsInput, CartNoChange, CartUpdated, CartCheckoutReady)
    ):
        return outcome.text, outcome.cart, []
    assert_never(outcome)


def _legacy_wishlist_result(
    outcome: cart_to_wishlist.WishlistResult,
) -> tuple[str, AssistantCart | None, list[dict[str, Any]]]:
    """Keep the existing execute API; the application uses typed outcomes directly."""
    if isinstance(outcome, cart_to_wishlist.WishlistNeedsChoice):
        return outcome.text, outcome.cart, list(outcome.choices)
    if isinstance(outcome, cart_to_wishlist.WishlistRemovalUnverified):
        return outcome.text, None, []
    if isinstance(
        outcome,
        (
            cart_to_wishlist.WishlistNeedsInput,
            cart_to_wishlist.WishlistNotFound,
            cart_to_wishlist.WishlistAddUnverified,
            cart_to_wishlist.WishlistRemovalMismatch,
            cart_to_wishlist.WishlistSaved,
            cart_to_wishlist.WishlistMoved,
        ),
    ):
        return outcome.text, outcome.cart, []
    assert_never(outcome)


async def execute(
    result: InterpretedRequest,
    message: str,
    tools: CartActions,
    *,
    selected_product: dict[str, Any] | None = None,
) -> tuple[str, AssistantCart | None, list[dict[str, Any]]]:
    """Compatibility entry point; new cart callers consume execute_cart outcomes."""
    if result.legacy_intent == "REMOVE_FROM_CART":
        from app.commerce_action_engine.actions.shopping.cart_removal import (
            RemovalNeedsChoice,
            RemovalNeedsConfirmation,
            remove_from_cart,
        )

        outcome = await remove_from_cart(
            result,
            message,
            tools,
            selected_product_id=UUID(str(selected_product["id"]))
            if selected_product
            else None,
        )
        return (
            outcome.text,
            outcome.cart,
            [item.model_dump(mode="json") for item in outcome.choices]
            if isinstance(outcome, (RemovalNeedsChoice, RemovalNeedsConfirmation))
            else [],
        )
    if result.legacy_intent in WISHLIST_INTENTS:
        return _legacy_wishlist_result(
            await cart_to_wishlist.execute(
                result,
                message,
                tools,
                selected_product=selected_product,
            )
        )
    return _legacy_cart_result(
        await execute_cart(result, message, tools, selected_product=selected_product)
    )


async def execute_cart(
    result: InterpretedRequest,
    message: str,
    tools: CartMutationActions,
    *,
    selected_product: dict[str, Any] | None = None,
) -> CartResult:
    """Execute add/set/clear or prepare checkout without owning stream lifetime."""
    if error := admission_error(result):
        return CartNeedsInput(error)
    if result.legacy_intent in WISHLIST_INTENTS | {"REMOVE_FROM_CART"}:
        return CartNeedsInput(
            "Please provide a complete cart instruction before I make a change."
        )
    change: dict[str, Any]
    cart = await tools.cart()
    if result.legacy_intent in CHECKOUT_INTENTS:
        if not cart.items:
            return CartNoChange(
                "Your cart is empty. Add products before checkout.", cart, "empty_cart"
            )
        return CartCheckoutReady(
            "[Continue to checkout](/checkout) to confirm delivery, payment and place your order.",
            cart,
        )
    if result.legacy_intent == "CLEAR_CART":
        if not cart.items:
            return CartNoChange("Your cart is already empty.", cart, "empty_cart")
        change = {"action": "clear"}
        success = "Your cart has been cleared."
    else:
        query = result.entities.get("productText")
        # Match full catalog names in the actual instruction, including pack sizes.
        candidates = [
            item
            for item in cart.items
            if f" {normalized(item.name)} " in f" {normalized(message)} "
        ]
        if isinstance(query, str) and query.strip():
            exact_items = [
                item
                for item in cart.items
                if normalized(item.name) == normalized(query)
            ]
            candidates = exact_items
        if selected_product is not None:
            candidates = [
                item
                for item in cart.items
                if str(item.product_id) == str(selected_product["id"])
            ]
        product_id = None
        name = ""
        if result.legacy_intent == "ADD_TO_CART":
            if len(candidates) == 1:
                query = candidates[0].name
            if not isinstance(query, str) or not query.strip():
                match = re.fullmatch(
                    r"(?:please\s+|pls\s+)?add\s+(?:(?:[0-9]+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(.+?)\s+(?:to|into|in|on)\s+(?:my\s+|the\s+)?(?:cart|basket)[.!]?",
                    message.strip(),
                    re.IGNORECASE,
                )
                query = match.group(1) if match else None
            if not isinstance(query, str) or not query.strip():
                return CartNeedsInput(
                    "Which product would you like to add? Please include its full name and quantity.",
                    cart,
                )
            products = (
                [selected_product]
                if selected_product is not None
                else await tools.search_cart_product(query)
            )
            exact = (
                [selected_product]
                if selected_product is not None
                else exact_products(products, query)
            )
            if len(exact) == 1:
                product_id, name = str(exact[0]["id"]), exact[0]["name"]
            else:
                choices = list({str(p["id"]): p for p in products}.values())[:5]
                if choices:
                    return CartNeedsChoice(suggestions(choices), cart, tuple(choices))
                return CartNoChange(suggestions(choices), cart, "not_found")
        elif len(candidates) == 1:
            product_id, name = str(candidates[0].product_id), candidates[0].name
        else:
            if isinstance(query, str) and query.strip():
                products = await tools.search_cart_product(query)
                ids = {str(item.product_id) for item in cart.items}
                products = [p for p in products if str(p["id"]) in ids]
                exact = exact_products(products, query)
                if len(exact) == 1:
                    product_id, name = str(exact[0]["id"]), exact[0]["name"]
                    candidates = [
                        item
                        for item in cart.items
                        if str(item.product_id) == product_id
                    ]
                else:
                    if products:
                        return CartNeedsChoice(
                            suggestions(products), cart, tuple(products[:5])
                        )
                    return CartNoChange(suggestions(products), cart, "not_found")
            else:
                return CartNeedsInput(
                    "Please specify the full name or SKU of one product in your cart to change.",
                    cart,
                )
        quantity = result.entities.get("quantity")
        if quantity is None and result.legacy_intent == "ADD_TO_CART":
            quantity = 1
        if type(quantity) is not int or not 0 <= quantity <= 1000000:
            return CartNeedsInput(
                "What quantity should I use? Please provide a whole number.",
                cart,
            )
        if quantity == 0 and result.legacy_intent == "ADD_TO_CART":
            return CartNeedsInput(
                "Please specify a quantity of at least 1 to add.", cart
            )
        action = "add" if result.legacy_intent == "ADD_TO_CART" else "set"
        change = {"action": action, "product_id": product_id, "quantity": quantity}
        if quantity == 0:
            change = {"action": "remove", "product_id": product_id}
            success = f"Removed {name} from your cart."
        elif action == "add":
            success = f"Added {quantity} × {name} to your cart."
        else:
            success = f"Changed {name} quantity to {quantity}."
    try:
        updated = await tools.change_cart(change)
    except ToolUnavailable:
        return CartUpdateUnverified(
            "I couldn't confirm the cart update. [Open your cart](/cart) to check its current contents before trying again.",
        )
    return CartUpdated(success, updated)
