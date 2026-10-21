"""Support reads and explicit submissions; turn lifecycle stays centralized."""

from collections.abc import AsyncGenerator, Callable

from app.commerce_action_engine.actions.support import (
    SupportReader,
    SupportWriter,
    ticket_id,
)
from app.commerce_action_engine.application.ports import EventFactory
from app.commerce_action_engine.contracts import AssistantEvent, AssistantTicketInput
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.platform import phase
from app.commerce_action_engine.shared.errors import ToolUnavailable


async def support_create_events(
    *,
    submission: AssistantTicketInput,
    commerce_tools: Callable[[], SupportWriter],
    metadata: dict[str, object],
    make_event: EventFactory,
) -> AsyncGenerator[AssistantEvent, None]:
    """Submit the API-admitted form; authorization and transport remain outside."""
    metadata["route_reason"] = "support_ticket"
    tools = commerce_tools()
    yield make_event("progress", stage="support")
    metadata.update({"tools": ["support_create"], "tool_calls": 1})
    with phase("tool"):
        ticket = await tools.create_ticket(
            submission.model_dump(mode="json", exclude_none=True)
        )
    yield make_event("ticket.created", ticket=ticket.model_dump(mode="json"))
    yield make_event(
        "message.delta",
        text=f"Ticket #{ticket.ticket.number} is open. Our support team can now follow up.",
    )


async def support_events(
    *,
    authenticated: bool,
    request: InterpretedRequest,
    commerce_tools: Callable[[], SupportReader],
    metadata: dict[str, object],
    make_event: EventFactory,
) -> AsyncGenerator[AssistantEvent, None]:
    if not authenticated:
        yield make_event(
            "message.delta",
            text="Please sign in to view your support tickets.",
            code="login_required",
        )
    else:
        metadata["route_reason"] = "support_ticket_list"
        metadata.update({"tools": ["support_ticket_list"], "tool_calls": 1})
        tickets = await commerce_tools().support_tickets()
        if not tickets:
            yield make_event("message.delta", text="You have no support tickets.")
        else:
            lines = [
                f"#{item.number} — {item.subject} ({item.status.replace('_', ' ')})"
                for item in tickets[:10]
            ]
            text = "Your recent support tickets:\n" + "\n".join(lines)
            if request.legacy_intent != "SUPPORT_TICKET_STATUS":
                text += "\n\nOpen the ticket in Support to view its conversation or confirm changes."
            yield make_event("message.delta", text=text)


async def support_detail_events(
    *,
    authenticated: bool,
    request: InterpretedRequest,
    commerce_tools: Callable[[], SupportReader],
    metadata: dict[str, object],
    make_event: EventFactory,
) -> AsyncGenerator[AssistantEvent, None]:
    if not authenticated:
        yield make_event(
            "message.delta",
            text="Please sign in to view your support conversation.",
            code="login_required",
        )
    else:
        try:
            parsed_ticket_id = ticket_id(request.entities)
        except ValueError:
            yield make_event(
                "message.delta",
                text="I couldn’t identify that support ticket. Please choose it from Support.",
            )
            return
        if parsed_ticket_id is None:
            yield make_event(
                "message.delta",
                text="Which support ticket should I open? Please choose one from your support tickets.",
            )
            return
        metadata["route_reason"] = "support_conversation_read"
        metadata.update({"tools": ["support_ticket_detail"], "tool_calls": 1})
        try:
            detail = await commerce_tools().support_ticket(parsed_ticket_id)
        except ToolUnavailable:
            yield make_event(
                "message.delta",
                text="I couldn’t load that support conversation. Please try again or open Support.",
                code="unavailable",
            )
        else:
            lines = [f"{message.sender}: {message.body}" for message in detail.messages]
            text = f"Conversation for ticket #{detail.ticket.number}:\n" + (
                "\n".join(lines) if lines else "No messages are available yet."
            )
            yield make_event("message.delta", text=text)
