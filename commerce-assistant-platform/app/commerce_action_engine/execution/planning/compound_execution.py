"""One bounded receipted mutation procedure; general planning stays read-only."""

import json
import time

from app.commerce_action_engine.actions.catalog import ProductArgs
from app.commerce_action_engine.contracts.action import (
    ActorContext,
    DefinitionRef,
    Risk,
)
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.agents import Principal
from app.commerce_action_engine.execution.core.meaning import ConstraintFrame
from app.commerce_action_engine.execution.core.planning import (
    BoundPlan,
    ExecutableSkill,
    PlanningError,
)
from app.commerce_action_engine.execution.core.policy import (
    PolicyDecision,
    PolicyFacts,
    evaluate,
)
from app.commerce_action_engine.execution.planning.compound_review import admitted_pair
from app.commerce_action_engine.execution.planning.runtime import PlanningSession
from app.commerce_action_engine.shared.errors import RuntimeErrorCode
from app.commerce_contracts.compound_plan import CompoundPlan
from app.commerce_contracts.compound_write import (
    CompoundCommand,
    CompoundDispatch,
)


def executable(
    plan: CompoundPlan, result: InterpretedRequest, principal: Principal
) -> CompoundPlan:
    """Only for a newly prepared plan, before its first persistence/dispatch."""
    if (
        not admitted_pair(result)
        or principal.persona != "shopper"
        or principal.tenant != plan.scope.tenant_id
        or principal.subject != plan.scope.customer_id
        or plan.execution_enabled
        or any(a.state != "ready" for a in plan.actions)
    ):
        raise PlanningError("compound_execution_not_admitted")
    for source, action in zip(
        result.requested_actions.requestedActions or [], plan.actions, strict=True
    ):
        item = source.items[0]
        if (
            source.id != action.source_label
            or source.intent != action.intent
            or item.productText != action.query
            or (item.quantity or 1) != action.quantity
            or bool(source.after) != bool(action.customer_after)
        ):
            raise PlanningError("compound_interpretation_changed")
    data = plan.model_dump(mode="json")
    data.update(execution_enabled=True, playbook="playbook://commerce/compound-execute")
    return CompoundPlan.model_validate_json(json.dumps(data))


class CompoundExecutionSession(PlanningSession):
    def __init__(
        self, plan: CompoundPlan, principal: Principal, *, write_capability: bool
    ):
        plan = CompoundPlan.model_validate_json(plan.model_dump_json())
        self.command = CompoundCommand.from_plan(plan)
        if (
            not write_capability
            or not plan.execution_enabled
            or principal.persona != "shopper"
            or principal.tenant != plan.scope.tenant_id
            or principal.subject != plan.scope.customer_id
            or any(a.state != "ready" for a in plan.actions)
        ):
            raise PlanningError("compound_capability_required")
        super().__init__(
            "compound-execute",
            principal,
            frozenset({"catalog.get_product", "commerce.compound_apply"}),
            tool_limit=5,
            context_keys=frozenset({"compound_write"}),
        )

    def _decision(self) -> PolicyDecision:
        now = int(time.time())
        return evaluate(
            PolicyFacts(
                context=self.context,
                action="cart_apply",
                resource_tenant=str(self.command.scope.tenant_id),
                resource_store=str(self.command.scope.tenant_id),
                available=True,
                authorized="compound_write" in self.context.scopes,
                evidence_verified=all(
                    a.observed_at <= now for a in self.command.actions
                ),
                fresh_until=min(a.expires_at for a in self.command.actions),
                explicit_intent=True,
            ),
            now=now,
        )

    def _compile(self, journey: str, constraints: ConstraintFrame) -> BoundPlan:
        scope = self.command.scope
        self.context = ActorContext(
            tenant_id=str(scope.tenant_id),
            store_id=str(scope.tenant_id),
            actor_id=str(scope.customer_id),
            session_id=str(scope.conversation_id),
            request_id=str(self.command.request_id),
            channel="storefront",
            scopes=("compound_write",),
        )
        self.budget = self.budget.model_copy(
            update={"max_mutations": 2, "max_model_calls": 0}
        )
        decision = self._decision()
        if decision.outcome != "allow":
            raise PlanningError("compound_policy_denied")
        ref = DefinitionRef(id="playbook://commerce/compound-execute", version="1.0.0")
        procedure = self.library.procedures.get((ref.id, ref.version))
        if procedure is None or tuple(n.id for n in procedure.nodes) != (
            "facts1",
            "facts2",
            "write1",
            "refresh2",
            "write2",
        ):
            raise PlanningError("compound_procedure_unavailable")
        nodes = []
        for node in procedure.nodes:
            index = 0 if node.id in {"facts1", "write1"} else 1
            action = self.command.actions[index]
            args = (
                CompoundDispatch(command=self.command, action_id=action.action_id)
                if node.id.startswith("write")
                else ProductArgs(product_id=str(action.product_id))
            )
            nodes.append(
                node.model_copy(update={"arguments_json": args.model_dump_json()})
            )
        return self.library.compile(
            ref,
            self.context,
            capabilities=self.ports,
            available_context=self.available,
            constraints=constraints,
            budget=self.budget,
            proposed_nodes=tuple(nodes),
            decisions=(decision,),
            now=int(time.time()),
        )

    def _authorize_step(self, skill: ExecutableSkill) -> None:
        allowed = {
            ("skill://catalog/compound-execution-facts", Risk.R0),
            ("skill://commerce/compound-apply", Risk.R2),
        }
        if (
            (skill.id, skill.risk) not in allowed
            or skill.executor != "assistant"
            or self.plan.playbook.id != "playbook://commerce/compound-execute"
            or self._decision().outcome != "allow"
        ):
            raise RuntimeErrorCode("compound_policy_denied")
