"""Receipted commerce port; orchestration must separately admit and claim work."""

from typing import Protocol
from uuid import UUID

from app.commerce_contracts.compound_plan import CompoundReceipt
from app.commerce_contracts.compound_write import CompoundCommand


class CompoundReceiptReader(Protocol):
    async def receipt(
        self, command: CompoundCommand, action_id: UUID
    ) -> CompoundReceipt | None: ...


class CompoundWriter(CompoundReceiptReader, Protocol):
    async def apply(
        self, command: CompoundCommand, action_id: UUID
    ) -> CompoundReceipt: ...
