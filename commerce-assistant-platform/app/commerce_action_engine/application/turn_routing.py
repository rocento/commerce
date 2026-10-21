"""Select and bind a verified execution path before journey side effects."""

from app.commerce_action_engine.application.turn_dependencies import PreparedTurn
from app.commerce_action_engine.contracts.action import DecisionTrace, Journey
from app.commerce_action_engine.execution.core.registry import RegistryError
from app.commerce_action_engine.platform import TurnTrace
from app.commerce_resolution_engine.admission import ReasoningGateway
from app.commerce_resolution_engine.contracts import ModelProvider
from app.commerce_resolution_engine.diagnostics import debug_record, traced


class TurnRouting:
    def __init__(
        self, prepared: PreparedTurn, trace: TurnTrace, metadata: dict[str, object]
    ):
        self.prepared = prepared
        self.trace = trace
        self._metadata = metadata
        self.runtime = prepared.runtime
        self.decision_trace: DecisionTrace | None = None

    @property
    def metadata(self) -> dict[str, object]:
        """Borrow the turn-owned record without replacing it."""
        return self._metadata

    def language_provider(self, model: ReasoningGateway) -> ModelProvider:
        """Bind the general route before choosing its language proposal provider."""
        self.select("general")
        return (
            self.runtime.providers.get("extraction")
            or self.runtime.providers.get("default")
            or model
            if self.runtime
            else model
        )

    @traced
    def select(self, journey: Journey, *, deterministic: bool = False) -> None:
        decision = self.prepared.core_facade.select(
            self.prepared.context.actor,
            journey,
            provider_available=self.runtime is not None,
            deterministic=deterministic,
            profiles=tuple(self.prepared.tracked) or ("default",),
        )
        if decision.path == "core" and self.runtime is not None:
            try:
                self.runtime = self.prepared.bind_runtime(self.runtime)
            except RegistryError:
                # Only preparation can fall back. Execution failures never retry
                # through the legacy path.
                decision = decision.model_copy(
                    update={"path": "legacy", "reason": "core_unavailable"}
                )
        self.metadata["core"] = decision.model_dump(mode="json")
        self.trace.core = decision.model_dump(mode="json")
        self.decision_trace = decision
        debug_record("execution_route", decision.model_dump(mode="json"))
