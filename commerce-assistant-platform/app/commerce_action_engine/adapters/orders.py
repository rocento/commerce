"""Scoped order reads with a request-owned shared read budget."""

from collections.abc import Callable
from typing import Any

import httpx

from app.commerce_action_engine.adapters.http_response import check_response
from app.commerce_action_engine.contracts import AssistantOrder, AssistantOrderArgs
from app.commerce_action_engine.shared.errors import ToolUnavailable


class OrderTransport:
    def __init__(
        self,
        client: httpx.AsyncClient,
        capability: str,
        *,
        reserve_read: Callable[[], None],
    ):
        self.client = client
        self.capability = capability
        self.reserve_read = reserve_read

    async def call(self, name: str, arguments: dict[str, Any]) -> AssistantOrder:
        if name != "order_status":
            raise ValueError("Unregistered tool")
        args = AssistantOrderArgs.model_validate(arguments)
        self.reserve_read()
        try:
            async with self.client.stream(
                "GET",
                f"/v1/assistant-tools/orders/{args.order_id}",
                headers={"Authorization": f"Bearer {self.capability}"},
            ) as response:
                check_response(response)
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > 32768:
                        raise ToolUnavailable()
                return AssistantOrder.model_validate_json(data)
        except (httpx.HTTPError, ValueError):
            raise ToolUnavailable() from None

    async def orders(self) -> list[AssistantOrder]:
        return await self._orders("/v1/assistant-tools/orders")

    async def oldest_order(self) -> list[AssistantOrder]:
        return await self._orders("/v1/assistant-tools/orders?selection=oldest")

    async def _orders(self, path: str) -> list[AssistantOrder]:
        if not self.capability:
            raise ToolUnavailable()
        self.reserve_read()
        try:
            async with self.client.stream(
                "GET",
                path,
                headers={"Authorization": f"Bearer {self.capability}"},
            ) as response:
                check_response(response)
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > 32768:
                        raise ToolUnavailable()
                import json

                values = json.loads(data)
                if not isinstance(values, list) or len(values) > 50:
                    raise ValueError("Invalid orders response")
                return [AssistantOrder.model_validate(value) for value in values]
        except (httpx.HTTPError, ValueError, TypeError):
            raise ToolUnavailable() from None

    async def order_by_number(self, number: int) -> AssistantOrder:
        if not self.capability or not 0 < number <= 9223372036854775807:
            raise ToolUnavailable()
        self.reserve_read()
        try:
            async with self.client.stream(
                "GET",
                f"/v1/assistant-tools/orders/by-number/{number}",
                headers={"Authorization": f"Bearer {self.capability}"},
            ) as response:
                check_response(response)
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > 32768:
                        raise ToolUnavailable()
                return AssistantOrder.model_validate_json(data)
        except (httpx.HTTPError, ValueError):
            raise ToolUnavailable() from None
