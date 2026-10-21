"""Saved requests reconcile receipts only; they cannot dispatch writes."""

from app.commerce_action_engine.actions.shopping.compound import CompoundReceiptReader
from app.commerce_contracts.compound_plan import CompoundPlan
from app.commerce_contracts.compound_write import CompoundCommand
from app.commerce_contracts.errors import ToolUnavailable

from .ports import OutcomeStore


async def reconcile(
    plan: CompoundPlan, reader: CompoundReceiptReader, store: OutcomeStore
) -> CompoundPlan:
    """Read authoritative receipts only; never dispatch or resume a successor."""
    unresolved = [a for a in plan.actions if a.state in {"running", "outcome_unknown"}]
    if not unresolved:
        return plan
    try:
        command = CompoundCommand.from_plan(plan)
    except ValueError:
        return plan
    for action in unresolved:
        try:
            receipt = await reader.receipt(command, action.id)
        except ToolUnavailable:
            continue
        if receipt is not None:
            # Validate again at the orchestration boundary for alternate port
            # implementations; the store independently verifies the saved plan.
            command.verify(receipt, action.id)
            plan = await store.transition_compound(
                plan.scope,
                plan.request_id,
                action.id,
                transition="receipt",
                receipt=receipt,
            )
    return plan
