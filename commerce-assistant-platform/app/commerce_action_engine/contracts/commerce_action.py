"""Contracts that describe existing commerce actions without executing them."""

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import Field, model_validator

from app.commerce_action_engine.contracts.action import (
    ActorContext,
    Code,
    Confirmation,
    Contract,
    SkillInput,
    SkillResult,
    TypedFailure,
    Version,
)

# Existing versioned contracts remain the execution envelopes. These public aliases
# give the Commerce Action Engine vocabulary one owner without changing the wire shape.
ActionContext = ActorContext
ActionRequest = SkillInput
ActionResult = SkillResult
ActionError = TypedFailure


class ActionClassification(StrEnum):
    READ = "read"
    WRITE = "write"


ActionDomain = Literal[
    "basket",
    "cart",
    "catalog",
    "customer",
    "order",
    "policy",
    "shopping",
    "support",
]


class CommerceActionDefinition(Contract):
    """Versioned metadata for one existing action implementation."""

    name: Code
    version: Version = "1.0.0"
    domain: ActionDomain
    classification: ActionClassification
    input_contract: Code
    output_contract: Code
    implementation: str = Field(
        min_length=3,
        max_length=250,
        pattern=r"^app\.commerce_action_engine\.[a-z0-9_.]+:[A-Za-z_][A-Za-z0-9_.]*$",
    )
    intents: tuple[Annotated[str, Field(pattern=r"^[A-Z][A-Z0-9_]{0,99}$")], ...] = (
        Field(default=(), max_length=16)
    )
    confirmation: Confirmation = Confirmation.NONE
    replay: Literal["safe", "never"] = "safe"
    requires_capability: bool = True

    @model_validator(mode="after")
    def safe_metadata(self) -> "CommerceActionDefinition":
        if len(set(self.intents)) != len(self.intents):
            raise ValueError("Duplicate action intent")
        if self.classification is ActionClassification.WRITE:
            if self.confirmation is Confirmation.NONE or self.replay != "never":
                raise ValueError("Writes require confirmation and cannot be replayed")
        elif self.confirmation is not Confirmation.NONE or self.replay != "safe":
            raise ValueError("Read metadata cannot imply mutation controls")
        return self


__all__ = [
    "ActionClassification",
    "ActionContext",
    "ActionError",
    "ActionRequest",
    "ActionResult",
    "CommerceActionDefinition",
]
