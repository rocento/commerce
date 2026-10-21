"""Select before execution. Never replay a failed/partial execution through legacy."""

from app.commerce_action_engine.contracts.action import (
    ActorContext,
    DecisionTrace,
    DefinitionRef,
    Journey,
    ModelRequirements,
    ProviderCapabilities,
)
from app.commerce_action_engine.contracts.ports import Clock
from app.commerce_action_engine.execution.core.library import JOURNEYS, journey_ref
from app.commerce_action_engine.execution.core.registry import (
    Registry,
    RegistryError,
    reference,
    select_model,
)


class CompatibilityFacade:
    def __init__(
        self,
        registry: Registry,
        clock: Clock,
        *,
        enabled: bool = False,
        journeys: frozenset[str] = frozenset(JOURNEYS),
    ):
        if journeys - set(JOURNEYS):
            raise ValueError("Unknown core journey")
        self.registry, self.clock = registry, clock
        self.enabled, self.journeys = enabled, journeys

    def select(
        self,
        context: ActorContext,
        journey: Journey,
        *,
        provider_available: bool = True,
        deterministic: bool = False,
        profiles: tuple[str, ...] = ("default",),
    ) -> DecisionTrace:
        base = {
            "request_id": context.request_id,
            "tenant_id": context.tenant_id,
            "store_id": context.store_id,
            "journey": journey,
        }
        versions: tuple[DefinitionRef, ...] = ()
        deprecated: tuple[DefinitionRef, ...] = ()
        try:
            resolved = list(
                self.registry.resolve(
                    journey_ref(journey), context, now=self.clock.now()
                )
            )
            if not deterministic:
                for profile in profiles:
                    provider = self.registry.resolve(
                        DefinitionRef(
                            id=f"provider://reasoning/{profile}", version="1.0.0"
                        ),
                        context,
                        now=self.clock.now(),
                    )
                    if not all(isinstance(d, ProviderCapabilities) for d in provider):
                        raise RegistryError("invalid_provider_definition")
                    select_model(
                        tuple(
                            d for d in provider if isinstance(d, ProviderCapabilities)
                        ),
                        ModelRequirements(
                            structured_output=True,
                            streaming=journey in {"discovery", "general"},
                            tool_calling=journey in {"discovery", "general"},
                        ),
                        configured=frozenset(profiles),
                    )
                    resolved.extend(provider)
            versions = tuple(reference(d) for d in resolved)
            deprecated = tuple(
                reference(d)
                for d in resolved
                if d.deprecated_after is not None
                and self.clock.now() >= d.deprecated_after
            )
            ready = True
        except RegistryError:
            ready = False
        if deterministic:
            path, reason = "deterministic", "existing_deterministic"
        elif not provider_available:
            path, reason = "deterministic", "provider_unavailable"
        elif not self.enabled:
            path, reason = "legacy", "flag_off"
        elif journey not in self.journeys:
            path, reason = "legacy", "journey_disabled"
        elif not ready:
            path, reason = "legacy", "core_unavailable"
        else:
            path, reason = "core", "core_selected"
        return DecisionTrace.model_validate(
            {
                **base,
                "path": path,
                "reason": reason,
                "versions": versions,
                "deprecated": deprecated,
            }
        )
