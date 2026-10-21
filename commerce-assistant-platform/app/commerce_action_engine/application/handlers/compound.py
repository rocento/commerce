"""Compound request fingerprinting and presentation; coordination is delegated."""

import hashlib
import re
from uuid import UUID

from app.commerce_action_engine.actions.catalog.bindings import ProductReader
from app.commerce_action_engine.actions.shopping.compound import CompoundWriter
from app.commerce_action_engine.contracts import AssistantBlock, AssistantChatInput
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.agents import Principal
from app.commerce_action_engine.execution.planning.outcomes import recovery
from app.commerce_action_engine.platform import planning_summary
from app.commerce_contracts.compound_plan import CompoundPlan
from app.commerce_orchestration_engine.journeys.compound import (
    ExecutionStore,
    OutcomeStore,
    PlanStore,
    prepare_journey,
    reconcile,
)

__all__ = [
    "OutcomeStore",
    "PlanStore",
    "describe",
    "input_hash",
    "prepare_response",
    "product_choices",
    "reconcile",
]


PRODUCT_CHOICE_MESSAGE = "Choose the product for each action below, then confirm both actions. No changes have been made."


def input_hash(body: AssistantChatInput) -> str:
    # Include clarification, selected context and all other request fields, not
    # just the message; reused request IDs cannot change the accepted request.
    return hashlib.sha256(body.model_dump_json(exclude_none=True).encode()).hexdigest()


def describe(plan: CompoundPlan) -> str:
    status = recovery(plan)
    if status == "superseded":
        return "This saved request was replaced. Please send the complete request again. No actions will be retried."
    if status == "reconcile_required":
        parts = [
            f"{a.destination}: {'unconfirmed' if a.state in {'running', 'outcome_unknown'} else a.state.replace('_', ' ')}"
            for a in plan.actions
        ]
        return (
            "Outcomes: "
            + "; ".join(parts)
            + ". Please do not repeat this request while its receipt is unavailable. No further actions were started."
        )
    if status in {"completed", "partial"} or any(
        a.state == "failed" for a in plan.actions
    ):
        parts = [f"{a.destination}: {a.state.replace('_', ' ')}" for a in plan.actions]
        return "Outcomes: " + "; ".join(parts) + ". No actions were retried."
    parts = []
    for action in plan.actions:
        if action.binding:
            parts.append(
                f"{action.destination}: {action.quantity} × {action.binding.name[:200]}"
            )
        elif action.reason == "selection_required":
            options = "; ".join(
                f"{c.name[:100]}" + (f" (SKU: {c.sku})" if c.sku else "")
                for c in action.choices
            )
            parts.append(
                f"{action.destination}: choose the exact product for “{action.query}”"
                + (f" — {options}" if options else "")
            )
        elif action.reason == "stock_unverified":
            parts.append(
                f"{action.destination}: stock could not be confirmed for “{action.query}”"
            )
        elif action.reason == "quantity_not_supported":
            parts.append(
                f"wishlist: “{action.query}” can be saved once; a wishlist quantity of {action.quantity} is not supported"
            )
        elif action.reason == "catalog_unavailable":
            parts.append(f"{action.destination}: product lookup unavailable")
        else:
            parts.append(f"{action.destination}: no exact match for “{action.query}”")
    if all(a.state == "ready" for a in plan.actions):
        if plan.execution_enabled:
            return "Execution could not be confirmed. No actions were retried. Please review your cart and wishlist."
        return (
            "I matched both requested products: "
            + "; ".join(parts)
            + ". I saved the plan, but combined execution is not enabled. No changes have been made."
        )
    if plan.execution_enabled and any(a.state == "not_started" for a in plan.actions):
        return "This request stopped before its remaining actions could be started. No further changes were made. Please review your cart and wishlist."
    return (
        "The complete request still needs attention: "
        + "; ".join(parts)
        + ". Please resend the full request with each product’s exact name or unique SKU. No changes have been made."
    )


def product_choices(plan: CompoundPlan) -> AssistantBlock | None:
    """Offer complete fresh-request choices only before any action starts."""
    if (
        plan.language_status != "RESOLVED"
        or plan.interpretation_issues
        or recovery(plan) == "superseded"
        or not any(a.reason == "selection_required" for a in plan.actions)
    ):
        return None
    actions = []
    for action in plan.actions:
        if (
            action.state not in {"ready", "needs_input"}
            or action.unit is not None
            or action.destination == "wishlist"
            and action.quantity != 1
        ):
            return None
        candidates = (
            (action.binding,)
            if action.binding
            else action.choices
            if action.reason == "selection_required"
            else ()
        )
        choices = [
            {"name": c.name, "sku": c.sku}
            for c in candidates
            if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}", c.sku)
        ]
        if not choices:
            return None
        actions.append(
            {
                "destination": action.destination,
                "quantity": action.quantity,
                "choices": choices,
            }
        )
    return AssistantBlock.model_validate(
        {"kind": "compound_choice", "compound_choice": {"actions": actions}}
    )


async def prepare_response(
    result: InterpretedRequest,
    principal: Principal,
    reader: ProductReader,
    store: PlanStore,
    *,
    conversation: UUID,
    request: UUID,
    revision: UUID,
    fingerprint: str,
    writer: CompoundWriter | None = None,
    execution_store: ExecutionStore | None = None,
) -> tuple[str, CompoundPlan | None]:
    outcome = await prepare_journey(
        result,
        principal,
        reader,
        store,
        conversation=conversation,
        request=request,
        revision=revision,
        record_planning=planning_summary,
        fingerprint=fingerprint,
        writer=writer,
        execution_store=execution_store,
    )
    if outcome.plan is not None:
        return describe(outcome.plan), outcome.plan
    messages = {
        "unsupported": (
            "Planning currently supports one product per cart/wishlist action, with whole-item quantities. "
            "Please send other requests separately. No changes have been made."
        ),
        "unavailable": "I could not prepare the complete request. Please try again later. No changes have been made.",
        "superseded": "This attempt was replaced while I was checking the products. Check the latest response for the request’s outcome. This attempt did not start additional actions.",
    }
    return messages[outcome.status], None
