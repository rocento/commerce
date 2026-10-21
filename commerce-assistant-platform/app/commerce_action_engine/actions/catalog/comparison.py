"""Resolve current comparison facts through a read-only catalog port."""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID

from . import Product
from .references import exact_products


class ComparisonReader(Protocol):
    async def search_cart_product(self, query: str) -> list[dict[str, Any]]: ...
    async def product(self, product_id: UUID) -> dict[str, Any]: ...


@dataclass(frozen=True)
class ComparisonMatch:
    product: Product | None
    candidates: list[dict[str, Any]]

    @property
    def requires_variant(self) -> bool:
        return self.product is not None and self.product.product_type != "simple"


@dataclass(frozen=True)
class ComparisonQuery:
    reference: str
    linked_id: str | None = None

    @property
    def tool_name(self) -> str:
        return "get_product" if self.linked_id else "search_products"

    async def execute(self, reader: ComparisonReader) -> ComparisonMatch:
        if self.linked_id:
            product_id = UUID(self.linked_id)
            selected = await reader.product(product_id)
            found = [selected]
            exact = found if str(selected["id"]) == str(product_id) else []
        else:
            found = await reader.search_cart_product(self.reference)
            exact = exact_products(found, self.reference)
        if len(exact) != 1:
            return ComparisonMatch(None, found)
        product = Product.model_validate(exact[0])
        if product.product_type == "simple":
            product = product.model_copy(
                update={"attributes": [a for a in product.attributes if a.comparable]}
            )
        return ComparisonMatch(product, found)


def comparison_query(reference: str) -> ComparisonQuery:
    link = re.fullmatch(
        r"(?:https?://[^/]+)?/products/([0-9a-fA-F-]{36})", reference.strip()
    )
    return ComparisonQuery(reference, link.group(1) if link else None)


def distinct_comparison_products(products: Sequence[Product]) -> bool:
    return len({product.id for product in products}) == len(products)
