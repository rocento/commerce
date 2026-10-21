"""Action-owned agent catalog/default policies; shared value types are re-exported."""

from uuid import UUID

from app.commerce_contracts.agents import (
    Agent,
    DomainModel,
    KnowledgePolicy,
    ModelConfig,
    Persona,
    Principal,
    SafetyPolicy,
    ToolPolicy,
)

__all__ = [
    "DEFAULT_SHOPPER_TOOLS",
    "Agent",
    "AgentCatalog",
    "DomainModel",
    "KnowledgePolicy",
    "ModelConfig",
    "Persona",
    "Principal",
    "SafetyPolicy",
    "ToolPolicy",
    "default_agents",
]

DEFAULT_SHOPPER_TOOLS = frozenset(
    {
        "compare_products",
        "get_catalog_schema",
        "get_category",
        "get_product",
        "get_product_attributes",
        "get_product_inventory",
        "get_product_price",
        "search_products",
    }
)


class AgentCatalog:
    def __init__(self, agents: tuple[Agent, ...]):
        self._agents = {(agent.tenant, agent.id): agent for agent in agents}
        if len(self._agents) != len(agents):
            raise ValueError("Duplicate agent identity")

    def load(self, tenant: UUID, agent_id: str) -> Agent | None:
        return self._agents.get((tenant, agent_id))


def default_agents(
    tenant: UUID, collections: frozenset[str] = frozenset()
) -> AgentCatalog:
    personas: tuple[Persona, ...] = ("shopper", "merchant")
    return AgentCatalog(
        tuple(
            Agent(
                id=persona,
                tenant=tenant,
                persona=persona,
                instructions=f"You are the {persona} assistant. Answer within your allowed capabilities.",
                model=ModelConfig(profile="default"),
                knowledge=KnowledgePolicy(sources=collections),
                # Five products with managed attributes and provenance can exceed
                # the generic 8k tool limit. Keep the existing 16k policy ceiling.
                safety=SafetyPolicy(
                    max_tool_result_characters=16000 if persona == "shopper" else 8000
                ),
                tools=ToolPolicy(
                    allowed=DEFAULT_SHOPPER_TOOLS
                    if persona == "shopper"
                    else frozenset()
                ),
            )
            for persona in personas
        )
    )
