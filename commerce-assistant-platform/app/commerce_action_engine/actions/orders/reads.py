"""Order reads use customer-scoped ports; interpretation grants no authority."""

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID

from app.commerce_action_engine.contracts import AssistantOrder


class OrderReader(Protocol):
    async def orders(self) -> list[AssistantOrder]: ...
    async def oldest_order(self) -> list[AssistantOrder]: ...
    async def order_by_number(self, number: int) -> AssistantOrder: ...
    async def call(self, name: str, arguments: dict[str, Any]) -> AssistantOrder: ...


@dataclass(frozen=True)
class OrderRead:
    number: int | None
    order_id: UUID | None = None
    oldest: bool = False

    @property
    def route_reason(self) -> str:
        return (
            "order_number_read"
            if self.number
            else "selected_order_read"
            if self.order_id
            else "oldest_order_read"
            if self.oldest
            else "order_history_read"
        )

    @property
    def tool_name(self) -> str:
        return (
            "order_status_by_number"
            if self.number
            else "order_status"
            if self.order_id
            else "oldest_order_read"
            if self.oldest
            else "order_history_read"
        )

    async def execute(self, reader: OrderReader) -> list[AssistantOrder]:
        if self.number:
            return [await reader.order_by_number(self.number)]
        if self.order_id:
            return [await reader.call("order_status", {"order_id": str(self.order_id)})]
        if self.oldest:
            return await reader.oldest_order()
        return await reader.orders()


def order_read(
    message: str, entities: Mapping[str, object], selected_id: UUID | None = None
) -> OrderRead:
    """Preserve explicit-number precedence and history fallback on disagreement."""
    match = re.search(
        r"(?<!\w)(?:order\s*(?:(?:number|id)\s*|#\s*)?|#)\s*(\d{1,19})\b",
        message,
        re.IGNORECASE,
    )
    entity_number = (
        entities.get("order_reference")
        or entities.get("orderNumber")
        or entities.get("order_number")
    )
    number = int(match.group(1)) if match else None
    if (
        number
        and entity_number is not None
        and str(number) != str(entity_number).lstrip("0")
    ):
        number = None
    history = re.search(
        r"\b(?:orders|history|last|latest|newest|most\s+recent)\b",
        message,
        re.IGNORECASE,
    )
    oldest = bool(
        re.search(r"\b(?:first|oldest|earliest)\s+order\b", message, re.IGNORECASE)
    )
    return OrderRead(
        number or None,
        selected_id if not match and not history and not oldest else None,
        oldest and not number,
    )


def shipment_id(entities: Mapping[str, object]) -> UUID | None:
    """Absent/non-string references need clarification; malformed UUIDs raise."""
    value = entities.get("orderId") or entities.get("order_id")
    return UUID(value) if isinstance(value, str) else None


def contextual_order_message(message: str) -> str | None:
    """Resolve only unambiguous read follow-ups; never reinterpret arbitrary actions."""
    text = message.strip().lower().rstrip("?.!")
    explicit = re.fullmatch(
        r"(?:what about|show|view|check)\s+(?:order\s*#?\s*|#)([1-9]\d{0,18})", text
    )
    if explicit:
        return f"Show order #{explicit.group(1)} details"
    if re.fullmatch(
        r"(?:where is (?:it|my order|the order)|track(?: it| my order| the order)?|(?:what is|what's) (?:its|the order) status)",
        text,
    ):
        return "Where is my order?"
    if re.fullmatch(
        r"(?:show (?:its|the order) details|(?:what|which) items did i (?:buy|order)|what is in (?:it|my order)|how much (?:was it|did i pay))",
        text,
    ):
        return "Show my order details"
    return None
