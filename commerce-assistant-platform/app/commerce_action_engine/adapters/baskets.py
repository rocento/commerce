"""Scoped basket context and quote transport; never applies a proposal to a cart."""

import json
from typing import Any
from uuid import UUID

import httpx

from app.commerce_action_engine.contracts import AssistantFailure
from app.commerce_action_engine.shared.errors import RuntimeErrorCode, ToolUnavailable


class BasketTools:
    def __init__(self, client: httpx.AsyncClient, cart: str, capability: str):
        self.client = client
        self.path = f"/v1/assistant-tools/baskets/{UUID(cart)}"
        self.headers = {
            "Authorization": f"Bearer {capability}",
            "X-Commerce-Request": "1",
            "X-Commerce-Assistant-Errors": "1",
        }
        self.calls = 0

    async def context(self, task: UUID) -> dict[str, Any]:
        return await self.call("GET", task)

    async def quote(self, task: UUID, draft: dict[str, Any]) -> dict[str, Any]:
        return await self.call("POST", task, draft)

    async def call(
        self, method: str, task: UUID, draft: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        self.calls += 1
        if self.calls > 2 or method not in {"GET", "POST"}:
            raise ToolUnavailable()
        try:
            async with self.client.stream(
                method,
                self.path,
                headers=self.headers,
                params={"task_id": str(task)} if method == "GET" else None,
                json=draft,
            ) as response:
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > 262144:
                        raise ToolUnavailable()
                result = json.loads(data)
                if not isinstance(result, dict):
                    raise ToolUnavailable()
                if response.is_error:
                    if "failure" in result:
                        safe = AssistantFailure.model_validate(result["failure"])
                        raise RuntimeErrorCode(safe.code)
                    response.raise_for_status()
                return result
        except (httpx.HTTPError, ValueError):
            raise ToolUnavailable() from None
