"""Prepare and execute a fresh bounded journey; return data, never UI text."""

from collections.abc import Callable
from uuid import UUID

from pydantic import ValidationError

from app.commerce_action_engine.actions.catalog.bindings import ProductReader
from app.commerce_action_engine.actions.shopping.compound import (
    CompoundWriter,
)
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.core.planning import PlanningError
from app.commerce_action_engine.execution.planning.compound import admissible, prepare
from app.commerce_action_engine.execution.planning.compound_execution import (
    CompoundExecutionSession,
    executable,
)
from app.commerce_action_engine.execution.planning.compound_review import admitted_pair
from app.commerce_contracts.agents import Principal
from app.commerce_contracts.errors import RuntimeErrorCode

from .execution import execute
from .ports import ExecutionStore, PlanStore
from .result import PreparationResult


async def prepare_journey(
    result: InterpretedRequest,
    principal: Principal,
    reader: ProductReader,
    store: PlanStore,
    *,
    conversation: UUID,
    request: UUID,
    revision: UUID,
    fingerprint: str,
    record_planning: Callable[[dict[str, object]], None] | None = None,
    writer: CompoundWriter | None = None,
    execution_store: ExecutionStore | None = None,
) -> PreparationResult:
    if not admissible(result):
        return PreparationResult("unsupported")
    try:
        plan = await prepare(
            result,
            principal,
            reader,
            conversation=conversation,
            request=request,
            revision=revision,
            input_hash=fingerprint,
            record_planning=record_planning,
        )
        session = None
        if (
            writer is not None
            and execution_store is not None
            and admitted_pair(result)
            and all(a.state == "ready" for a in plan.actions)
        ):
            plan = executable(plan, result, principal)
            session = CompoundExecutionSession(plan, principal, write_capability=True)
    except (PlanningError, RuntimeErrorCode, OSError, ValidationError):
        return PreparationResult("unavailable")
    saved = await store.save_compound_plan(plan)
    if saved is None:
        return PreparationResult("superseded")
    if (
        session is not None
        and writer is not None
        and execution_store is not None
        and saved == plan
    ):
        saved = await execute(saved, session, reader, writer, execution_store)
    return PreparationResult("saved", saved)
