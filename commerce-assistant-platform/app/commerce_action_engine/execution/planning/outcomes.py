"""Pure serial outcome transitions; caller must separately authorize commerce I/O."""

import json
from uuid import UUID

from app.commerce_contracts.compound_plan import (
    CompoundPlan,
    CompoundReceipt,
)


def _replace(plan: CompoundPlan, index: int, **values: object) -> CompoundPlan:
    payload = plan.model_dump(mode="json")
    payload["actions"][index].update(values)
    return CompoundPlan.model_validate_json(json.dumps(payload))


def claim(plan: CompoundPlan, action_id: UUID, *, now: int) -> CompoundPlan:
    """Reserve one operation, never replay completed/uncertain/running work."""
    index = next(
        (i for i, action in enumerate(plan.actions) if action.id == action_id), -1
    )
    if index < 0 or plan.actions[index].state != "ready":
        raise ValueError("action_not_ready")
    if any(
        a.binding is None or not a.binding.observed_at <= now < a.binding.expires_at
        for a in plan.actions
    ):
        raise ValueError("product_revalidation_required")
    if any(a.state != "succeeded" for a in plan.actions[:index]) or any(
        a.state != "ready" for a in plan.actions[index + 1 :]
    ):
        raise ValueError("complete_request_not_ready")
    return _replace(plan, index, state="running")


def record(plan: CompoundPlan, receipt: CompoundReceipt) -> CompoundPlan:
    index = next(
        (i for i, action in enumerate(plan.actions) if action.id == receipt.action_id),
        -1,
    )
    if index < 0:
        raise ValueError("receipt_correlation_failed")
    action = plan.actions[index]
    if action.receipt == receipt:
        return plan
    if action.state not in {"running", "outcome_unknown"}:
        raise ValueError("invalid_outcome_transition")
    updated = _replace(
        plan,
        index,
        state=receipt.outcome,
        receipt=receipt.model_dump(mode="json"),
        reason=None,
    )
    if receipt.outcome == "failed":
        for i in range(index + 1, len(plan.actions)):
            if updated.actions[i].state == "ready":
                updated = _replace(
                    updated, i, state="not_started", reason="dependency_stopped"
                )
    return updated


def uncertain(plan: CompoundPlan, action_id: UUID) -> CompoundPlan:
    index = next(
        (i for i, action in enumerate(plan.actions) if action.id == action_id), -1
    )
    if index < 0 or plan.actions[index].state != "running":
        raise ValueError("invalid_outcome_transition")
    updated = _replace(plan, index, state="outcome_unknown", reason="transport_unknown")
    for i in range(index + 1, len(plan.actions)):
        if updated.actions[i].state == "ready":
            updated = _replace(
                updated, i, state="not_started", reason="dependency_stopped"
            )
    return updated


def supersede(plan: CompoundPlan) -> CompoundPlan:
    for i, action in enumerate(plan.actions):
        if action.state == "running":
            plan = uncertain(plan, action.id)
        elif action.state in {"ready", "needs_input", "not_started"}:
            plan = _replace(plan, i, state="superseded", reason="superseded")
    return plan


def stop(plan: CompoundPlan) -> CompoundPlan:
    """Close undispatched actions without claiming an authoritative failure."""
    for i, action in enumerate(plan.actions):
        if action.state == "ready":
            plan = _replace(plan, i, state="not_started", reason="execution_stopped")
    return plan


def recovery(plan: CompoundPlan) -> str:
    if any(a.state in {"running", "outcome_unknown"} for a in plan.actions):
        return "reconcile_required"
    if all(a.state == "succeeded" for a in plan.actions):
        return "completed"
    if any(a.state == "succeeded" for a in plan.actions):
        return "partial"
    if any(a.state == "superseded" for a in plan.actions):
        return "superseded"
    return "not_executed"
