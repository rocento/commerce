"""Port for an explicit, admitted support-ticket submission."""

from typing import Protocol

from app.commerce_action_engine.contracts import AssistantTicketDetail


class SupportWriter(Protocol):
    async def create_ticket(
        self, arguments: dict[str, object]
    ) -> AssistantTicketDetail: ...
