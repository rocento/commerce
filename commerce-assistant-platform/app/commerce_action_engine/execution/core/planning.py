"""Pure bounded plan compilation. Definition resolution never grants execution authority."""

from collections.abc import Mapping
from types import MappingProxyType
from typing import Literal

from pydantic import BaseModel, Field, ValidationError, model_validator

from app.commerce_action_engine.contracts.action import (
    ActorContext,
    Code,
    Contract,
    DefinitionRef,
    Risk,
    SkillDefinition,
    Text,
)
from app.commerce_action_engine.execution.core.meaning import (
    ConstraintFrame,
    contradictions,
)
from app.commerce_action_engine.execution.core.policy import (
    RISKS,
    Action,
    PolicyDecision,
)


class PlanningError(ValueError):
    """Public reason code, never rejected model arguments or private context."""


class ExecutableSkill(SkillDefinition):
    purpose: Text
    intents: tuple[Code, ...] = Field(min_length=1, max_length=32)
    requires: tuple[Code, ...] = Field(default=(), max_length=16)
    preconditions: tuple[Code, ...] = Field(default=(), max_length=16)
    postconditions: tuple[Code, ...] = Field(default=(), max_length=16)
    ports: tuple[Code, ...] = Field(min_length=1, max_length=4)
    max_attempts: int = Field(default=1, ge=1, le=3)
    concurrency: Literal["serial", "parallel_read"] = "serial"
    cost_class: Literal["local", "remote_read", "model", "mutation"]
    latency_class: Literal["local", "interactive", "slow"] = "interactive"
    token_reservation: int = Field(default=0, ge=0, le=1000000)
    cost_reservation_micros: int = Field(default=0, ge=0, le=10000000)
    produces: tuple[Code, ...] = Field(default=(), max_length=16)
    fallback: Literal["none", "clarify", "browse", "review", "legacy_before_start"] = (
        "none"
    )
    executor: Literal["assistant", "rust_ui"] = "assistant"
    policy_action: Action | None = None

    @model_validator(mode="after")
    def no_unsafe_retry(self) -> "ExecutableSkill":
        if self.risk != Risk.R0 and (
            self.policy_action is None or RISKS[self.policy_action] != self.risk
        ):
            raise ValueError("Action policy must match risk")
        if self.max_attempts > 1 and self.idempotency != "required":
            raise ValueError("Retries require declared idempotency")
        if self.risk != Risk.R0 and self.concurrency != "serial":
            raise ValueError("Mutations cannot run concurrently")
        return self


class PlannedNode(Contract):
    id: Code
    skill: DefinitionRef
    depends_on: tuple[Code, ...] = Field(default=(), max_length=16)
    max_calls: int = Field(default=1, ge=1, le=8)
    required: bool = True
    arguments_json: str | None = Field(default=None, max_length=16000)


class Procedure(Contract):
    id: Code
    version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    intents: tuple[Code, ...] = Field(min_length=1, max_length=32)
    requires: tuple[Code, ...] = Field(default=(), max_length=16)
    nodes: tuple[PlannedNode, ...] = Field(min_length=1, max_length=16)
    policies: tuple[DefinitionRef, ...] = Field(min_length=1, max_length=16)
    verification: tuple[Code, ...] = Field(min_length=1, max_length=16)
    fallbacks: tuple[
        Literal["clarify", "browse", "review", "relax_soft_preferences"], ...
    ] = ()
    mode: Literal["read", "action_proposal"] = "read"


class PlanningBudget(Contract):
    max_steps: int = Field(default=16, ge=1, le=16)
    max_tool_calls: int = Field(default=8, ge=0, le=32)
    max_model_calls: int = Field(default=1, ge=0, le=4)
    max_tokens: int = Field(default=131072, ge=0, le=1000000)
    max_cost_micros: int = Field(default=100000, ge=0, le=10000000)
    max_mutations: int = Field(default=0, ge=0, le=4)
    timeout_ms: int = Field(default=25000, ge=1, le=120000)
    max_concurrency: int = Field(default=1, ge=1, le=4)


class PlanResources(Contract):
    tools: int = Field(default=0, ge=0)
    models: int = Field(default=0, ge=0)
    tokens: int = Field(default=0, ge=0)
    cost_micros: int = Field(default=0, ge=0)
    mutations: int = Field(default=0, ge=0)


class BoundPlan(Contract):
    playbook: DefinitionRef
    context: ActorContext
    nodes: tuple[PlannedNode, ...]
    budget: PlanningBudget
    reserved: PlanResources
    policies: tuple[PolicyDecision, ...] = ()
    mode: Literal["read", "action_proposal"]
    reason: Literal["known_journey", "validated_composition"]
    stop_conditions: tuple[Code, ...] = (
        "budget_exceeded",
        "policy_denied",
        "dependency_failed",
        "hard_constraint_conflict",
        "deadline",
        "cancelled",
    )


class IndustryRules(Contract):
    id: Code
    version: str
    attributes: tuple[Code, ...]
    status: Literal["dataset_validated", "schema_ready"]
    policies: tuple[Code, ...]


class PlanningLibrary:
    """Immutable exact pins; schemas come from the existing typed operation adapters."""

    def __init__(
        self,
        skills: tuple[ExecutableSkill, ...],
        procedures: tuple[Procedure, ...],
        schemas: Mapping[str, type[BaseModel]],
    ):
        self.skills = MappingProxyType({(s.id, s.version): s for s in skills})
        self.procedures = MappingProxyType({(p.id, p.version): p for p in procedures})
        self.schemas = MappingProxyType(dict(schemas))
        if len(self.skills) != len(skills) or len(self.procedures) != len(procedures):
            raise PlanningError("duplicate_definition")
        for skill in skills:
            if (
                not skill.id.startswith("skill://")
                or skill.input_contract not in schemas
                or skill.output_contract not in schemas
            ):
                raise PlanningError("unknown_contract")
        for procedure in procedures:
            if any(
                (p.id, p.version)
                not in {
                    ("policy://commerce/authority", "1.0.0"),
                    ("policy://commerce/default", "1.0.0"),
                }
                for p in procedure.policies
            ):
                raise PlanningError("unknown_policy_version")
            self.check_graph(procedure.nodes)
            if not procedure.id.startswith("playbook://"):
                raise PlanningError("invalid_playbook_id")

    def skill(self, ref: DefinitionRef) -> ExecutableSkill:
        if (ref.id, ref.version) not in self.skills:
            raise PlanningError("unknown_skill_version")
        return self.skills[(ref.id, ref.version)]

    def check_graph(self, nodes: tuple[PlannedNode, ...]) -> None:
        seen: set[str] = set()
        for node in nodes:
            if (
                node.id in seen
                or not set(node.depends_on) <= seen
                or node.id in node.depends_on
            ):
                raise PlanningError("invalid_or_cyclic_plan")
            skill = self.skill(node.skill)
            if node.max_calls > skill.max_calls:
                raise PlanningError("skill_call_limit")
            if node.arguments_json is not None:
                try:
                    self.schemas[skill.input_contract].model_validate_json(
                        node.arguments_json
                    )
                except (ValidationError, ValueError):
                    raise PlanningError("invalid_skill_arguments") from None
            seen.add(node.id)

    def compile(
        self,
        ref: DefinitionRef,
        context: ActorContext,
        *,
        capabilities: frozenset[str],
        available_context: frozenset[str],
        constraints: ConstraintFrame | None = None,
        budget: PlanningBudget | None = None,
        proposed_nodes: tuple[PlannedNode, ...] | None = None,
        decisions: tuple[PolicyDecision, ...] = (),
        now: int = 0,
    ) -> BoundPlan:
        constraints = constraints or ConstraintFrame()
        budget = budget or PlanningBudget()
        procedure = self.procedures.get((ref.id, ref.version))
        if procedure is None:
            raise PlanningError("unknown_playbook_version")
        if not set(procedure.requires) <= available_context:
            raise PlanningError("missing_context")
        if constraints.conflicts or contradictions(constraints.requirements):
            raise PlanningError("hard_constraint_conflict")
        nodes = procedure.nodes if proposed_nodes is None else proposed_nodes
        if not nodes or len(nodes) > budget.max_steps:
            raise PlanningError("step_budget")
        self.check_graph(nodes)
        if proposed_nodes is not None:
            replacements = {n.id: n for n in nodes}
            for original in procedure.nodes:
                candidate = replacements.get(original.id)
                if original.required and candidate is None:
                    raise PlanningError("required_step_missing")
                if candidate is not None and (
                    candidate.skill != original.skill
                    or not set(original.depends_on) <= set(candidate.depends_on)
                    or candidate.max_calls > original.max_calls
                ):
                    raise PlanningError("composition_weakens_procedure")
        # Composition may only use this approved procedure's skill vocabulary.
        permitted = {(n.skill.id, n.skill.version) for n in procedure.nodes}
        totals = {
            "tools": 0,
            "models": 0,
            "tokens": 0,
            "cost_micros": 0,
            "mutations": 0,
        }
        calls_by_skill: dict[tuple[str, str], int] = {}
        produced: dict[str, frozenset[str]] = {}
        for node in nodes:
            skill = self.skill(node.skill)
            key = (skill.id, skill.version)
            calls_by_skill[key] = calls_by_skill.get(key, 0) + node.max_calls
            if calls_by_skill[key] > skill.max_calls:
                raise PlanningError("skill_call_limit")
            if (skill.id, skill.version) not in permitted:
                raise PlanningError("skill_not_in_playbook")
            v = skill.visibility
            if (
                (v.tenants and context.tenant_id not in v.tenants)
                or context.channel not in v.channels
                or not set(v.required_scopes) <= set(context.scopes)
            ):
                raise PlanningError("skill_not_authorized")
            if skill.disabled_after is not None and now >= skill.disabled_after:
                raise PlanningError("skill_expired")
            inherited = frozenset(
                key for dep in node.depends_on for key in produced[dep]
            )
            if (
                not set(skill.requires) <= available_context
                or not set(skill.preconditions) <= available_context | inherited
            ):
                raise PlanningError("skill_precondition_missing")
            produced[node.id] = inherited | frozenset(skill.produces)
            if not set(skill.ports) <= capabilities:
                raise PlanningError("port_unavailable")
            count = node.max_calls * skill.max_attempts
            totals["models"] += count * (skill.cost_class == "model")
            totals["tools"] += count * (skill.cost_class in {"remote_read", "mutation"})
            totals["tokens"] += count * skill.token_reservation
            totals["cost_micros"] += count * skill.cost_reservation_micros
            totals["mutations"] += count * (skill.risk != Risk.R0)
            if skill.risk != Risk.R0:
                matching = [
                    d
                    for d in decisions
                    if d.action == skill.policy_action
                    and d.risk == skill.risk
                    and d.actor == context
                    and d.expires_at > now
                ]
                if (
                    procedure.mode != "action_proposal"
                    or not matching
                    or any(d.outcome in {"deny", "redact"} for d in matching)
                ):
                    raise PlanningError("risk_not_authorized")
        for resource, limit in [
            ("tools", budget.max_tool_calls),
            ("models", budget.max_model_calls),
            ("tokens", budget.max_tokens),
            ("cost_micros", budget.max_cost_micros),
            ("mutations", budget.max_mutations),
        ]:
            if totals[resource] > limit:
                raise PlanningError("resource_budget")
        return BoundPlan(
            playbook=ref,
            context=context,
            nodes=nodes,
            budget=budget,
            reserved=PlanResources.model_validate(totals),
            policies=decisions,
            mode=procedure.mode,
            reason="validated_composition"
            if proposed_nodes is not None
            else "known_journey",
        )
