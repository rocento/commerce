"""Commerce Intelligence Core: pure, provider-independent contracts and ports."""

from app.commerce_action_engine.execution.core.facade import CompatibilityFacade
from app.commerce_action_engine.execution.core.library import (
    CORE_CONTRACTS,
    JOURNEYS,
    build_registry,
    journey_ref,
    provider_capabilities,
)

__all__ = [
    "CORE_CONTRACTS",
    "JOURNEYS",
    "CompatibilityFacade",
    "build_registry",
    "journey_ref",
    "provider_capabilities",
]
