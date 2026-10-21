"""Fixed private gateway endpoints. Never retry a write on a lost response."""

from uuid import UUID

import httpx

from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable
from app.commerce_contracts.compound_plan import CompoundReceipt
from app.commerce_contracts.compound_write import (
    CompoundCommand,
    CompoundDispatch,
    CompoundReceiptLookup,
)


class CompoundCommerce:
    def __init__(
        self, client: httpx.AsyncClient, read_token: str = "", write_token: str = ""
    ):
        self.client = client
        self.read_token = read_token
        self.write_token = write_token

    async def _request(
        self, command: CompoundCommand, action_id: UUID, *, read: bool
    ) -> bytes:
        token = self.read_token if read else self.write_token
        if not token:
            raise ToolUnavailable()
        dispatch = CompoundDispatch(command=command, action_id=action_id)
        path = "/v1/assistant-tools/compound-actions" + ("/receipt" if read else "")
        async with self.client.stream(
            "POST",
            path,
            headers={"Authorization": f"Bearer {token}", "X-Commerce-Request": "1"},
            json=dispatch.model_dump(mode="json"),
        ) as response:
            if response.status_code in {401, 403}:
                raise ToolDenied()
            response.raise_for_status()
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > 16384:
                    raise ToolUnavailable()
            return bytes(data)

    async def apply(self, command: CompoundCommand, action_id: UUID) -> CompoundReceipt:
        try:
            data = await self._request(command, action_id, read=False)
            return command.verify(CompoundReceipt.model_validate_json(data), action_id)
        except (httpx.HTTPError, ValueError):
            # Rejections without a correlated receipt and transport errors are
            # unconfirmed outcomes, never authoritative failure or success.
            raise ToolUnavailable() from None

    async def receipt(
        self, command: CompoundCommand, action_id: UUID
    ) -> CompoundReceipt | None:
        try:
            data = await self._request(command, action_id, read=True)
            found = CompoundReceiptLookup.model_validate_json(data).receipt
            # Absence is not a failed operation: another dispatch may be in flight.
            return command.verify(found, action_id) if found else None
        except (httpx.HTTPError, ValueError):
            raise ToolUnavailable() from None
