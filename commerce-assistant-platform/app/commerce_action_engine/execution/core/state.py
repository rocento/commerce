"""Explicit transitions and one narrow backward reader; no I/O or persistence."""

import json
from typing import Any

from app.commerce_action_engine.contracts.action import (
    ExecutionState,
    ExecutionStatus,
    GoalState,
    GoalStatus,
)

GOAL_TRANSITIONS = {
    GoalStatus.CREATED: frozenset(
        {GoalStatus.PLANNED, GoalStatus.CANCELLED, GoalStatus.FAILED}
    ),
    GoalStatus.PLANNED: frozenset(
        {
            GoalStatus.RUNNING,
            GoalStatus.WAITING,
            GoalStatus.CANCELLED,
            GoalStatus.FAILED,
        }
    ),
    GoalStatus.RUNNING: frozenset(
        {
            GoalStatus.WAITING,
            GoalStatus.SUCCEEDED,
            GoalStatus.FAILED,
            GoalStatus.CANCELLED,
        }
    ),
    GoalStatus.WAITING: frozenset(
        {GoalStatus.PLANNED, GoalStatus.CANCELLED, GoalStatus.FAILED}
    ),
    GoalStatus.SUCCEEDED: frozenset(),
    GoalStatus.FAILED: frozenset(),
    GoalStatus.CANCELLED: frozenset(),
}
EXECUTION_TRANSITIONS = {
    ExecutionStatus.PENDING: frozenset(
        {ExecutionStatus.RUNNING, ExecutionStatus.CANCELLED}
    ),
    ExecutionStatus.RUNNING: frozenset(
        {ExecutionStatus.SUCCEEDED, ExecutionStatus.FAILED, ExecutionStatus.CANCELLED}
    ),
    ExecutionStatus.SUCCEEDED: frozenset(),
    ExecutionStatus.FAILED: frozenset(),
    ExecutionStatus.CANCELLED: frozenset(),
}


def transition_goal(
    state: GoalState, target: GoalStatus, *, expected_revision: int
) -> GoalState:
    if (
        state.revision != expected_revision
        or target not in GOAL_TRANSITIONS[state.status]
    ):
        raise ValueError("Stale revision or invalid goal transition")
    return GoalState.model_validate(
        {**state.model_dump(), "status": target, "revision": state.revision + 1}
    )


def transition_execution(
    state: ExecutionState, target: ExecutionStatus
) -> ExecutionState:
    if target not in EXECUTION_TRANSITIONS[state.status]:
        raise ValueError("Invalid execution transition; replay requires a new plan")
    return ExecutionState.model_validate(
        {
            **state.model_dump(),
            "status": target,
            "attempts": state.attempts + int(target == ExecutionStatus.RUNNING),
        }
    )


def read_goal(
    data: str, *, tenant_id: str, store_id: str, session_id: str
) -> GoalState:
    payload: Any = json.loads(data)
    if not isinstance(payload, dict):
        raise TypeError("Invalid goal")
    if payload.get("schema_version") != "1.0":
        raise ValueError("Unsupported persisted schema")
    state = GoalState.model_validate_json(json.dumps(payload))
    if (state.context.tenant_id, state.context.store_id, state.context.session_id) != (
        tenant_id,
        store_id,
        session_id,
    ):
        raise ValueError("Goal ownership mismatch")
    return state
