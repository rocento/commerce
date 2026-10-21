"""Immutable agent policies and verified-principal values shared across engines.

These values describe constraints; they never authenticate callers or grant capabilities.
"""

from typing import Literal, Protocol
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

Persona = Literal["shopper", "merchant"]


class DomainModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ModelConfig(DomainModel):
    profile: str = Field(min_length=1, max_length=100)
    max_tokens: int = Field(default=1024, ge=1, le=16384)


class ToolPolicy(DomainModel):
    allowed: frozenset[str] = frozenset()


class KnowledgePolicy(DomainModel):
    sources: frozenset[str] = frozenset()
    max_documents: int = Field(default=4, ge=0, le=16)
    max_characters: int = Field(default=8000, ge=0, le=32000)


class SafetyPolicy(DomainModel):
    max_iterations: int = Field(default=4, ge=1, le=8)
    max_tool_calls: int = Field(default=4, ge=0, le=16)
    timeout_seconds: float = Field(default=20, gt=0, le=120, allow_inf_nan=False)
    max_input_characters: int = Field(default=4000, ge=1, le=16000)
    max_context_characters: int = Field(default=32000, ge=1, le=64000)
    max_output_characters: int = Field(default=8000, ge=1, le=16000)
    max_tool_result_characters: int = Field(default=8000, ge=1, le=16000)


class Agent(DomainModel):
    id: str = Field(min_length=1, max_length=100)
    tenant: UUID
    persona: Persona
    status: Literal["active", "disabled"] = "active"
    instructions: str = Field(default="", max_length=8000)
    merchant_instructions: str = Field(default="", max_length=8000)
    model: ModelConfig
    tools: ToolPolicy = ToolPolicy()
    knowledge: KnowledgePolicy = KnowledgePolicy()
    safety: SafetyPolicy = SafetyPolicy()


class Principal(DomainModel):
    """Construct only from verified server identity, never from chat JSON/model output."""

    tenant: UUID
    persona: Persona
    subject: UUID | None = None
    permissions: frozenset[str] = frozenset()

    @model_validator(mode="after")
    def authenticated_merchant(self) -> "Principal":
        if self.persona == "merchant" and self.subject is None:
            raise ValueError("Merchant identity required")
        return self


class AgentReader(Protocol):
    """Read an agent policy scoped to the authenticated tenant."""

    def load(self, tenant: UUID, agent_id: str) -> Agent | None: ...
