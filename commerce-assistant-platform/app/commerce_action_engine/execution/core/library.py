"""Versioned descriptions of existing behavior, not a second planner."""

from app.commerce_action_engine.contracts.action import (
    Definition,
    DefinitionRef,
    IndustryPack,
    Journey,
    PlaybookDefinition,
    PolicyDefinition,
    ProviderCapabilities,
    SkillDefinition,
)
from app.commerce_action_engine.execution.core.registry import Registry

JOURNEYS: tuple[Journey, ...] = (
    "discovery",
    "shop",
    "optimize",
    "buy_again",
    "cart",
    "order",
    "general",
)
CORE_CONTRACTS = frozenset(
    {"legacy://assistant/request-v1", "legacy://assistant/result-v1"}
)


def journey_ref(journey: Journey) -> DefinitionRef:
    return DefinitionRef(id=f"playbook://shopping/{journey}", version="1.0.0")


def provider_capabilities(profile: str = "default") -> ProviderCapabilities:
    # Capabilities guaranteed by our existing text adapter, not a claim about every
    # vendor model. Profiles are configured outside the domain core. Vision remains off.
    return ProviderCapabilities(
        id=f"provider://reasoning/{profile}",
        version="1.0.0",
        profile=profile,
        structured_output=True,
        tool_calling=True,
        streaming=True,
        vision=False,
        max_context_tokens=32000,
        usage_reporting=True,
    )


def build_registry() -> Registry:
    policy = PolicyDefinition(
        id="policy://commerce/authority",
        version="1.0.0",
        reason_codes=("rust_authoritative", "approval_separate", "no_execution_replay"),
    )
    industry = IndustryPack(id="industry://commerce/common", version="1.0.0")
    definitions: list[Definition] = [
        policy,
        industry,
        provider_capabilities(),
        provider_capabilities("extraction"),
    ]
    for journey in JOURNEYS:
        skill = SkillDefinition(
            id=f"skill://shopping/{journey}",
            version="1.0.0",
            input_contract="legacy://assistant/request-v1",
            output_contract="legacy://assistant/result-v1",
            # These skills read/prepare proposals. Applying a basket is a distinct
            # Rust-authorized R2 operation and is intentionally not registered here.
            max_calls=2,
        )
        definitions.extend(
            (
                skill,
                PlaybookDefinition(
                    id=journey_ref(journey).id,
                    version="1.0.0",
                    journey=journey,
                    steps=(DefinitionRef(id=skill.id, version=skill.version),),
                    dependencies=(
                        DefinitionRef(id=policy.id, version=policy.version),
                        DefinitionRef(id=industry.id, version=industry.version),
                    ),
                ),
            )
        )
    return Registry(definitions, contracts=CORE_CONTRACTS)
