"""Delivery availability and saved-location reads with scoped capabilities."""

from collections.abc import Callable
from typing import Any

import httpx

from app.commerce_action_engine.adapters.http_response import check_response
from app.commerce_action_engine.contracts import AssistantDelivery
from app.commerce_action_engine.shared.errors import ToolUnavailable


class DeliveryTransport:
    def __init__(
        self,
        client: httpx.AsyncClient,
        catalog_capability: str,
        locations_capability: str,
        delivery_headers: dict[str, str],
        *,
        reserve_read: Callable[[], None],
    ):
        self.client = client
        self.catalog_capability = catalog_capability
        self.locations_capability = locations_capability
        self.delivery_headers = delivery_headers
        self.reserve_read = reserve_read

    async def delivery(self) -> AssistantDelivery:
        if not self.catalog_capability:
            raise ToolUnavailable()
        self.reserve_read()
        headers = {"Authorization": f"Bearer {self.catalog_capability}"}
        headers.update(self.delivery_headers)
        try:
            async with self.client.stream(
                "GET", "/v1/assistant-tools/delivery", headers=headers
            ) as response:
                check_response(response)
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > 32768:
                        raise ToolUnavailable()
                return AssistantDelivery.model_validate_json(data)
        except (httpx.HTTPError, ValueError):
            raise ToolUnavailable() from None

    async def locations(self) -> list[dict[str, Any]]:
        if not self.locations_capability:
            raise ToolUnavailable()
        self.reserve_read()
        try:
            async with self.client.stream(
                "GET",
                "/v1/assistant-tools/locations",
                headers={"Authorization": f"Bearer {self.locations_capability}"},
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
                    raise ValueError("Invalid list response")
                if not all(isinstance(value, dict) for value in values):
                    raise ValueError("Invalid list item")
                return values
        except (httpx.HTTPError, ValueError, TypeError):
            raise ToolUnavailable() from None
