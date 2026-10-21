"""Coordinate admitted cart actions and present their authoritative outcomes.

Turn routing, sequencing, persistence and resource lifetime remain application
turn responsibilities. Domain services retain mutation and receipt policy.
"""

from collections.abc import AsyncGenerator, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol, assert_never
from uuid import UUID

from app.commerce_action_engine.actions.catalog import Product
from app.commerce_action_engine.actions.customer import DeliveryReader, cart_to_wishlist
from app.commerce_action_engine.actions.shopping import cart as cart_actions
from app.commerce_action_engine.actions.shopping import cart_removal
from app.commerce_action_engine.application.handlers.cart_read import (
    cart_read_events as cart_read_events,  # noqa: PLC0414 -- compatibility export
)
from app.commerce_action_engine.application.ports import EventFactory
from app.commerce_action_engine.application.responses import (
    card,
    cart_block,
    catalog_block,
)
from app.commerce_action_engine.contracts import (
    AssistantCart,
    AssistantEvent,
    AssistantProductPrompt,
)
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.shared.errors import ToolUnavailable


class CartJourneyPort(cart_actions.CartActions, DeliveryReader, Protocol):
    """Cart operations plus the current delivery/catalog reads used by this handler."""

    @property
    def delivery_headers(self) -> Mapping[str, str]: ...

    async def product(self, product_id: UUID) -> dict[str, Any]: ...


@dataclass(frozen=True)
class CartSelection:
    """Application projection of a parsed UI follow-up; never grants authority."""

    product_id: UUID | None
    intent: str
    product: bool = False
    confirmed: bool = False


def _removal_blocks(
    outcome: cart_removal.RemovalResult, requested_quantity: object
) -> list[dict[str, Any]]:
    """Present each removal state without inferring it from optional fields."""
    if isinstance(outcome, cart_removal.RemovalCompleted):
        return [
            {
                "kind": "cart_removal",
                "cart_removal": outcome.receipt.model_dump(mode="json"),
            }
        ]
    if isinstance(
        outcome,
        (cart_removal.RemovalNeedsChoice, cart_removal.RemovalNeedsConfirmation),
    ):
        return [
            {
                "kind": "cart_removal_choice",
                "cart_removal_choice": {
                    "items": [item.model_dump(mode="json") for item in outcome.choices],
                    "quantity": requested_quantity,
                },
            }
        ]
    if isinstance(
        outcome,
        (
            cart_removal.RemovalNeedsInput,
            cart_removal.RemovalNoChange,
            cart_removal.RemovalUnverified,
        ),
    ):
        blocks: list[dict[str, Any]] = [{"kind": "text", "text": outcome.text}]
        if outcome.cart is not None:
            blocks.append(
                cart_block(outcome.cart).model_dump(mode="json", exclude_unset=True)
            )
        return blocks
    assert_never(outcome)


def _wishlist_fields(
    outcome: cart_to_wishlist.WishlistResult,
) -> tuple[str, AssistantCart | None, list[dict[str, Any]]]:
    """Project explicit outcomes into the existing cart response layout."""
    if isinstance(outcome, cart_to_wishlist.WishlistNeedsChoice):
        return outcome.text, outcome.cart, list(outcome.choices)
    if isinstance(outcome, cart_to_wishlist.WishlistRemovalUnverified):
        # The pre-write snapshot must not be presented as the current cart.
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


def _cart_fields(
    outcome: cart_actions.CartResult,
) -> tuple[str, AssistantCart | None, list[dict[str, Any]]]:
    """Render explicit cart states into the unchanged response layout."""
    if isinstance(outcome, cart_actions.CartNeedsChoice):
        return outcome.text, outcome.cart, list(outcome.choices)
    if isinstance(outcome, cart_actions.CartUpdateUnverified):
        return outcome.text, None, []
    if isinstance(
        outcome,
        (
            cart_actions.CartNeedsInput,
            cart_actions.CartNoChange,
            cart_actions.CartUpdated,
            cart_actions.CartCheckoutReady,
        ),
    ):
        return outcome.text, outcome.cart, []
    assert_never(outcome)


async def cart_events(
    *,
    authenticated: bool,
    request: InterpretedRequest,
    message: str,
    selection: CartSelection | None,
    commerce_tools: Callable[[], CartJourneyPort],
    metadata: dict[str, object],
    make_event: EventFactory,
) -> AsyncGenerator[AssistantEvent, None]:
    tools = commerce_tools()
    if not authenticated:
        yield make_event(
            "message.delta",
            text="Please sign in to change your cart or checkout.",
            code="login_required",
        )
    elif (
        request.legacy_intent == "ADD_TO_CART"
        and not tools.delivery_headers.get("x-delivery-latitude")
        and (await tools.delivery()).configured
    ):
        metadata["route_reason"] = "delivery_location_required"
        yield make_event(
            "message.delta",
            text="Choose a delivery address so I can check which products are available near you. Then send your add request again. Your cart has not been changed.",
            code="area_unavailable",
        )
    else:
        metadata["route_reason"] = "cart_action"
        choices: list[dict[str, Any]]
        checkout_ready = False
        try:
            selected_product = None
            if (
                selection
                and selection.product
                and selection.product_id is not None
                and request.legacy_intent == selection.intent
                and request.legacy_intent != "REMOVE_FROM_CART"
            ):
                selected_product = await tools.product(selection.product_id)
                if str(selected_product["id"]) != str(selection.product_id):
                    raise ToolUnavailable()
                # Preserve trusted identity and validated intent/quantity;
                # only bind the current catalog name, then validate again.
                try:
                    request = InterpretedRequest.model_validate(
                        request.model_dump()
                        | {
                            "entities": {
                                **request.entities,
                                "productText": selected_product["name"],
                            }
                        }
                    )
                except ValueError as error:
                    raise ToolUnavailable() from error
            if request.legacy_intent == "REMOVE_FROM_CART":
                removal = await cart_removal.remove_from_cart(
                    request,
                    message,
                    tools,
                    selected_product_id=selection.product_id
                    if selection and selection.intent == request.legacy_intent
                    else None,
                    confirmed=bool(selection and selection.confirmed),
                )
                yield make_event("message.delta", text=removal.text)
                yield make_event(
                    "content.blocks",
                    blocks=_removal_blocks(removal, request.entities.get("quantity")),
                )
                return
            if request.legacy_intent in cart_actions.WISHLIST_INTENTS:
                wishlist = await cart_to_wishlist.execute(
                    request,
                    message,
                    tools,
                    selected_product=selected_product,
                )
                text, cart, choices = _wishlist_fields(wishlist)
            else:
                outcome = await cart_actions.execute_cart(
                    request,
                    message,
                    tools,
                    selected_product=selected_product,
                )
                text, cart, choices = _cart_fields(outcome)
                # Only bare checkout requests open the UI automatically; other
                # admitted checkout requests retain their ordinary link response.
                checkout_ready = (
                    isinstance(outcome, cart_actions.CartCheckoutReady)
                    and not request.entities
                )
        except ToolUnavailable:
            text, cart, choices = (
                "I couldn't load your cart. Please try again or open your cart.",
                None,
                [],
            )
        response_blocks = []
        if choices:
            products = [Product.model_validate(p) for p in choices]
            prompt_query = request.entities.get("productText")
            prompt_quantity = request.entities.get("quantity", 1)
            if (
                request.legacy_intent in {"ADD_TO_CART", "ADD_TO_WISHLIST"}
                and isinstance(prompt_query, str)
                and 0 < len(prompt_query.strip()) <= 120
                and type(prompt_quantity) is int
                and 1 <= prompt_quantity <= 1000000
                and "unit" not in request.entities
            ):
                prompt = AssistantProductPrompt(
                    query=prompt_query,
                    quantity=prompt_quantity,
                    action="cart"
                    if request.legacy_intent == "ADD_TO_CART"
                    else "wishlist",
                )
                text = "Please choose the exact product below. You can also search by name, SKU or category."
                response_blocks.append(
                    {
                        "kind": "product_prompt",
                        "product_prompt": prompt.model_dump(),
                    }
                )
            else:
                response_blocks.append(
                    catalog_block(
                        "product_list",
                        [card(product, [], []) for product in products],
                        "Choose a product to add",
                    ).model_dump(mode="json", exclude_unset=True)
                )
        yield make_event(
            "message.delta",
            text=text,
            **({"code": "open_checkout"} if checkout_ready else {}),
        )
        response_blocks.insert(0, {"kind": "text", "text": text})
        if cart is not None and not choices:
            response_blocks.append(
                cart_block(cart).model_dump(mode="json", exclude_unset=True)
            )
        yield make_event("content.blocks", blocks=response_blocks)
