"""Provider-neutral business ports. No URLs, SQL, bearer tokens or vendor payloads."""

from typing import Protocol

from pydantic import Field

from app.commerce_action_engine.contracts.action import (
    ActorContext,
    ConstraintSet,
    Contract,
    DecisionTrace,
    EvidenceRef,
    GoalState,
    Identifier,
    PolicyDecision,
    PolicyInput,
    Text,
)
from app.commerce_resolution_engine.contracts import (
    ModelProvider as ReasoningProvider,
)

__all__ = [
    "CartPort",
    "CatalogPort",
    "CheckoutPort",
    "Clock",
    "CommerceSnapshot",
    "CustomerContextPort",
    "EmbeddingProvider",
    "EventPort",
    "FulfillmentPort",
    "IdProvider",
    "InventoryPort",
    "KnowledgePort",
    "MemoryPort",
    "OrderPort",
    "PolicyPort",
    "PricingPort",
    "ProductFact",
    "ProductSearchPort",
    "PromotionPort",
    "ReasoningProvider",
    "RerankingProvider",
    "SearchQuery",
    "SearchResult",
]


class SearchQuery(Contract):
    text: str = Field(min_length=1, max_length=200)
    constraints: ConstraintSet = ConstraintSet()
    limit: int = Field(default=5, ge=1, le=5)


class ProductFact(Contract):
    product_id: Identifier
    name: Text
    price: str = Field(pattern=r"^\d{1,12}(\.\d{1,6})?$")
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    in_stock: bool | None
    evidence: EvidenceRef


class SearchResult(Contract):
    products: tuple[ProductFact, ...] = Field(default=(), max_length=5)
    exhaustive: bool = False


class CommerceSnapshot(Contract):
    """Reference to authoritative data; future milestones add domain-specific payloads."""

    id: Identifier
    revision: int = Field(ge=0)
    evidence: tuple[EvidenceRef, ...] = Field(default=(), max_length=20)


class EmbeddingProvider(Protocol):
    async def embed(self, texts: list[str]) -> list[list[float]]: ...
    async def aclose(self) -> None: ...


class RerankingProvider(Protocol):
    async def rank(
        self, query: SearchQuery, candidates: SearchResult
    ) -> SearchResult: ...


class ProductSearchPort(Protocol):
    async def search(
        self, context: ActorContext, query: SearchQuery
    ) -> SearchResult: ...


class CatalogPort(Protocol):
    async def product(self, context: ActorContext, product_id: str) -> ProductFact: ...


class InventoryPort(Protocol):
    async def availability(
        self, context: ActorContext, product_id: str
    ) -> ProductFact: ...


class PricingPort(Protocol):
    async def price(self, context: ActorContext, product_id: str) -> ProductFact: ...


class PromotionPort(Protocol):
    async def applicable(
        self, context: ActorContext, cart_id: str
    ) -> CommerceSnapshot: ...


class CartPort(Protocol):
    async def snapshot(self, context: ActorContext) -> CommerceSnapshot: ...


class CheckoutPort(Protocol):
    async def readiness(
        self, context: ActorContext, cart_id: str
    ) -> CommerceSnapshot: ...


class OrderPort(Protocol):
    async def status(
        self, context: ActorContext, order_id: str
    ) -> CommerceSnapshot: ...


class FulfillmentPort(Protocol):
    async def availability(self, context: ActorContext) -> CommerceSnapshot: ...


class CustomerContextPort(Protocol):
    async def context(self, actor: ActorContext) -> tuple[EvidenceRef, ...]: ...


class KnowledgePort(Protocol):
    async def evidence(
        self, context: ActorContext, query: str
    ) -> tuple[EvidenceRef, ...]: ...


class MemoryPort(Protocol):
    async def load(self, context: ActorContext, goal_id: str) -> GoalState | None: ...
    async def save(
        self, context: ActorContext, state: GoalState, expected_revision: int
    ) -> None: ...


class PolicyPort(Protocol):
    def evaluate(self, request: PolicyInput) -> PolicyDecision: ...


class EventPort(Protocol):
    async def record(self, trace: DecisionTrace) -> None: ...


class Clock(Protocol):
    def now(self) -> int: ...


class IdProvider(Protocol):
    def new_id(self) -> str: ...
    def idempotency_key(self, context: ActorContext, operation: str) -> str: ...
