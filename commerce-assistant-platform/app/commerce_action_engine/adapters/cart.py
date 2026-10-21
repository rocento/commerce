"""Scoped cart transport; read budgets are supplied by request composition."""

from collections.abc import Callable
from typing import Any

import httpx

from app.commerce_action_engine.adapters.http_response import check_response
from app.commerce_action_engine.contracts import AssistantCart
from app.commerce_action_engine.shared.errors import ToolUnavailable


class CartTransport:
    def __init__(
        self,
        client: httpx.AsyncClient,
        read_capability: str,
        write_capability: str,
        delivery_headers: dict[str, str],
        *,
        reserve_read: Callable[[], None],
    ):
        self.client = client
        self.read_capability = read_capability
        self.write_capability = write_capability
        self.delivery_headers = delivery_headers
        self.reserve_read = reserve_read

    async def cart(self) -> AssistantCart:
        if not self.read_capability:
            raise ToolUnavailable()
        self.reserve_read()
        headers = {"Authorization": f"Bearer {self.read_capability}"}
        headers.update(self.delivery_headers)
        try:
            async with self.client.stream(
                "GET", "/v1/assistant-tools/cart", headers=headers
            ) as response:
                check_response(response)
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > 32768:
                        raise ToolUnavailable()
                return AssistantCart.model_validate_json(data)
        except (httpx.HTTPError, ValueError):
            raise ToolUnavailable() from None

    async def change_cart(self, change: dict[str, Any]) -> AssistantCart:
        if not self.write_capability:
            raise ToolUnavailable()
        # Never retry a write: an interrupted response may have committed.
        try:
            response = await self.client.post(
                "/v1/assistant-tools/cart",
                headers={
                    "Authorization": f"Bearer {self.write_capability}",
                    "X-Commerce-Request": "1",
                },
                json=change,
            )
            check_response(response)
            return AssistantCart.model_validate_json(response.content)
        except (httpx.HTTPError, ValueError):
            raise ToolUnavailable() from None
