"""Commerce operations needed to prepare a basket proposal."""

from typing import Any, Protocol
from uuid import UUID


class BasketGateway(Protocol):
    """Read scoped state and persist a quote; approval and cart writes are separate.

    The adapter owns authorization, transport bounds and safe error mapping.
    Payloads preserve the existing gateway contract.
    """

    async def context(self, task: UUID) -> dict[str, Any]: ...

    async def quote(self, task: UUID, draft: dict[str, Any]) -> dict[str, Any]: ...
