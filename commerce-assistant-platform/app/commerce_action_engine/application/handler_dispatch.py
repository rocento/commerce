"""Bind admitted standard routes to feature handlers.

Interpretation, permission/clarification precedence and fallback policy belong to
the turn. This registry neither interprets language nor grants capabilities. Each
binding receives the same request context; feature handlers retain narrow ports.
"""

from collections.abc import AsyncGenerator, Callable, Mapping
from contextlib import aclosing
from dataclasses import dataclass
from enum import StrEnum
from types import MappingProxyType
from uuid import UUID

from app.commerce_action_engine.adapters.commerce import CommerceTools
from app.commerce_action_engine.application.handlers import (
    bestsellers,
    cart,
    comparison,
    customer,
    discounts,
    orders,
    product_facts,
    reorder,
    support,
    wishlist_transfer,
)
from app.commerce_action_engine.application.ports import EventFactory
from app.commerce_action_engine.contracts import AssistantEvent
from app.commerce_action_engine.contracts.action import Journey
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_resolution_engine.diagnostics import debug_record


class HandlerRoute(StrEnum):
    PRODUCT_FACT = "product_fact"
    REORDER = "reorder"
    COMPARISON = "comparison"
    COMPARISON_CLEAR = "comparison_clear"
    DISCOUNTS = "discounts"
    BESTSELLERS = "bestsellers"
    ORDER = "order"
    CART_ACTION = "cart_action"
    WISHLIST_TO_CART = "wishlist_to_cart"
    WISHLIST = "wishlist"
    WISHLIST_REMOVE = "wishlist_remove"
    LOCATIONS = "locations"
    SUPPORT = "support"
    SHIPMENT = "shipment"
    SUPPORT_DETAIL = "support_detail"


@dataclass(frozen=True)
class HandlerContext:
    request: InterpretedRequest
    authenticated: bool
    message: str
    commerce_tools: Callable[[], CommerceTools]
    metadata: dict[str, object]
    make_event: EventFactory
    product_id: UUID | None = None
    order_id: UUID | None = None
    cart_selection: cart.CartSelection | None = None


Handler = Callable[[HandlerContext], AsyncGenerator[AssistantEvent, None]]


@dataclass(frozen=True)
class HandlerBinding:
    journey: Journey
    handler: Handler

    async def events(
        self, context: HandlerContext
    ) -> AsyncGenerator[AssistantEvent, None]:
        """Close the selected handler on completion, error or consumer disconnect.

        The turn still owns event sequencing, persistence and resource lifetime.
        A handler failure propagates without selecting or retrying another route.
        """
        debug_record(
            "handler_dispatch",
            {
                "handler": self.handler.__name__,
                "journey": self.journey,
                "intent": context.request.legacy_intent,
            },
        )
        async with aclosing(self.handler(context)) as events:
            async for event in events:
                yield event


def _product_fact(context: HandlerContext) -> AsyncGenerator[AssistantEvent, None]:
    return product_facts.product_fact_events(
        context.commerce_tools(),
        context.request,
        context.make_event,
        context.metadata,
        product_id=context.product_id,
        original_message=context.message,
    )


def _reorder(context: HandlerContext) -> AsyncGenerator[AssistantEvent, None]:
    context.metadata["route_reason"] = "reorder_review"
    return reorder.reorder_events(
        request=context.request,
        commerce_tools=context.commerce_tools,
        selected_id=context.order_id,
        authenticated=context.authenticated,
        make_event=context.make_event,
    )


def _comparison(context: HandlerContext) -> AsyncGenerator[AssistantEvent, None]:
    return comparison.comparison_events(
        request=context.request,
        commerce_tools=context.commerce_tools,
        make_event=context.make_event,
        metadata=context.metadata,
    )


def _discounts(context: HandlerContext) -> AsyncGenerator[AssistantEvent, None]:
    context.metadata.update(tools=["get_discount_recommendations"], tool_calls=1)
    return discounts.discount_events(context.commerce_tools(), context.make_event)


def _bestsellers(context: HandlerContext) -> AsyncGenerator[AssistantEvent, None]:
    return bestsellers.bestseller_events(
        request=context.request,
        commerce_tools=context.commerce_tools,
        metadata=context.metadata,
        make_event=context.make_event,
    )


def _order(context: HandlerContext) -> AsyncGenerator[AssistantEvent, None]:
    return orders.order_events(
        authenticated=context.authenticated,
        request=context.request,
        selected_id=context.order_id,
        message=context.message,
        commerce_tools=context.commerce_tools,
        metadata=context.metadata,
        make_event=context.make_event,
    )


def _cart_action(context: HandlerContext) -> AsyncGenerator[AssistantEvent, None]:
    return cart.cart_events(
        authenticated=context.authenticated,
        request=context.request,
        message=context.message,
        selection=context.cart_selection,
        commerce_tools=context.commerce_tools,
        metadata=context.metadata,
        make_event=context.make_event,
    )


def _wishlist_to_cart(context: HandlerContext) -> AsyncGenerator[AssistantEvent, None]:
    return wishlist_transfer.wishlist_transfer_events(
        authenticated=context.authenticated,
        request=context.request,
        commerce_tools=context.commerce_tools,
        metadata=context.metadata,
        make_event=context.make_event,
    )


def _wishlist(
    context: HandlerContext, *, managing: bool
) -> AsyncGenerator[AssistantEvent, None]:
    return customer.wishlist_events(
        authenticated=context.authenticated,
        managing=managing,
        reference=customer.wishlist_reference(context.request),
        commerce_tools=context.commerce_tools,
        metadata=context.metadata,
        make_event=context.make_event,
    )


def _wishlist_read(context: HandlerContext) -> AsyncGenerator[AssistantEvent, None]:
    return _wishlist(context, managing=False)


def _wishlist_remove(context: HandlerContext) -> AsyncGenerator[AssistantEvent, None]:
    return _wishlist(context, managing=True)


def _locations(context: HandlerContext) -> AsyncGenerator[AssistantEvent, None]:
    return customer.location_events(
        authenticated=context.authenticated,
        request=context.request,
        commerce_tools=context.commerce_tools,
        metadata=context.metadata,
        make_event=context.make_event,
    )


def _support(context: HandlerContext) -> AsyncGenerator[AssistantEvent, None]:
    return support.support_events(
        authenticated=context.authenticated,
        request=context.request,
        commerce_tools=context.commerce_tools,
        metadata=context.metadata,
        make_event=context.make_event,
    )


def _shipment(context: HandlerContext) -> AsyncGenerator[AssistantEvent, None]:
    return orders.shipment_events(
        message=context.message,
        authenticated=context.authenticated,
        request=context.request,
        selected_id=context.order_id,
        commerce_tools=context.commerce_tools,
        metadata=context.metadata,
        make_event=context.make_event,
    )


def _support_detail(context: HandlerContext) -> AsyncGenerator[AssistantEvent, None]:
    return support.support_detail_events(
        authenticated=context.authenticated,
        request=context.request,
        commerce_tools=context.commerce_tools,
        metadata=context.metadata,
        make_event=context.make_event,
    )


HANDLERS: Mapping[HandlerRoute, HandlerBinding] = MappingProxyType(
    {
        HandlerRoute.PRODUCT_FACT: HandlerBinding("general", _product_fact),
        HandlerRoute.REORDER: HandlerBinding("order", _reorder),
        HandlerRoute.COMPARISON: HandlerBinding("discovery", _comparison),
        HandlerRoute.COMPARISON_CLEAR: HandlerBinding("discovery", _comparison),
        HandlerRoute.DISCOUNTS: HandlerBinding("discovery", _discounts),
        HandlerRoute.BESTSELLERS: HandlerBinding("discovery", _bestsellers),
        HandlerRoute.ORDER: HandlerBinding("order", _order),
        HandlerRoute.CART_ACTION: HandlerBinding("cart", _cart_action),
        HandlerRoute.WISHLIST_TO_CART: HandlerBinding("general", _wishlist_to_cart),
        HandlerRoute.WISHLIST: HandlerBinding("general", _wishlist_read),
        HandlerRoute.WISHLIST_REMOVE: HandlerBinding("general", _wishlist_remove),
        HandlerRoute.LOCATIONS: HandlerBinding("general", _locations),
        HandlerRoute.SUPPORT: HandlerBinding("general", _support),
        HandlerRoute.SHIPMENT: HandlerBinding("general", _shipment),
        HandlerRoute.SUPPORT_DETAIL: HandlerBinding("general", _support_detail),
    }
)


def standard_handler(route: str) -> HandlerBinding | None:
    """Look up an allowlisted feature route, without interpreting or executing it.

    Held requests, model/search paths and legacy cart/delivery fallbacks retain
    their explicit precedence in the turn and intentionally have no binding.
    """
    try:
        key = HandlerRoute(route)
    except ValueError:
        return None
    return HANDLERS[key]
