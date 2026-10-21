"""Bind validated procedures to existing typed operations; no new tool or mutation access."""

import asyncio
import time
from collections.abc import Awaitable, Callable, Mapping
from typing import TYPE_CHECKING, TypeVar
from uuid import uuid4

from pydantic import BaseModel, ValidationError

from app.commerce_action_engine.contracts.action import (
    ActorContext,
    DefinitionRef,
    Risk,
)
from app.commerce_action_engine.execution.agents import Principal
from app.commerce_action_engine.execution.core.meaning import ConstraintFrame
from app.commerce_action_engine.execution.core.planning import (
    BoundPlan,
    ExecutableSkill,
    PlanningBudget,
    PlanningError,
)
from app.commerce_action_engine.execution.planning.library import (
    GoalInput,
    LocalReceipt,
    industry_rules,
    library,
)
from app.commerce_action_engine.shared.errors import RuntimeErrorCode
from app.commerce_resolution_engine.contracts import (
    ModelProvider,
    ModelRequest,
    ModelResponse,
)

T = TypeVar("T")
if TYPE_CHECKING:
    from app.commerce_action_engine.actions.catalog import Product
    from app.commerce_action_engine.actions.shopping import ShoppingIntent


class PlanningSession:
    def __init__(
        self,
        journey: str,
        principal: Principal,
        ports: frozenset[str],
        *,
        tool_limit: int = 8,
        timeout_ms: int = 25000,
        context_keys: frozenset[str] = frozenset(),
        prices: tuple[int, int] | None = None,
        record_planning: Callable[[dict[str, object]], None] | None = None,
    ):
        self.record_planning = record_planning
        self.library = library()
        uid = str(uuid4())
        self.context = ActorContext(
            tenant_id=str(principal.tenant),
            store_id=str(principal.tenant),
            actor_id=str(principal.subject) if principal.subject else None,
            session_id=uid,
            request_id=uid,
            channel="storefront",
        )
        self.available = (
            frozenset({"basket_capability"} if "basket.context" in ports else ())
            | frozenset({"authenticated"} if principal.subject else ())
            | context_keys
        )
        self.ports = ports
        self.budget = PlanningBudget(max_tool_calls=tool_limit, timeout_ms=timeout_ms)
        self.started = time.monotonic()
        self.attempts: dict[str, int] = {}
        self.completed: dict[str, int] = {}
        self.active: str | None = None
        self.failed = False
        self.tokens = 0
        self.prices = prices
        self.cost_micros = 0
        self.industry: dict[str, object] | None = None
        self.plan = self._compile(journey, ConstraintFrame())
        self._record()

    def _compile(self, journey: str, constraints: ConstraintFrame) -> BoundPlan:
        try:
            return self.library.compile(
                DefinitionRef(id=f"playbook://commerce/{journey}", version="1.0.0"),
                self.context,
                capabilities=self.ports,
                available_context=self.available,
                constraints=constraints,
                budget=self.budget,
                now=int(time.time()),
            )
        except PlanningError as error:
            raise RuntimeErrorCode("planning_" + str(error)) from None

    def refine(self, journey: str, constraints: ConstraintFrame | None = None) -> None:
        if self.active or self.failed or set(self.attempts) - {"schema", "interpret"}:
            raise RuntimeErrorCode("planning_refinement_after_execution")
        candidate = self._compile(journey, constraints or ConstraintFrame())
        previous = {n.id: n for n in self.plan.nodes}
        replacement = {n.id: n for n in candidate.nodes}
        if any(
            id not in replacement or replacement[id] != previous[id]
            for id in self.attempts
        ):
            raise RuntimeErrorCode("planning_refinement_changed_executed_step")
        self.plan = candidate
        self._record()

    def compose_basket(self, search_count: int) -> None:
        if self.plan.playbook.id != "playbook://commerce/shop":
            return
        if (
            not 0 <= search_count <= 5
            or self.active
            or self.failed
            or set(self.attempts) - {"context", "schema", "interpret"}
        ):
            raise RuntimeErrorCode("planning_invalid_composition")
        nodes = tuple(
            n.model_copy(update={"max_calls": search_count})
            if n.id in {"search", "rank"}
            else n
            for n in self.plan.nodes
            if search_count or n.id not in {"search", "rank"}
        )
        try:
            self.plan = self.library.compile(
                self.plan.playbook,
                self.context,
                capabilities=self.ports,
                available_context=self.available,
                budget=self.budget,
                proposed_nodes=nodes,
                now=int(time.time()),
            )
        except PlanningError as error:
            raise RuntimeErrorCode("planning_" + str(error)) from None
        self._record()

    def compose_purpose_search(self, search_count: int) -> None:
        """Reserve bounded merchant-group reads before any product retrieval."""
        self._compose_discovery_search(search_count, "purpose-discovery", 3)

    def compose_category_search(self, search_count: int) -> None:
        """Reserve the full category lookup and bounded department fallbacks."""
        self._compose_discovery_search(search_count, "category-discovery", 5)

    def _compose_discovery_search(
        self, search_count: int, journey: str, limit: int
    ) -> None:
        if (
            self.plan.playbook.id != "playbook://commerce/discovery"
            or not 1 <= search_count <= limit
            or self.active
            or self.failed
            or set(self.attempts) - {"schema", "interpret"}
        ):
            raise RuntimeErrorCode("planning_invalid_composition")
        nodes = tuple(
            n.model_copy(update={"max_calls": search_count}) if n.id == "search" else n
            for n in self.plan.nodes
            if n.id not in {"reference", "compare"}
        )
        try:
            self.plan = self.library.compile(
                DefinitionRef(id=f"playbook://commerce/{journey}", version="1.0.0"),
                self.context,
                capabilities=self.ports,
                available_context=self.available,
                budget=self.budget,
                proposed_nodes=nodes,
                now=int(time.time()),
            )
        except PlanningError as error:
            raise RuntimeErrorCode("planning_" + str(error)) from None
        self._record()

    def _record(self) -> None:
        if self.record_planning is None:
            return
        self.record_planning(
            {
                "playbook": self.plan.playbook.id,
                "version": self.plan.playbook.version,
                "reason": self.plan.reason,
                "mode": self.plan.mode,
                "skills": [
                    {
                        "step": n.id,
                        "id": n.skill.id,
                        "version": n.skill.version,
                        "attempts": self.attempts.get(n.id, 0),
                        "completed": self.completed.get(n.id, 0),
                    }
                    for n in self.plan.nodes
                ],
                "reserved": self.plan.reserved.model_dump(mode="json"),
                "failed": self.failed,
                "industry": self.industry,
                "reserved_model_cost_micros": self.cost_micros,
                "reserved_tokens": self.tokens,
            }
        )

    def discover_industry(
        self, industry: str | None, attributes: tuple[str, ...]
    ) -> None:
        self.industry = industry_rules(industry, attributes).model_dump(mode="json")
        self._record()

    def start(
        self, port: str, arguments: BaseModel, *, node_id: str | None = None
    ) -> None:
        if self.failed or self.active:
            raise RuntimeErrorCode("planning_stopped_or_concurrent")
        if (time.monotonic() - self.started) * 1000 >= self.budget.timeout_ms:
            raise RuntimeErrorCode("planning_deadline")
        matches = [
            n
            for n in self.plan.nodes
            if port in self.library.skill(n.skill).ports
            and (node_id is None or n.id == node_id)
        ]
        if len(matches) != 1:
            raise RuntimeErrorCode("planning_unregistered_port")
        node = matches[0]
        skill = self.library.skill(node.skill)
        self._authorize_step(skill)
        if self.attempts.get(node.id, 0) >= node.max_calls * skill.max_attempts:
            raise RuntimeErrorCode("planning_attempt_budget")
        if any(
            self.completed.get(dependency, 0) == 0 for dependency in node.depends_on
        ):
            raise RuntimeErrorCode("planning_dependency_incomplete")
        try:
            validated = self.library.schemas[skill.input_contract].model_validate_json(
                arguments.model_dump_json()
            )
            if node.arguments_json is not None and validated != self.library.schemas[
                skill.input_contract
            ].model_validate_json(node.arguments_json):
                raise ValueError("bound_arguments_mismatch")
        except (ValidationError, ValueError):
            raise RuntimeErrorCode("planning_invalid_arguments") from None
        self.attempts[node.id] = self.attempts.get(node.id, 0) + 1
        self.active = node.id
        self._record()

    def _authorize_step(self, skill: ExecutableSkill) -> None:
        if (
            skill.executor != "assistant"
            or skill.risk != Risk.R0
            or self.plan.mode != "read"
        ):
            raise RuntimeErrorCode("planning_external_approval_required")

    def finish(self, result: BaseModel) -> None:
        if self.active is None:
            raise RuntimeErrorCode("planning_no_active_step")
        node = next(n for n in self.plan.nodes if n.id == self.active)
        skill = self.library.skill(node.skill)
        try:
            self.library.schemas[skill.output_contract].model_validate_json(
                result.model_dump_json()
            )
        except (ValidationError, ValueError):
            self.fail()
            raise RuntimeErrorCode("planning_invalid_result") from None
        self.completed[node.id] = self.completed.get(node.id, 0) + 1
        self.active = None
        self._record()

    def fail(self) -> None:
        self.failed = True
        self.active = None
        self._record()

    def operation_timeout(self) -> float:
        remaining = self.budget.timeout_ms / 1000 - (time.monotonic() - self.started)
        node = next(n for n in self.plan.nodes if n.id == self.active)
        return max(
            0.0, min(remaining, self.library.skill(node.skill).timeout_ms / 1000)
        )

    async def perform(
        self,
        port: str,
        arguments: BaseModel,
        operation: Callable[[], Awaitable[T]],
        project: Callable[[T], BaseModel],
        *,
        node_id: str | None = None,
    ) -> T:
        self.start(port, arguments, node_id=node_id)
        try:
            async with asyncio.timeout(self.operation_timeout()):
                result = await operation()
            self.finish(project(result))
            return result
        except BaseException:
            self.fail()
            raise

    async def reason(
        self, port: str, message: str, provider: ModelProvider, request: ModelRequest
    ) -> ModelResponse:
        from app.commerce_resolution_engine.planning import (
            request_reservation,
            resolve_planned,
        )

        reserve = request_reservation(request)
        node = next(
            n for n in self.plan.nodes if port in self.library.skill(n.skill).ports
        )
        if (
            reserve > self.library.skill(node.skill).token_reservation
            or self.tokens + reserve > self.budget.max_tokens
        ):
            raise RuntimeErrorCode("planning_token_budget")
        if self.prices is None or min(self.prices) <= 0:
            raise RuntimeErrorCode("planning_pricing_unavailable")
        cost = (
            (reserve - request.max_tokens) * self.prices[0]
            + request.max_tokens * self.prices[1]
            + 999
        ) // 1000
        if (
            cost > self.library.skill(node.skill).cost_reservation_micros
            or self.cost_micros + cost > self.budget.max_cost_micros
        ):
            raise RuntimeErrorCode("planning_spend_budget")
        self.cost_micros += cost
        self.tokens += reserve
        self.start(port, GoalInput(message=message))
        try:
            async with asyncio.timeout(self.operation_timeout()):
                response = await resolve_planned(provider, request, reservation=reserve)
            # Resolution guarantees a structured result; the session checks its
            # journey-specific schema and records completion.
            assert response.structured is not None
            self.finish(response.structured)
            return response
        except BaseException:
            self.fail()
            raise

    def accept_shopping_intent(self, message: str, intent: "ShoppingIntent") -> None:
        """Record a validated language-engine result without calling a model."""
        from app.commerce_action_engine.execution.planning.library import GoalInput

        self.start("reasoning.shopping", GoalInput(message=message))
        try:
            self.finish(intent)
        except BaseException:
            self.fail()
            raise

    def rank(
        self,
        products: list["Product"],
        intent: "ShoppingIntent",
        reference: "Product | None",
    ) -> tuple[list[tuple["Product", list[str]]], list[tuple["Product", list[str]]]]:
        from app.commerce_action_engine.actions.shopping import select

        self.start("local.rank", intent)
        try:
            result = select(products, intent, reference)
            self.finish(LocalReceipt(status="checked"))
            return result
        except BaseException:
            self.fail()
            raise


def start_planning(
    enabled: bool,
    journey: str,
    principal: Principal,
    tools: Mapping[str, object],
    *,
    basket: bool = False,
    tool_limit: int = 8,
    timeout_ms: int = 25000,
    prices: tuple[int, int] | None = None,
    record_planning: Callable[[dict[str, object]], None] | None = None,
) -> PlanningSession | None:
    if not enabled:
        return None
    ports = frozenset("catalog." + name for name in tools) | {
        "reasoning.shopping",
        "reasoning.basket",
        "local.rank",
    }
    if basket:
        ports |= {"basket.context", "basket.quote"}
    try:
        return PlanningSession(
            journey,
            principal,
            ports,
            tool_limit=tool_limit,
            timeout_ms=timeout_ms,
            prices=prices,
            record_planning=record_planning,
        )
    except (OSError, ValidationError, PlanningError):
        # Configuration failure only, before any skill starts. Runtime failures never replay.
        if record_planning is not None:
            record_planning(
                {"path": "legacy", "reason": "planning_library_unavailable"}
            )
        return None


async def planned_read[T](
    journey: str,
    principal: Principal,
    port: str,
    arguments: BaseModel,
    operation: Callable[[], Awaitable[T]],
    project: Callable[[T], BaseModel],
    *,
    context_keys: frozenset[str] = frozenset(),
    record_planning: Callable[[dict[str, object]], None] | None = None,
) -> T:
    try:
        session = PlanningSession(
            journey,
            principal,
            frozenset({port}),
            context_keys=context_keys,
            record_planning=record_planning,
        )
    except (OSError, ValidationError, PlanningError):
        if record_planning is not None:
            record_planning(
                {"path": "legacy", "reason": "planning_library_unavailable"}
            )
        return await operation()
    return await session.perform(port, arguments, operation, project)
