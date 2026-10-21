"""Stage facts for shopping; the coordinator passes each request's plan forward.

The records are frozen boundaries, not deep-immutable domain models. Each stage
owns refinements to its ShoppingIntent and returns the resulting plan explicitly.
"""

from dataclasses import dataclass

from app.commerce_action_engine.actions.catalog import (
    CatalogProfile,
    CatalogResult,
    CatalogSchema,
    Product,
)
from app.commerce_action_engine.actions.shopping.contracts import (
    Constraint,
    ShoppingClarification,
    ShoppingIntent,
)
from app.commerce_action_engine.contracts import AssistantBlock
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.core.meaning import ConstraintFrame
from app.commerce_resolution_engine.contracts import ModelResponse, Usage


@dataclass(frozen=True)
class ShoppingAnswer:
    text: str
    usage: Usage
    model: str
    calls: int
    blocks: tuple[AssistantBlock, ...] = ()
    clarification: str | None = None
    completion_evidence: str | None = None
    pending_shopping: ShoppingClarification | None = None
    shopping_frame: ShoppingIntent | None = None
    shopping_revision: str | None = None
    shopping_profile: CatalogProfile | None = None
    shopping_schema: CatalogSchema | None = None


@dataclass(frozen=True)
class PreparedShopping:
    message: str
    constraint_message: str
    response: ModelResponse
    plan: ShoppingIntent
    gate: InterpretedRequest | None
    interpreted: bool
    required_names: tuple[str, ...]
    revision_changed: bool
    resuming: bool


@dataclass(frozen=True)
class IdentityGrounding:
    plan: ShoppingIntent
    schema: CatalogSchema
    required_constraints: tuple[Constraint, ...]
    reserved_searches: int
    literal_text: str | None


@dataclass(frozen=True)
class GroundedShopping:
    plan: ShoppingIntent
    schema: CatalogSchema
    meaning: ConstraintFrame | None
    filters: dict[str, str | int | float | bool]
    purpose: Constraint | None
    category_fallback: str | None
    reserved_searches: int
    default_currency: str | None = None


@dataclass(frozen=True)
class ReferenceSelection:
    plan: ShoppingIntent
    product: Product | None
    excluded_ids: frozenset[str]


@dataclass(frozen=True)
class RetrievedShopping:
    result: CatalogResult
    groups: tuple[Constraint, ...]
