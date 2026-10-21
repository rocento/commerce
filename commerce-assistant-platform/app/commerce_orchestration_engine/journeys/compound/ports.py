"""Execution and persistence interfaces consumed by the compound journey."""

from collections.abc import Awaitable, Callable
from typing import Protocol, TypeVar
from uuid import UUID

from pydantic import BaseModel

from app.commerce_contracts.compound_plan import (
    CompoundPlan,
    CompoundReceipt,
    CompoundScope,
)
from app.commerce_contracts.compound_write import CompoundCommand


class PlanStore(Protocol):
    async def get_compound_plan(
        self, scope: CompoundScope, request: UUID, input_hash: str
    ) -> CompoundPlan | None: ...
    async def save_compound_plan(self, plan: CompoundPlan) -> CompoundPlan | None: ...


class OutcomeStore(Protocol):
    async def transition_compound(
        self,
        scope: CompoundScope,
        request: UUID,
        action_id: UUID,
        *,
        transition: str,
        receipt: CompoundReceipt | None = None,
    ) -> CompoundPlan: ...


class ExecutionStore(Protocol):
    async def transition_compound(
        self,
        scope: CompoundScope,
        request: UUID,
        action_id: UUID,
        *,
        transition: str,
        receipt: CompoundReceipt | None = None,
    ) -> CompoundPlan: ...
    async def get_compound_plan(
        self, scope: CompoundScope, request: UUID, input_hash: str
    ) -> CompoundPlan | None: ...


T = TypeVar("T")


class ExecutionSession(Protocol):
    """Already-admitted session; its implementation owns budgets and step policy."""

    @property
    def command(self) -> CompoundCommand: ...

    async def perform(
        self,
        port: str,
        arguments: BaseModel,
        operation: Callable[[], Awaitable[T]],
        project: Callable[[T], BaseModel],
        *,
        node_id: str | None = None,
    ) -> T: ...

    def start(
        self, port: str, arguments: BaseModel, *, node_id: str | None = None
    ) -> None: ...
    def fail(self) -> None: ...
    def operation_timeout(self) -> float: ...
    def finish(self, result: BaseModel) -> None: ...
