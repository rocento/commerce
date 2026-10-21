"""Versioned internal contracts. Authority is supplied by services, never these types."""

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import Field, model_validator

from app.commerce_contracts.base import Contract as Contract  # noqa: PLC0414

Code = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_.:/-]{0,119}$")]
Identifier = Annotated[
    str,
    Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"),
]
Version = Annotated[
    str, Field(pattern=r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
]
Text = Annotated[str, Field(min_length=1, max_length=1000)]
Timestamp = Annotated[int, Field(ge=0, le=253402300799)]
Channel = Literal["storefront", "admin", "evaluation"]
Journey = Literal[
    "discovery", "shop", "optimize", "buy_again", "cart", "order", "general"
]


class Risk(StrEnum):
    R0 = "R0"
    R1 = "R1"
    R2 = "R2"
    R3 = "R3"
    R4 = "R4"


class Confirmation(StrEnum):
    NONE = "none"
    UNDO = "undo"
    INTENT = "explicit_intent"
    FRESH = "fresh_confirmation"
    STEP_UP = "step_up"


class ActorContext(Contract):
    """Only the trusted gateway/composition root may construct this context."""

    tenant_id: Identifier
    store_id: Identifier
    actor_id: Identifier | None = None
    principal_id: Identifier | None = None
    session_id: Identifier
    request_id: Identifier
    channel: Channel
    scopes: tuple[Code, ...] = Field(default=(), max_length=32)


class Freshness(Contract):
    observed_at: Timestamp
    expires_at: Timestamp
    revalidate_before_action: bool = True

    @model_validator(mode="after")
    def ordered(self) -> "Freshness":
        if self.expires_at < self.observed_at:
            raise ValueError("Expiry precedes observation")
        return self

    def valid_at(self, now: int) -> bool:
        return self.observed_at <= now < self.expires_at


class EvidenceRef(Contract):
    source_kind: Literal[
        "catalog", "commerce", "approved_knowledge", "customer", "inference"
    ]
    source_id: Code
    source_version: Code
    freshness: Freshness
    display: Literal["cite", "saved_snapshot", "inference", "internal"]


class IntentCandidate(Contract):
    name: Code
    confidence: float = Field(ge=0, le=1)
    provenance: Literal["explicit", "model", "rule"]
    evidence: tuple[EvidenceRef, ...] = Field(default=(), max_length=8)


class Intent(Contract):
    goal: Text
    selected: IntentCandidate
    alternatives: tuple[IntentCandidate, ...] = Field(default=(), max_length=5)


class Constraint(Contract):
    field: Code
    operator: Literal["eq", "neq", "lt", "lte", "gt", "gte", "in", "contains"]
    values: tuple[str | int | bool, ...] = Field(min_length=1, max_length=20)
    strength: Literal["hard", "soft", "inferred"]
    source: Literal["platform", "merchant", "customer", "catalog", "model"]
    scope: Literal["goal", "product", "basket", "action"]
    evidence: EvidenceRef | None = None


class ConstraintSet(Contract):
    constraints: tuple[Constraint, ...] = Field(default=(), max_length=40)
    conflict: Literal["none", "clarify", "deny"] = "none"


class ActionEnvelope(Contract):
    context: ActorContext
    risk: Risk
    confirmation: Confirmation
    idempotency_key: Identifier | None = None
    expected_revision: int | None = Field(default=None, ge=0)
    expires_at: Timestamp

    @model_validator(mode="after")
    def mutation_requirements(self) -> "ActionEnvelope":
        validate_risk(
            self.risk,
            self.confirmation,
            bool(self.context.scopes),
            bool(self.idempotency_key),
            True,
        )
        if self.risk in {Risk.R2, Risk.R3, Risk.R4} and self.expected_revision is None:
            raise ValueError("Mutation revision required")
        return self


def validate_risk(
    risk: Risk, confirmation: Confirmation, scopes: bool, idempotent: bool, fresh: bool
) -> None:
    minimum = {
        Risk.R0: {
            Confirmation.NONE,
            Confirmation.UNDO,
            Confirmation.INTENT,
            Confirmation.FRESH,
            Confirmation.STEP_UP,
        },
        Risk.R1: {
            Confirmation.UNDO,
            Confirmation.INTENT,
            Confirmation.FRESH,
            Confirmation.STEP_UP,
        },
        Risk.R2: {Confirmation.INTENT, Confirmation.FRESH, Confirmation.STEP_UP},
        Risk.R3: {Confirmation.FRESH, Confirmation.STEP_UP},
        Risk.R4: {Confirmation.STEP_UP},
    }
    if confirmation not in minimum[risk]:
        raise ValueError("Confirmation cannot weaken risk requirements")
    if risk in {Risk.R2, Risk.R3, Risk.R4} and not (scopes and idempotent and fresh):
        raise ValueError("Mutations require scopes, idempotency and freshness")


class DefinitionRef(Contract):
    id: Code
    version: Version
    schema_major: Literal[1] = 1


class Visibility(Contract):
    tenants: tuple[Identifier, ...] = Field(default=(), max_length=100)
    channels: tuple[Channel, ...] = ("storefront", "evaluation")
    required_scopes: tuple[Code, ...] = Field(default=(), max_length=32)


class Metadata(Contract):
    id: Code
    version: Version
    visibility: Visibility = Visibility()
    dependencies: tuple[DefinitionRef, ...] = Field(default=(), max_length=32)
    deprecated_after: Timestamp | None = None
    disabled_after: Timestamp | None = None


class SkillDefinition(Metadata):
    kind: Literal["skill"] = "skill"
    input_contract: Code
    output_contract: Code
    risk: Risk = Risk.R0
    confirmation: Confirmation = Confirmation.NONE
    idempotency: Literal["none", "required"] = "none"
    freshness_seconds: int = Field(default=0, ge=0, le=86400)
    timeout_ms: int = Field(default=20000, ge=1, le=120000)
    max_calls: int = Field(default=1, ge=0, le=16)

    @model_validator(mode="after")
    def safe_skill(self) -> "SkillDefinition":
        validate_risk(
            self.risk,
            self.confirmation,
            bool(self.visibility.required_scopes),
            self.idempotency == "required",
            self.freshness_seconds > 0,
        )
        return self


class SkillInput(Contract):
    skill: DefinitionRef
    action: ActionEnvelope
    intent: Intent
    constraints: ConstraintSet = ConstraintSet()


class FailureCategory(StrEnum):
    RETRYABLE = "retryable"
    REPLANNABLE = "replannable"
    USER_ACTION = "user_action_required"
    TERMINAL = "terminal"


class TypedFailure(Contract):
    category: FailureCategory
    code: Code
    request_id: Identifier
    # A public code, never an exception message, URL, prompt or private model context.
    recovery: Literal["retry", "refresh", "clarify", "authenticate", "browse", "stop"]


class SkillResult(Contract):
    skill: DefinitionRef
    status: Literal["succeeded", "failed", "requires_action"]
    evidence: tuple[EvidenceRef, ...] = Field(default=(), max_length=20)
    failure: TypedFailure | None = None

    @model_validator(mode="after")
    def coherent(self) -> "SkillResult":
        if (self.status == "failed") != (self.failure is not None):
            raise ValueError("Failure and status disagree")
        return self


class PlaybookDefinition(Metadata):
    kind: Literal["playbook"] = "playbook"
    journey: Journey
    steps: tuple[DefinitionRef, ...] = Field(min_length=1, max_length=16)


class PolicyDefinition(Metadata):
    kind: Literal["policy"] = "policy"
    reason_codes: tuple[Code, ...] = Field(min_length=1, max_length=20)


class IndustryPack(Metadata):
    kind: Literal["industry"] = "industry"
    attributes: tuple[Code, ...] = Field(default=(), max_length=100)


class ProviderCapabilities(Metadata):
    kind: Literal["provider"] = "provider"
    profile: Code
    structured_output: bool
    tool_calling: bool
    streaming: bool
    vision: bool
    max_context_tokens: int = Field(ge=1, le=10000000)
    usage_reporting: bool


class ModelRequirements(Contract):
    structured_output: bool = False
    tool_calling: bool = False
    streaming: bool = False
    vision: bool = False
    context_tokens: int = Field(default=1, ge=1, le=10000000)
    usage_reporting: bool = True


class PolicyInput(Contract):
    action: ActionEnvelope
    constraints: ConstraintSet
    evidence: tuple[EvidenceRef, ...] = Field(default=(), max_length=20)


class PolicyDecision(Contract):
    policy: DefinitionRef
    outcome: Literal["allow", "deny", "require_confirmation", "require_step_up"]
    reasons: tuple[Code, ...] = Field(min_length=1, max_length=10)


class Budget(Contract):
    max_steps: int = Field(default=8, ge=1, le=16)
    max_model_calls: int = Field(default=2, ge=0, le=4)
    max_tool_calls: int = Field(default=6, ge=0, le=16)
    max_tokens: int = Field(default=16384, ge=0, le=1000000)
    max_cost_micros: int = Field(default=0, ge=0, le=1000000000)
    timeout_ms: int = Field(default=25000, ge=1, le=120000)


class PlanStep(Contract):
    id: Code
    skill: DefinitionRef
    depends_on: tuple[Code, ...] = Field(default=(), max_length=16)
    preconditions: tuple[Code, ...] = Field(default=(), max_length=16)


class ExecutionPlan(Contract):
    goal_id: Identifier
    playbook: DefinitionRef
    steps: tuple[PlanStep, ...] = Field(min_length=1, max_length=16)
    budget: Budget = Budget()

    @model_validator(mode="after")
    def bounded_dag(self) -> "ExecutionPlan":
        seen: set[str] = set()
        if len(self.steps) > self.budget.max_steps:
            raise ValueError("Plan exceeds step budget")
        for step in self.steps:
            if step.id in seen or not set(step.depends_on) <= seen:
                raise ValueError("Plan must have unique, topologically ordered steps")
            seen.add(step.id)
        return self


class Observation(Contract):
    step_id: Code
    result: SkillResult
    observed_at: Timestamp


class VerificationReport(Contract):
    goal_id: Identifier
    status: Literal["verified", "rejected", "unknown"]
    constraints_satisfied: bool
    policies_satisfied: bool
    evidence_fresh: bool
    action_ready: bool
    reasons: tuple[Code, ...] = Field(default=(), max_length=20)

    @model_validator(mode="after")
    def verified_action(self) -> "VerificationReport":
        if self.action_ready and not (
            self.status == "verified"
            and self.constraints_satisfied
            and self.policies_satisfied
            and self.evidence_fresh
        ):
            raise ValueError("Unverified action cannot be ready")
        return self


class GoalStatus(StrEnum):
    CREATED = "created"
    PLANNED = "planned"
    RUNNING = "running"
    WAITING = "waiting_for_user"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ExecutionStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ExecutionState(Contract):
    step_id: Code
    status: ExecutionStatus = ExecutionStatus.PENDING
    attempts: int = Field(default=0, ge=0, le=4)
    failure: TypedFailure | None = None


class GoalState(Contract):
    id: Identifier
    context: ActorContext
    status: GoalStatus = GoalStatus.CREATED
    revision: int = Field(default=0, ge=0)
    budget: Budget = Budget()
    executions: tuple[ExecutionState, ...] = Field(default=(), max_length=16)
    versions: tuple[DefinitionRef, ...] = Field(default=(), max_length=40)


class DecisionTrace(Contract):
    request_id: Identifier
    tenant_id: Identifier
    store_id: Identifier
    journey: Journey
    path: Literal["legacy", "core", "deterministic"]
    reason: Literal[
        "flag_off",
        "journey_disabled",
        "core_selected",
        "core_unavailable",
        "provider_unavailable",
        "existing_deterministic",
    ]
    versions: tuple[DefinitionRef, ...] = Field(default=(), max_length=40)
    deprecated: tuple[DefinitionRef, ...] = Field(default=(), max_length=40)


Definition = (
    SkillDefinition
    | PlaybookDefinition
    | PolicyDefinition
    | IndustryPack
    | ProviderCapabilities
)
