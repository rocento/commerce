"""Customer-scoped support read ports and ticket reference validation."""

from collections.abc import Mapping
from typing import Protocol
from uuid import UUID

from app.commerce_action_engine.contracts import AssistantTicket, AssistantTicketDetail


class SupportReader(Protocol):
    async def support_tickets(self) -> list[AssistantTicket]: ...
    async def support_ticket(self, ticket_id: UUID) -> AssistantTicketDetail: ...


def ticket_id(entities: Mapping[str, object]) -> UUID | None:
    """Missing/non-string references need clarification; malformed UUIDs raise."""
    value = entities.get("ticketId") or entities.get("ticket_id")
    return UUID(value) if isinstance(value, str) else None
