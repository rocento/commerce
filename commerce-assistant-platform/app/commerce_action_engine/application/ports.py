"""Interfaces for the admitted turn's application handlers."""

from typing import Protocol

from app.commerce_action_engine.contracts import AssistantEvent


class EventFactory(Protocol):
    """Create events using the admitted turn's sequence and response bookkeeping."""

    def __call__(self, kind: str, **fields: object) -> AssistantEvent: ...
