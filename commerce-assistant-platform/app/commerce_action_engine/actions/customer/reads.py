"""Customer read ports and bounded wishlist product retrieval."""

from typing import Any, Protocol
from uuid import UUID

from app.commerce_action_engine.contracts import AssistantDelivery
from app.commerce_action_engine.shared.errors import ToolUnavailable


class DeliveryReader(Protocol):
    """Read delivery availability using scoped catalog access and selected coordinates."""

    async def delivery(self) -> AssistantDelivery: ...


class CustomerReader(Protocol):
    async def wishlist(self) -> list[UUID]: ...
    async def product(self, product_id: UUID) -> dict[str, Any]: ...
    async def locations(self) -> list[dict[str, Any]]: ...


class WishlistManager(CustomerReader, Protocol):
    async def search_cart_product(self, query: str) -> list[dict[str, Any]]: ...
    async def remove_wishlist_item(self, product_id: UUID) -> None: ...


async def wishlist_products(
    product_ids: list[UUID], reader: CustomerReader
) -> list[dict[str, Any]]:
    """Read only the first three saved products; unavailable entries are skipped."""
    products = []
    for product_id in product_ids[:3]:
        try:
            products.append(await reader.product(product_id))
        except ToolUnavailable:
            continue
    return products
