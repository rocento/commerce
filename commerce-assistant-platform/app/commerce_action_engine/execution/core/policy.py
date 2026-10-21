"""Deterministic policy over trusted facts. Decisions are advice, never Rust capabilities."""

from typing import Literal

from pydantic import Field, model_validator

from app.commerce_action_engine.contracts.action import (
    ActorContext,
    Code,
    Risk,
    Timestamp,
)
from app.commerce_action_engine.execution.core.meaning import MeaningContract

Action = Literal[
    "catalog_read",
    "recommend",
    "answer",
    "personalize",
    "preference_save",
    "cart_apply",
    "order_submit",
    "payment",
    "refund",
    "account_change",
]
RISKS: dict[str, Risk] = {
    "catalog_read": Risk.R0,
    "recommend": Risk.R0,
    "answer": Risk.R0,
    "personalize": Risk.R0,
    "preference_save": Risk.R1,
    "cart_apply": Risk.R2,
    "order_submit": Risk.R3,
    "payment": Risk.R3,
    "refund": Risk.R3,
    "account_change": Risk.R4,
}


class PolicyFacts(MeaningContract):
    """Only composition roots may supply these; never validate a model/tool text as facts."""

    context: ActorContext
    action: Action
    resource_tenant: str
    resource_store: str
    available: bool
    authorized: bool
    evidence_verified: bool
    fresh_until: Timestamp
    restricted: bool = False
    age_location_category_allowed: bool = True
    personal_data: bool = False
    consent: bool = False
    ranking_allowed: bool = True
    citations_verified: bool = True
    explicit_intent: bool = False
    confirmation_until: Timestamp = 0
    authentication_until: Timestamp = 0
    step_up_until: Timestamp = 0
    undo_available: bool = False


class PolicyFact(MeaningContract):
    name: Code
    value: str | bool | int


class PolicyDecision(MeaningContract):
    policy: Literal["commerce/default"] = "commerce/default"
    version: Literal["1.0.0"] = "1.0.0"
    outcome: Literal[
        "allow",
        "deny",
        "require_confirmation",
        "require_authentication",
        "require_step_up",
        "redact",
    ]
    reason: Code
    facts: tuple[PolicyFact, ...]
    actor: ActorContext
    action: Action
    risk: Risk
    confirmation: Literal[
        "none", "undo", "explicit_intent", "fresh_confirmation", "step_up"
    ]
    expires_at: Timestamp
    audit_ref: str = Field(min_length=1, max_length=200)


def evaluate(facts: PolicyFacts, *, now: int) -> PolicyDecision:
    risk = RISKS[facts.action]
    outcome: Literal[
        "allow",
        "deny",
        "require_confirmation",
        "require_authentication",
        "require_step_up",
        "redact",
    ] = "allow"
    reason = "verified"
    confirmations: dict[
        Risk,
        Literal["none", "undo", "explicit_intent", "fresh_confirmation", "step_up"],
    ] = {
        Risk.R0: "none",
        Risk.R1: "undo",
        Risk.R2: "explicit_intent",
        Risk.R3: "fresh_confirmation",
        Risk.R4: "step_up",
    }
    confirm = confirmations[risk]
    if (
        facts.resource_tenant != facts.context.tenant_id
        or facts.resource_store != facts.context.store_id
    ):
        outcome, reason = "deny", "scope_mismatch"
    elif not facts.available:
        outcome, reason = "deny", "channel_unavailable"
    elif facts.restricted or not facts.age_location_category_allowed:
        outcome, reason = "deny", "restricted_product"
    elif not facts.authorized:
        outcome, reason = "deny", "action_forbidden"
    elif not facts.evidence_verified:
        outcome, reason = "deny", "unverified_evidence"
    elif facts.fresh_until <= now:
        outcome, reason = "deny", "stale_commerce_facts"
    elif facts.personal_data and not facts.consent:
        outcome, reason = "redact", "consent_missing"
    elif not facts.ranking_allowed:
        outcome, reason = "deny", "ranking_forbidden"
    elif facts.action == "answer" and not facts.citations_verified:
        outcome, reason = "deny", "citations_missing"
    elif risk != Risk.R0 and facts.context.actor_id is None:
        outcome, reason = "require_authentication", "authentication_missing"
    elif risk == Risk.R1 and not facts.undo_available:
        outcome, reason = "deny", "undo_missing"
    elif risk == Risk.R2 and not facts.explicit_intent:
        outcome, reason = "require_confirmation", "explicit_intent_missing"
    elif risk in {Risk.R3, Risk.R4} and facts.authentication_until <= now:
        outcome, reason = "require_authentication", "fresh_authentication_missing"
    elif risk == Risk.R4 and facts.step_up_until <= now:
        outcome, reason = "require_step_up", "step_up_missing"
    elif risk in {Risk.R3, Risk.R4} and facts.confirmation_until <= now:
        outcome, reason = "require_confirmation", "fresh_confirmation_missing"
    expiry = min(now + 60, facts.fresh_until)
    if outcome == "allow" and risk in {Risk.R3, Risk.R4}:
        expiry = min(expiry, facts.authentication_until, facts.confirmation_until)
        if risk == Risk.R4:
            expiry = min(expiry, facts.step_up_until)
    return PolicyDecision(
        outcome=outcome,
        reason=reason,
        facts=tuple(
            PolicyFact(name=name, value=value)
            for name, value in {
                "scope_matches": facts.resource_tenant == facts.context.tenant_id
                and facts.resource_store == facts.context.store_id,
                "available": facts.available,
                "authorized": facts.authorized,
                "evidence_verified": facts.evidence_verified,
                "fresh_until": facts.fresh_until,
                "restricted": facts.restricted,
                "age_location_category_allowed": facts.age_location_category_allowed,
                "consent": facts.consent,
                "ranking_allowed": facts.ranking_allowed,
                "citations_verified": facts.citations_verified,
                "explicit_intent": facts.explicit_intent,
                "confirmation_until": facts.confirmation_until,
                "authentication_until": facts.authentication_until,
                "step_up_until": facts.step_up_until,
            }.items()
        ),
        actor=facts.context,
        action=facts.action,
        risk=risk,
        confirmation=confirm,
        expires_at=max(0, expiry),
        audit_ref=f"{facts.context.request_id}/{facts.action}/{reason}",
    )


class AssessedStep(MeaningContract):
    id: Code
    action: Action
    policy: PolicyDecision

    @model_validator(mode="after")
    def consistent(self) -> "AssessedStep":
        if self.policy.action != self.action or self.policy.risk != RISKS[self.action]:
            raise ValueError("Plan step and risk decision disagree")
        return self
