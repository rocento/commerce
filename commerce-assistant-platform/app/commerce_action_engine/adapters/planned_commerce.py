"""Reuse the existing authenticated cart/order/delivery facade with planned read guards."""

from collections.abc import Callable
from typing import Any

from app.commerce_action_engine.actions.catalog import SchemaArgs
from app.commerce_action_engine.adapters.commerce import CommerceTools
from app.commerce_action_engine.contracts import (
    AssistantCart,
    AssistantDelivery,
    AssistantOrder,
    AssistantOrderArgs,
)
from app.commerce_action_engine.execution.agents import Principal
from app.commerce_action_engine.execution.planning.runtime import planned_read


class PlannedCommerceTools(CommerceTools):
    def __init__(
        self,
        base: CommerceTools,
        principal: Principal,
        *,
        record_planning: Callable[[dict[str, object]], None] | None = None,
    ):
        self.record_planning = record_planning
        super().__init__(
            base.client,
            base.capability,
            base.cart_capability,
            base.catalog_capability,
            base.delivery_headers,
            base.wishlist_capability,
            base.locations_capability,
            base.support_capability,
            base.cart_write_capability,
            base.wishlist_write_capability,
            base.wishlist_cart_transfer_capability,
            base.compound_read_capability,
            base.compound_write_capability,
            read_budget=base.read_budget,
        )
        self.principal = principal

    async def cart(self) -> AssistantCart:
        return await planned_read(
            "cart",
            self.principal,
            "commerce.cart",
            SchemaArgs(),
            super().cart,
            lambda result: result,
            record_planning=self.record_planning,
        )

    async def delivery(self) -> AssistantDelivery:
        return await planned_read(
            "delivery",
            self.principal,
            "commerce.delivery",
            SchemaArgs(),
            super().delivery,
            lambda result: result,
            record_planning=self.record_planning,
        )

    async def call(self, name: str, arguments: dict[str, Any]) -> AssistantOrder:
        if name != "order_status":
            raise ValueError("Unregistered tool")
        args = AssistantOrderArgs.model_validate(arguments)
        operation = super().call
        return await planned_read(
            "order",
            self.principal,
            "commerce.order",
            args,
            lambda: operation(name, arguments),
            lambda result: result,
            record_planning=self.record_planning,
            context_keys=frozenset({"order_id"}),
        )
