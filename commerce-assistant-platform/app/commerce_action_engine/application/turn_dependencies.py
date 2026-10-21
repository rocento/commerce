"""Prepared turn dependencies and core transcript persistence."""

from collections.abc import Awaitable, Callable
from contextvars import Token
from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID

from app.commerce_action_engine.actions.policy import PolicyAnswers
from app.commerce_action_engine.adapters.commerce import CommerceTools
from app.commerce_action_engine.application.context import TurnContext
from app.commerce_action_engine.application.persistence import TurnPersistence
from app.commerce_action_engine.application.persistence_binding import bind_persistence
from app.commerce_action_engine.application.resources import TurnLease
from app.commerce_action_engine.contracts.action import DecisionTrace
from app.commerce_action_engine.execution.agents import Principal
from app.commerce_action_engine.execution.core import CompatibilityFacade
from app.commerce_action_engine.execution.core.meaning import IntentFrame
from app.commerce_action_engine.platform import Settings
from app.commerce_contracts.intent_example import IntentEvidence
from app.commerce_resolution_engine.admission import (
    ReasoningGateway,
)
from app.commerce_resolution_engine.runtime import AgentRuntime


class TurnStore(Protocol):
    """Core history, transcript and model-budget operations when storage is enabled."""

    async def context(
        self, tenant: UUID, customer: UUID, conversation: UUID
    ) -> list[dict[str, Any]]: ...
    async def save(
        self,
        tenant: UUID,
        customer: UUID,
        conversation: UUID,
        request: UUID,
        question: str,
        answer: str,
        blocks: list[dict[str, Any]] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None: ...
    async def model_budget_available(
        self,
        tenant: UUID,
        conversation: UUID | None,
        daily_limit: int,
        session_limit: int,
    ) -> bool: ...


@dataclass(frozen=True)
class PreparedTurn:
    context: TurnContext
    config: Settings
    active_config: Settings
    caller: Principal
    runtime: AgentRuntime | None
    has_catalog: bool
    provider: ReasoningGateway
    fallback_model_configured: bool
    tracked: dict[str, ReasoningGateway]
    store: TurnStore | None
    core_facade: CompatibilityFacade
    policy_answers: PolicyAnswers
    intent_frame: IntentFrame | None
    address_request: bool
    commerce_tools: Callable[[], CommerceTools]
    begin_memory: Callable[[], Awaitable[Token[Any]]]
    bind_runtime: Callable[[AgentRuntime], AgentRuntime]
    record_trace: Callable[
        [DecisionTrace, str, int, dict[str, object]], Awaitable[None]
    ]
    lease: TurnLease
    retrieve_intent_examples: (
        Callable[[str], Awaitable[tuple[IntentEvidence, ...]]] | None
    ) = None
    persistence: TurnPersistence | None = None
    gateway_trace: str | None = None

    def __post_init__(self) -> None:
        # Direct construction remains supported for isolated application tests.
        # Production preparation supplies an explicit binding in bootstrap.
        if self.persistence is None:
            object.__setattr__(self, "persistence", bind_persistence(self.store))
