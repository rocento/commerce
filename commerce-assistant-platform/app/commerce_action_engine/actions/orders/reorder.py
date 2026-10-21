"""Read selection for reorder review; no cart or order mutation is available here."""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from app.commerce_action_engine.contracts import AssistantOrder

from .reads import OrderRead, OrderReader


@dataclass(frozen=True)
class ReorderRead:
    query: OrderRead
    selection: Literal["LATEST", "PREVIOUS"] | None = None

    async def execute(self, reader: OrderReader) -> list[AssistantOrder]:
        orders = await self.query.execute(reader)
        if self.query.number or self.query.order_id:
            return orders
        if self.selection == "LATEST":
            return orders[:1]
        if self.selection == "PREVIOUS":
            return orders[1:2]
        return orders


def reorder_read(
    entities: Mapping[str, object], selected_id: UUID | None = None
) -> ReorderRead | None:
    """Preserve explicit-number, selected-ID, then history precedence.

    An invalid explicit reference must clarify, never fall back to another order.
    """
    order_ref = entities.get("order", {})
    raw = entities.get("order_reference") or (
        order_ref.get("resolvedReference") if isinstance(order_ref, dict) else None
    )
    number = (
        int(raw)
        if isinstance(raw, (str, int)) and str(raw).isdigit() and len(str(raw)) <= 19
        else None
    )
    if raw is not None and (number is None or not 0 < number <= 9223372036854775807):
        return None
    selection = entities.get("orderSelection")
    return ReorderRead(
        OrderRead(number, selected_id),
        "LATEST"
        if selection == "LATEST"
        else "PREVIOUS"
        if selection == "PREVIOUS"
        else None,
    )
