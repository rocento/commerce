"""Wishlist reads and mutations using separately delegated capabilities."""

from collections.abc import Callable
from uuid import UUID

import httpx

from app.commerce_action_engine.actions.customer.transfers import (
    WishlistTransferReceipt,
)
from app.commerce_action_engine.adapters.http_response import check_response
from app.commerce_action_engine.shared.errors import ToolUnavailable


class WishlistTransport:
    def __init__(
        self,
        client: httpx.AsyncClient,
        read_capability: str,
        write_capability: str,
        transfer_capability: str,
        *,
        reserve_read: Callable[[], None],
    ):
        self.client = client
        self.read_capability = read_capability
        self.write_capability = write_capability
        self.transfer_capability = transfer_capability
        self.reserve_read = reserve_read

    async def transfer_wishlist_to_cart(
        self, product_ids: list[UUID]
    ) -> WishlistTransferReceipt:
        if not self.transfer_capability:
            raise ToolUnavailable()
        try:
            response = await self.client.post(
                "/v1/assistant-tools/cart/wishlist-transfer",
                headers={
                    "Authorization": f"Bearer {self.transfer_capability}",
                    "X-Commerce-Request": "1",
                },
                json={"product_ids": [str(product_id) for product_id in product_ids]},
            )
            check_response(response)
            return WishlistTransferReceipt.model_validate_json(response.content)
        except (httpx.HTTPError, ValueError):
            raise ToolUnavailable() from None

    async def wishlist(self) -> list[UUID]:
        if not self.read_capability:
            raise ToolUnavailable()
        self.reserve_read()
        try:
            async with self.client.stream(
                "GET",
                "/v1/assistant-tools/wishlist",
                headers={"Authorization": f"Bearer {self.read_capability}"},
            ) as response:
                check_response(response)
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > 32768:
                        raise ToolUnavailable()
                import json

                values = json.loads(data)
                if not isinstance(values, list) or len(values) > 500:
                    raise ValueError("Invalid wishlist response")
                return [UUID(value) for value in values]
        except (httpx.HTTPError, ValueError, TypeError):
            raise ToolUnavailable() from None

    async def remove_wishlist_item(self, product_id: UUID) -> None:
        if not self.write_capability:
            raise ToolUnavailable()
        try:
            response = await self.client.request(
                "DELETE",
                "/v1/assistant-tools/wishlist",
                headers={
                    "Authorization": f"Bearer {self.write_capability}",
                    "X-Commerce-Request": "1",
                },
                json={"product_id": str(product_id)},
            )
            check_response(response)
        except httpx.HTTPError:
            raise ToolUnavailable() from None

    async def add_wishlist_item(self, product_id: UUID) -> None:
        if not self.write_capability:
            raise ToolUnavailable()
        try:
            response = await self.client.post(
                "/v1/assistant-tools/wishlist",
                headers={
                    "Authorization": f"Bearer {self.write_capability}",
                    "X-Commerce-Request": "1",
                },
                json={"product_id": str(product_id)},
            )
            check_response(response)
        except httpx.HTTPError:
            raise ToolUnavailable() from None
