"""Fixed shopper catalog reads for commerce journeys, without runtime-tool caching."""

from collections.abc import Callable
from typing import Any
from uuid import UUID

import httpx

from app.commerce_action_engine.actions.catalog.bestsellers import (
    Bestsellers,
    SalesPeriod,
)
from app.commerce_action_engine.actions.catalog.discounts import DiscountRecommendations
from app.commerce_action_engine.adapters.http_response import check_response
from app.commerce_action_engine.shared.errors import ToolUnavailable


class ShopperCatalogTransport:
    def __init__(
        self,
        client: httpx.AsyncClient,
        catalog_capability: str,
        delivery_headers: dict[str, str],
        *,
        reserve_read: Callable[[int], None],
    ):
        self.client = client
        self.catalog_capability = catalog_capability
        self.delivery_headers = delivery_headers
        self.reserve_read = reserve_read

    async def discounts(self) -> DiscountRecommendations:
        if not self.catalog_capability:
            raise ToolUnavailable()
        self.reserve_read(4)
        try:
            async with self.client.stream(
                "POST",
                "/v1/assistant-tools/shopper",
                headers={
                    **self.delivery_headers,
                    "Authorization": f"Bearer {self.catalog_capability}",
                    "X-Commerce-Request": "1",
                },
                json={"name": "get_discount_recommendations", "arguments": {}},
            ) as response:
                check_response(response)
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > 131072:
                        raise ToolUnavailable()
                return DiscountRecommendations.model_validate_json(data)
        except (httpx.HTTPError, ValueError):
            raise ToolUnavailable() from None

    async def bestsellers(self, period: "SalesPeriod") -> "Bestsellers":
        if not self.catalog_capability:
            raise ToolUnavailable()
        self.reserve_read(4)
        try:
            async with self.client.stream(
                "POST",
                "/v1/assistant-tools/shopper",
                headers={
                    **self.delivery_headers,
                    "Authorization": f"Bearer {self.catalog_capability}",
                    "X-Commerce-Request": "1",
                },
                json={"name": "get_bestsellers", "arguments": {"period": period}},
            ) as response:
                check_response(response)
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > 131072:
                        raise ToolUnavailable()
                result = Bestsellers.model_validate_json(data)
                if result.period != period or result.end < result.start:
                    raise ToolUnavailable()
                return result
        except (httpx.HTTPError, ValueError):
            raise ToolUnavailable() from None

    async def search_cart_product(self, query: str) -> list[dict[str, Any]]:
        from app.commerce_action_engine.actions.catalog import CatalogResult

        if not self.catalog_capability:
            raise ToolUnavailable()
        try:
            response = await self.client.post(
                "/v1/assistant-tools/shopper",
                headers={
                    "Authorization": f"Bearer {self.catalog_capability}",
                    "X-Commerce-Request": "1",
                    **self.delivery_headers,
                },
                json={"name": "search_products", "arguments": {"query": query}},
            )
            check_response(response)
            result = CatalogResult.model_validate_json(response.content)
            return [product.model_dump(mode="json") for product in result.products]
        except (httpx.HTTPError, ValueError):
            raise ToolUnavailable() from None

    async def product(self, product_id: UUID) -> dict[str, Any]:
        if not self.catalog_capability:
            raise ToolUnavailable()
        self.reserve_read(8)
        try:
            async with self.client.stream(
                "POST",
                "/v1/assistant-tools/shopper",
                headers={
                    **self.delivery_headers,
                    "Authorization": f"Bearer {self.catalog_capability}",
                    "X-Commerce-Request": "1",
                },
                json={
                    "name": "get_product",
                    "arguments": {"product_id": str(product_id)},
                },
            ) as response:
                check_response(response)
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > 32768:
                        raise ToolUnavailable()
                from app.commerce_action_engine.actions.catalog import CatalogResult

                result = CatalogResult.model_validate_json(data)
                if not result.products:
                    raise ValueError("Product not found")
                return result.products[0].model_dump(mode="json")
        except (httpx.HTTPError, ValueError):
            raise ToolUnavailable() from None
