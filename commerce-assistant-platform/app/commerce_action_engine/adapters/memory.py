"""Optional scoped memory transport; failures cannot block the shopping journey."""

from uuid import UUID

import httpx

from app.commerce_action_engine.actions.shopping.personalization import (
    MemoryView,
    Snapshot,
)


class MemoryTransport:
    def __init__(self, client: httpx.AsyncClient, token: str):
        self.client = client
        self.token = token

    async def load(self, conversation: UUID) -> MemoryView | None:
        if not self.token:
            return None
        try:
            response = await self.client.get(
                "/v1/assistant-tools/memory",
                headers={
                    "Authorization": "Bearer " + self.token,
                    "X-Commerce-Request": "1",
                },
                params={"conversation_id": str(conversation)},
                timeout=2,
            )
            response.raise_for_status()
            if len(response.content) > 65536:
                raise ValueError("Memory response too large")
            return MemoryView.model_validate_json(response.content)
        except (httpx.HTTPError, ValueError):
            return None

    async def save(
        self, conversation: UUID, expected_revision: int, snapshot: Snapshot
    ) -> None:
        if not self.token:
            return
        try:
            response = await self.client.put(
                "/v1/assistant-tools/memory",
                headers={
                    "Authorization": "Bearer " + self.token,
                    "X-Commerce-Request": "1",
                },
                json={
                    "conversation_id": str(conversation),
                    "expected_revision": expected_revision,
                    "snapshot": snapshot.model_dump(mode="json"),
                },
                timeout=2,
            )
            response.raise_for_status()
        except httpx.HTTPError:
            pass  # CAS conflicts, expiry and revocation never overwrite newer state.
