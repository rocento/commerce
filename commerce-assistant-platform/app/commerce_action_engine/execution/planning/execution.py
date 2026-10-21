"""Validate the authoritative Rust verification receipt before any proposal response."""

from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from app.commerce_action_engine.shared.errors import RuntimeErrorCode


class ExecutionReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    schema_version: Literal["1.0"]
    goal_id: UUID
    revision: int = Field(ge=1)
    state: Literal[
        "created",
        "planned",
        "executing",
        "verifying",
        "replanning",
        "needs_input",
        "awaiting_confirmation",
        "completed",
        "cancelled",
        "expired",
        "blocked",
    ]
    verdict: Literal["pass", "needs_input", "stale", "blocked"]
    playbook: Literal[
        "playbook://commerce/shop",
        "playbook://commerce/optimize",
        "playbook://commerce/buy-again-ui",
    ]
    version: Literal["1.0.0"]
    proposal_id: UUID
    observed_at: AwareDatetime
    expires_at: AwareDatetime
    reasons: list[str] = Field(max_length=20)


def verify_receipt(
    proposal: dict[str, Any], task: UUID, mode: str, *, required: bool = False
) -> ExecutionReceipt | None:
    """Legacy deployments omit the additive receipt. Present receipts must verify."""
    import json

    from pydantic import ValidationError

    if "execution" not in proposal:
        if required:
            raise RuntimeErrorCode("execution_verification_failed")
        return None
    try:
        receipt = ExecutionReceipt.model_validate_json(
            json.dumps(proposal["execution"])
        )
        now = datetime.now(UTC)
        expected = "buy-again-ui" if mode == "buy_again" else mode
        if (
            receipt.goal_id != task
            or str(receipt.proposal_id) != proposal["id"]
            or receipt.playbook != "playbook://commerce/" + expected
            or not receipt.observed_at <= now < receipt.expires_at
            or (receipt.expires_at - receipt.observed_at).total_seconds() > 301
            or type(proposal["can_apply"]) is not bool
            or receipt.state
            != ("awaiting_confirmation" if proposal["can_apply"] else "needs_input")
            or receipt.verdict != ("pass" if proposal["can_apply"] else "needs_input")
            or (proposal["can_apply"] and (receipt.reasons or proposal.get("issues")))
        ):
            raise ValueError("unverified")
        return receipt
    except (ValidationError, ValueError, KeyError, TypeError):
        raise RuntimeErrorCode("execution_verification_failed") from None
