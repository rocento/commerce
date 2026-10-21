"""Authoritative outcome of a bounded wishlist-to-cart command."""

from typing import Any, Literal, Protocol
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from app.commerce_action_engine.contracts import AssistantCart


class WishlistTransferItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    product_id: str
    name: str
    status: Literal["transferred"]
    detail: str


class WishlistTransferReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[WishlistTransferItem]
    cart: AssistantCart


class WishlistTransferPort(Protocol):
    async def wishlist(self) -> list[UUID]: ...

    async def transfer_wishlist_to_cart(
        self, product_ids: list[UUID]
    ) -> WishlistTransferReceipt: ...


class WishlistJourneyPort(WishlistTransferPort, Protocol):
    """Operations required by both selection and named-item transfer journeys."""

    async def search_cart_product(self, query: str) -> list[dict[str, Any]]: ...
    async def change_cart(self, change: dict[str, Any]) -> AssistantCart: ...
    async def remove_wishlist_item(self, product_id: UUID) -> None: ...
