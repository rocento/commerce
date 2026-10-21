"""Exact product identity for compound planning; no mutation capability."""

from typing import Any, Protocol
from uuid import UUID

from . import Product
from .references import exact_products


class ProductReader(Protocol):
    async def search_cart_product(self, query: str) -> list[dict[str, Any]]: ...
    async def product(self, product_id: UUID) -> dict[str, Any]: ...


def exact_candidate(products: list[Product], query: str) -> Product | None:
    matches = exact_products([p.model_dump(mode="json") for p in products], query)
    return Product.model_validate(matches[0]) if len(matches) == 1 else None


def verify_identity(product: Product, expected: Product, query: str) -> bool:
    return product.id == expected.id and exact_candidate([product], query) is not None
