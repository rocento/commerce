"""Private gateway command, not language/model input or execution admission."""

import time
from typing import Literal
from uuid import UUID, uuid5

from pydantic import Field, model_validator

from app.commerce_contracts.base import Contract
from app.commerce_contracts.compound_plan import (
    CompoundPlan,
    CompoundReceipt,
    CompoundScope,
    Quantity,
)


class CompoundOperation(Contract):
    action_id: UUID
    operation_id: UUID
    product_id: UUID
    quantity: Quantity
    destination: Literal["cart", "wishlist"]
    observed_at: int = Field(ge=0)
    expires_at: int = Field(ge=0)

    @model_validator(mode="after")
    def coherent(self) -> "CompoundOperation":
        if (
            self.operation_id != uuid5(self.action_id, "add:" + self.destination)
            or not self.observed_at < self.expires_at <= self.observed_at + 30
            or self.destination == "wishlist"
            and self.quantity != 1
            or self.product_id.int == 0
        ):
            raise ValueError("invalid_compound_operation")
        return self


class CompoundCommand(Contract):
    scope: CompoundScope
    request_id: UUID
    revision: UUID
    actions: tuple[CompoundOperation, CompoundOperation]

    @model_validator(mode="after")
    def coherent(self) -> "CompoundCommand":
        if {a.destination for a in self.actions} != {"cart", "wishlist"} or any(
            a.action_id != uuid5(self.revision, f"action:{i}")
            for i, a in enumerate(self.actions)
        ):
            raise ValueError("invalid_compound_command")
        if any(
            value.int == 0
            for value in (
                self.request_id,
                self.revision,
                self.scope.tenant_id,
                self.scope.customer_id,
                self.scope.conversation_id,
            )
        ):
            raise ValueError("invalid_compound_scope")
        return self

    @classmethod
    def from_plan(cls, plan: CompoundPlan) -> "CompoundCommand":
        """Copy immutable bindings only; a command grants no write permission."""
        actions = []
        for action in plan.actions:
            if action.binding is None:
                raise ValueError("complete_request_not_bound")
            actions.append(
                CompoundOperation(
                    action_id=action.id,
                    operation_id=action.operation_id,
                    product_id=action.binding.product_id,
                    quantity=action.quantity,
                    destination=action.destination,
                    observed_at=action.binding.observed_at,
                    expires_at=action.binding.expires_at,
                )
            )
        return cls(
            scope=plan.scope,
            request_id=plan.request_id,
            revision=plan.revision,
            actions=(actions[0], actions[1]),
        )

    def verify(self, receipt: CompoundReceipt, action_id: UUID) -> CompoundReceipt:
        action = next((a for a in self.actions if a.action_id == action_id), None)
        if (
            action is None
            or receipt.scope != self.scope
            or receipt.revision != self.revision
            or receipt.action_id != action_id
            or receipt.operation_id != action.operation_id
            or receipt.product_id != action.product_id
            or receipt.quantity != action.quantity
            or receipt.destination != action.destination
            or receipt.receipt_id.int == 0
            or not action.observed_at <= receipt.observed_at <= int(time.time())
        ):
            raise ValueError("receipt_correlation_failed")
        return receipt


class CompoundDispatch(Contract):
    command: CompoundCommand
    action_id: UUID

    @model_validator(mode="after")
    def member(self) -> "CompoundDispatch":
        if self.action_id not in {a.action_id for a in self.command.actions}:
            raise ValueError("unknown_compound_action")
        return self


class CompoundReceiptLookup(Contract):
    receipt: CompoundReceipt | None
