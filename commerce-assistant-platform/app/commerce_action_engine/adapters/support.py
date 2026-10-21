"""Scoped support ticket transport; composition owns the shared call budget."""

from collections.abc import Callable
from typing import Any
from uuid import UUID

import httpx

from app.commerce_action_engine.adapters.http_response import check_response
from app.commerce_action_engine.contracts import (
    AssistantTicket,
    AssistantTicketDetail,
    AssistantTicketInput,
)
from app.commerce_action_engine.shared.errors import ToolUnavailable


class SupportTransport:
    def __init__(
        self,
        client: httpx.AsyncClient,
        read_capability: str,
        create_capability: str,
        *,
        reserve_call: Callable[[], None],
    ):
        self.client = client
        self.read_capability = read_capability
        self.create_capability = create_capability
        self.reserve_call = reserve_call

    async def support_tickets(self) -> list[AssistantTicket]:
        if not self.read_capability:
            raise ToolUnavailable()
        values = await self._read_tickets()
        try:
            return [AssistantTicket.model_validate(value) for value in values]
        except ValueError:
            raise ToolUnavailable() from None

    async def support_ticket(self, ticket_id: UUID) -> AssistantTicketDetail:
        if not self.read_capability:
            raise ToolUnavailable()
        self.reserve_call()
        try:
            async with self.client.stream(
                "GET",
                f"/v1/assistant-tools/support/tickets/{ticket_id}",
                headers={"Authorization": f"Bearer {self.read_capability}"},
            ) as response:
                check_response(response)
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > 32768:
                        raise ToolUnavailable()
                return AssistantTicketDetail.model_validate_json(data)
        except (httpx.HTTPError, ValueError):
            raise ToolUnavailable() from None

    async def _read_tickets(self) -> list[dict[str, Any]]:
        if not self.read_capability:
            raise ToolUnavailable()
        self.reserve_call()
        try:
            async with self.client.stream(
                "GET",
                "/v1/assistant-tools/support/tickets",
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
                if not isinstance(values, list) or len(values) > 100:
                    raise ValueError("Invalid list response")
                if not all(isinstance(value, dict) for value in values):
                    raise ValueError("Invalid list item")
                return values
        except (httpx.HTTPError, ValueError, TypeError):
            raise ToolUnavailable() from None

    async def create_ticket(self, arguments: dict[str, Any]) -> "AssistantTicketDetail":
        args = AssistantTicketInput.model_validate(arguments)
        self.reserve_call()
        try:
            async with self.client.stream(
                "POST",
                "/v1/assistant-tools/support/tickets",
                headers={
                    "Authorization": f"Bearer {self.create_capability}",
                    "X-Commerce-Request": "1",
                },
                json=args.model_dump(mode="json", exclude_none=True),
            ) as response:
                check_response(response)
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > 32768:
                        raise ToolUnavailable()
                return AssistantTicketDetail.model_validate_json(data)
        except (httpx.HTTPError, ValueError):
            raise ToolUnavailable() from None
