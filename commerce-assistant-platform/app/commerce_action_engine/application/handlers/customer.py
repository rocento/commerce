"""Application presentation for customer reads; turn lifecycle stays centralized."""

from collections.abc import AsyncGenerator, Callable
from typing import Any, assert_never

from app.commerce_action_engine.actions.catalog.references import suggestions
from app.commerce_action_engine.actions.customer import (
    CustomerReader,
    wishlist_products,
    wishlist_removal,
)
from app.commerce_action_engine.actions.customer.reads import WishlistManager
from app.commerce_action_engine.application.ports import EventFactory
from app.commerce_action_engine.contracts import AssistantEvent
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.platform import phase


def wishlist_reference(request: InterpretedRequest) -> str | None:
    reference = request.entities.get("productText")
    if reference is not None and not isinstance(reference, str):
        raise ValueError("Invalid wishlist product reference")
    return reference


def wishlist_product(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item["id"],
        "image_id": item.get("image_id"),
        "name": item["name"],
        "price": item["price"],
        "currency": item["currency"],
        "in_stock": item["in_stock"],
        "route": item["route"],
        "attributes": [
            {
                "name": attribute["name"],
                "value": attribute["value"],
            }
            for attribute in item["attributes"][:20]
        ],
        "reasons": [],
        "unmet": [],
    }


async def saved_address_events(
    *,
    authenticated: bool,
    metadata: dict[str, object],
    make_event: EventFactory,
) -> AsyncGenerator[AssistantEvent, None]:
    metadata["route_reason"] = "saved_addresses"
    if not authenticated:
        yield make_event(
            "message.delta",
            text="Please sign in to view your saved addresses.",
            code="login_required",
        )
    else:
        yield make_event("message.delta", text="Here are your saved addresses.")
        yield make_event("content.blocks", blocks=[{"kind": "saved_addresses"}])


def _clear_text(outcome: wishlist_removal.WishlistClearResult) -> str:
    if isinstance(outcome, wishlist_removal.WishlistEmpty):
        return "Your wishlist is empty."
    if isinstance(outcome, wishlist_removal.WishlistClearLimit):
        return f"Your wishlist has more than {outcome.limit} items. Please manage it from your wishlist page; no items have been removed."
    if isinstance(outcome, wishlist_removal.WishlistClearRemaining):
        return "Some requested items are still saved. Please review your wishlist before retrying. Your cart has not been changed."
    if isinstance(outcome, wishlist_removal.WishlistClearCompleted):
        return (
            "Your wishlist is now empty. Your cart has not been changed."
            if not outcome.remaining_ids
            else "The requested saved items were removed, but your wishlist still contains items. Please review your wishlist."
        )
    if isinstance(
        outcome,
        (
            wishlist_removal.WishlistClearRemovalUnverified,
            wishlist_removal.WishlistClearVerificationUnavailable,
        ),
    ):
        return "I couldn't confirm that every saved item was removed. Some items may have been removed; please review your wishlist before retrying. Your cart has not been changed."
    assert_never(outcome)


async def wishlist_events(
    *,
    authenticated: bool,
    managing: bool,
    commerce_tools: Callable[[], WishlistManager],
    metadata: dict[str, object],
    make_event: EventFactory,
    reference: str | None = None,
) -> AsyncGenerator[AssistantEvent, None]:
    if not authenticated:
        metadata["route_reason"] = "login_required"
        yield make_event(
            "message.delta",
            text="Please sign in to view your wishlist.",
            code="login_required",
        )
    else:
        metadata["route_reason"] = "wishlist_read"
        yield make_event("progress", stage="catalog")
        metadata.update({"tools": ["wishlist_read"], "tool_calls": 1})
        with phase("tool"):
            product_ids = await commerce_tools().wishlist()
        if not product_ids:
            yield make_event("message.delta", text="Your wishlist is empty.")
        else:
            if managing and reference in {"all", "all items", "everything"}:
                tools = commerce_tools()
                outcome = await wishlist_removal.clear_wishlist(product_ids, tools)
                if not isinstance(
                    outcome,
                    (
                        wishlist_removal.WishlistEmpty,
                        wishlist_removal.WishlistClearLimit,
                    ),
                ):
                    metadata.update(
                        route_reason="wishlist_clear",
                        tools=["wishlist_read", "wishlist_remove"],
                        tool_calls=outcome.attempted_calls,
                    )
                text = _clear_text(outcome)
                yield make_event("message.delta", text=text)
                return
            if managing and isinstance(reference, str) and reference.strip():
                tools = commerce_tools()
                metadata.update(
                    tools=["wishlist_read", "search_products"], tool_calls=2
                )
                with phase("tool"):
                    found = await tools.search_cart_product(reference)
                selected = wishlist_removal.match_removal(product_ids, found, reference)
                if isinstance(selected, wishlist_removal.WishlistRemovalReady):
                    metadata.update(
                        route_reason="wishlist_remove",
                        tools=["wishlist_read", "search_products", "wishlist_remove"],
                        tool_calls=3,
                    )
                    removed = await wishlist_removal.remove_selected(
                        selected, tools, measure_write=lambda: phase("tool")
                    )
                    if isinstance(removed, wishlist_removal.WishlistRemoved):
                        text = f"Removed {removed.name} from your wishlist."
                    elif isinstance(
                        removed, wishlist_removal.WishlistRemovalUnverified
                    ):
                        text = "I couldn't confirm removal. Please check your wishlist before trying again."
                    else:
                        assert_never(removed)
                    yield make_event("message.delta", text=text)
                    return
                if isinstance(selected, wishlist_removal.WishlistRemovalNotFound):
                    yield make_event("message.delta", text=suggestions([]))
                    return
                if not isinstance(selected, wishlist_removal.WishlistRemovalChoice):
                    assert_never(selected)
                items = list(selected.items)
                yield make_event(
                    "message.delta",
                    text="I found matching products in your wishlist. Confirm the exact product below to remove it. No changes have been made.",
                )
            else:
                items = await wishlist_products(product_ids, commerce_tools())
            products = [wishlist_product(item) for item in items]
            if products:
                message = (
                    f"I found {len(product_ids)} saved items. Choose one of the items below to remove it; each button removes only that item. Showing up to three."
                    if managing
                    else f"You have {len(product_ids)} saved item{'s' if len(product_ids) != 1 else ''} in your wishlist. Here are up to three:"
                )
                if not (managing and reference):
                    yield make_event("message.delta", text=message)
                yield make_event(
                    "content.blocks",
                    blocks=[
                        {
                            "kind": "wishlist_manage" if managing else "product_list",
                            "title": "Choose an item to remove"
                            if managing
                            else "Your wishlist",
                            "products": products,
                            "sources": [
                                {
                                    "kind": "catalog",
                                    "product_id": p["id"],
                                    "route": p["route"],
                                }
                                for p in products
                            ],
                        }
                    ],
                )
            else:
                yield make_event(
                    "message.delta",
                    text=f"Your wishlist has {len(product_ids)} saved item{'s' if len(product_ids) != 1 else ''}, but I couldn't load their current product details.",
                )


async def location_events(
    *,
    authenticated: bool,
    request: InterpretedRequest,
    commerce_tools: Callable[[], CustomerReader],
    metadata: dict[str, object],
    make_event: EventFactory,
) -> AsyncGenerator[AssistantEvent, None]:
    if request.legacy_intent == "ACCOUNT_ADDRESS_ADD":
        metadata["route_reason"] = "new_address_form"
        yield make_event(
            "message.delta",
            text="Enter your new delivery address in the form, then save it when you're ready.",
            code="open_address_form",
        )
        return
    if not authenticated:
        yield make_event(
            "message.delta",
            text="Please sign in to view your saved addresses.",
            code="login_required",
        )
    else:
        metadata["route_reason"] = "saved_locations_read"
        metadata.update({"tools": ["location_list"], "tool_calls": 1})
        locations = await commerce_tools().locations()
        if not locations:
            yield make_event("message.delta", text="You have no saved addresses.")
        else:
            lines = [
                f"{item['label']}{' (default)' if item['is_default'] else ''}: {item['formatted_address']}"
                for item in locations
            ]
            text = "Your saved addresses:\n" + "\n".join(lines)
            if request.legacy_intent != "ACCOUNT_ADDRESS_LIST":
                text += (
                    "\n\nReview the address in your account before confirming a change."
                )
            yield make_event("message.delta", text=text)
