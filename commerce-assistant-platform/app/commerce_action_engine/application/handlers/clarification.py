"""Render a validated clarification using the admitted turn's event factory."""

from app.commerce_action_engine.application.ports import EventFactory
from app.commerce_action_engine.contracts import AssistantEvent
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest


def clarification_event(
    request: InterpretedRequest,
    original_message: str,
    *,
    allow_reply: bool,
    make_event: EventFactory,
) -> AssistantEvent:
    fields: dict[str, object] = {}
    if allow_reply:
        fields["clarification"] = {
            "original_message": original_message,
            "question": request.message,
        }
    return make_event("message.delta", text=request.message, **fields)
