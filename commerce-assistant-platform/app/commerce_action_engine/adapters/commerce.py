"""Fixed typed registry; no model-selected methods, URLs or redirects."""

from typing import Any
from uuid import UUID

import httpx

from app.commerce_action_engine.actions.catalog.bestsellers import (
    Bestsellers,
    SalesPeriod,
)
from app.commerce_action_engine.actions.catalog.discounts import DiscountRecommendations
from app.commerce_action_engine.actions.customer.transfers import (
    WishlistTransferReceipt,
)
from app.commerce_action_engine.adapters.cart import CartTransport
from app.commerce_action_engine.adapters.delivery import DeliveryTransport
from app.commerce_action_engine.adapters.orders import OrderTransport
from app.commerce_action_engine.adapters.read_budget import CommerceReadBudget
from app.commerce_action_engine.adapters.shopper_catalog import ShopperCatalogTransport
from app.commerce_action_engine.adapters.support import SupportTransport
from app.commerce_action_engine.adapters.wishlist import WishlistTransport
from app.commerce_action_engine.contracts import (
    AssistantCart,
    AssistantDelivery,
    AssistantOrder,
    AssistantTicket,
    AssistantTicketDetail,
)
from app.commerce_action_engine.shared.errors import (
    ToolDenied as ToolDenied,  # noqa: PLC0414 -- stable public re-export
)
from app.commerce_action_engine.shared.errors import (
    ToolUnavailable as ToolUnavailable,  # noqa: PLC0414 -- stable public re-export
)
from app.commerce_resolution_engine.diagnostics import traced


class CommerceTools:
    def __init__(
        self,
        client: httpx.AsyncClient,
        capability: str,
        cart_capability: str = "",
        catalog_capability: str = "",
        delivery_headers: dict[str, str] | None = None,
        wishlist_capability: str = "",
        locations_capability: str = "",
        support_capability: str = "",
        cart_write_capability: str = "",
        wishlist_write_capability: str = "",
        wishlist_cart_transfer_capability: str = "",
        compound_read_capability: str = "",
        compound_write_capability: str = "",
        *,
        read_budget: CommerceReadBudget | None = None,
    ):
        self.client = client
        self.capability = capability
        self.cart_capability = cart_capability
        self.catalog_capability = catalog_capability
        self.delivery_headers = delivery_headers or {}
        self.wishlist_capability = wishlist_capability
        self.locations_capability = locations_capability
        self.support_capability = support_capability
        self.cart_write_capability = cart_write_capability
        self.wishlist_write_capability = wishlist_write_capability
        self.wishlist_cart_transfer_capability = wishlist_cart_transfer_capability
        self.compound_read_capability = compound_read_capability
        self.compound_write_capability = compound_write_capability
        from app.commerce_action_engine.adapters.compound import CompoundCommerce

        self.compound = CompoundCommerce(
            client, compound_read_capability, compound_write_capability
        )
        self.read_budget = (
            read_budget if read_budget is not None else CommerceReadBudget()
        )

    def _catalog_transport(self) -> ShopperCatalogTransport:
        return ShopperCatalogTransport(
            self.client,
            self.catalog_capability,
            self.delivery_headers,
            reserve_read=self._reserve_read,
        )

    @traced
    async def discounts(self) -> DiscountRecommendations:
        return await self._catalog_transport().discounts()

    @traced
    async def bestsellers(self, period: "SalesPeriod") -> "Bestsellers":
        return await self._catalog_transport().bestsellers(period)

    @traced
    async def cart(self) -> AssistantCart:
        return await self._cart_transport().cart()

    @traced
    async def change_cart(self, change: dict[str, Any]) -> AssistantCart:
        return await self._cart_transport().change_cart(change)

    @property
    def calls(self) -> int:
        return self.read_budget.calls

    def _reserve_read(self, limit: int = 4) -> None:
        self.read_budget.reserve(limit)

    def _cart_transport(self) -> CartTransport:
        return CartTransport(
            self.client,
            self.cart_capability,
            self.cart_write_capability,
            self.delivery_headers,
            reserve_read=self._reserve_read,
        )

    @traced
    async def transfer_wishlist_to_cart(
        self, product_ids: list[UUID]
    ) -> WishlistTransferReceipt:
        return await self._wishlist_transport().transfer_wishlist_to_cart(product_ids)

    @traced
    async def search_cart_product(self, query: str) -> list[dict[str, Any]]:
        return await self._catalog_transport().search_cart_product(query)

    def _wishlist_transport(self) -> WishlistTransport:
        return WishlistTransport(
            self.client,
            self.wishlist_capability,
            self.wishlist_write_capability,
            self.wishlist_cart_transfer_capability,
            reserve_read=self._reserve_read,
        )

    @traced
    async def wishlist(self) -> list[UUID]:
        return await self._wishlist_transport().wishlist()

    @traced
    async def remove_wishlist_item(self, product_id: UUID) -> None:
        await self._wishlist_transport().remove_wishlist_item(product_id)

    @traced
    async def add_wishlist_item(self, product_id: UUID) -> None:
        await self._wishlist_transport().add_wishlist_item(product_id)

    @traced
    async def product(self, product_id: UUID) -> dict[str, Any]:
        return await self._catalog_transport().product(product_id)

    def _delivery_transport(self) -> DeliveryTransport:
        return DeliveryTransport(
            self.client,
            self.catalog_capability,
            self.locations_capability,
            self.delivery_headers,
            reserve_read=self._reserve_read,
        )

    @traced
    async def delivery(self) -> AssistantDelivery:
        return await self._delivery_transport().delivery()

    @traced
    async def locations(self) -> list[dict[str, Any]]:
        return await self._delivery_transport().locations()

    def _support_transport(self) -> SupportTransport:
        return SupportTransport(
            self.client,
            self.support_capability,
            self.capability,
            reserve_call=self._reserve_read,
        )

    @traced
    async def support_tickets(self) -> list[AssistantTicket]:
        return await self._support_transport().support_tickets()

    @traced
    async def support_ticket(self, ticket_id: UUID) -> AssistantTicketDetail:
        return await self._support_transport().support_ticket(ticket_id)

    def _order_transport(self) -> OrderTransport:
        return OrderTransport(
            self.client, self.capability, reserve_read=self._reserve_read
        )

    @traced
    async def call(self, name: str, arguments: dict[str, Any]) -> AssistantOrder:
        return await self._order_transport().call(name, arguments)

    @traced
    async def orders(self) -> list[AssistantOrder]:
        return await self._order_transport().orders()

    @traced
    async def oldest_order(self) -> list[AssistantOrder]:
        return await self._order_transport().oldest_order()

    @traced
    async def order_by_number(self, number: int) -> AssistantOrder:
        return await self._order_transport().order_by_number(number)

    @traced
    async def create_ticket(self, arguments: dict[str, Any]) -> "AssistantTicketDetail":
        return await self._support_transport().create_ticket(arguments)
