"""Versioned offline evaluation contracts. No credentials or customer payloads."""

from typing import Annotated, Any, Literal, Self
from uuid import UUID

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    StrictStr,
    model_validator,
)

from app.commerce_action_engine.actions.catalog import (
    CatalogSchema,
    Identifier,
    Money,
    Product,
)
from app.commerce_action_engine.actions.policy import PolicyAnswers
from app.commerce_action_engine.actions.shopping import ShoppingIntent
from app.commerce_action_engine.actions.shopping.baskets import BasketGoal, BasketPlan

# A store is a scoped identity, not a fixed list of the demos present today.
Store = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9-]{0,79}$")]
Scalar = StrictStr | StrictBool | StrictInt | StrictFloat
Language = Literal["en", "ar", "ar-eg", "mixed", "typo"]
Layer = Literal[
    "understanding",
    "retrieval",
    "ranking",
    "tool",
    "policy",
    "runtime",
    "provider",
    "ui",
]


class Closed(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Snapshot(Closed):
    version: Literal["1"] = "1"
    id: str = Field(pattern=r"^[a-z0-9-]{1,80}$")
    store: Store
    tenant_id: UUID
    source: Literal[
        "reviewed_synthetic_pattern", "isolated_store", "historical_demo_snapshot"
    ]
    source_revision: str = Field(min_length=1, max_length=200)
    observed_at: AwareDatetime
    catalog_schema: CatalogSchema
    # Retrieval remains bounded separately. The oracle needs the complete frozen
    # catalog, including valid offers beyond the first page or first 30 rows.
    products: list[Product] = Field(min_length=1, max_length=50_000)
    catalog_complete: bool = False
    category_memberships: dict[Identifier, list[Identifier]] = Field(
        default_factory=dict, max_length=50_000
    )
    policies: PolicyAnswers = Field(default_factory=PolicyAnswers)

    @model_validator(mode="after")
    def scoped(self) -> Self:
        ids = [p.id for p in self.products]
        if len(ids) != len(set(ids)):
            raise ValueError("Duplicate snapshot product")
        if any(p.route != f"/products/{p.id}" for p in self.products):
            raise ValueError("Product route mismatch")
        if self.policies.answers and self.policies.tenant_id != self.tenant_id:
            raise ValueError("Policy tenant mismatch")
        if not set(self.category_memberships) <= {str(p.id) for p in self.products}:
            raise ValueError("Category membership outside snapshot")
        if any(len(values) > 50 for values in self.category_memberships.values()):
            raise ValueError("Category membership exceeds bound")
        return self


class Predicate(Closed):
    code: str = Field(min_length=1, max_length=100)
    operator: Literal["eq", "neq", "contains", "gte", "gt", "lte", "lt"] = "eq"
    value: Scalar
    trusted_sources: list[Literal["MERCHANT", "VERIFIED", "IMPORTED"]] = Field(
        default_factory=lambda: ["MERCHANT", "VERIFIED", "IMPORTED"],
        min_length=1,
        max_length=3,
    )


class ClarificationExpectation(Closed):
    field: str | None = None
    # Choices are checked against this independently declared candidate scope;
    # the system's returned 5/8 cards never define the expected options.
    scope_predicates: list[Predicate] = Field(default_factory=list, max_length=20)
    required_choices: list[Scalar] = Field(default_factory=list, max_length=50)
    forbidden_choices: list[Scalar] = Field(default_factory=list, max_length=50)
    optional: bool | None = None
    min_choices: int = Field(default=1, ge=0, le=50)


class Expectation(Closed):
    ids: list[Identifier] | None = None
    min_results: int = Field(default=0, ge=0, le=5)
    max_price: Money | None = None
    exclusive_max: bool = False
    currency: str | None = None
    in_stock: bool = False
    attributes: dict[str, str] = Field(default_factory=dict, max_length=10)
    extracted: dict[str, Any] = Field(default_factory=dict, max_length=15)
    text_all: list[str] = Field(default_factory=list, max_length=10)
    text_none: list[str] = Field(default_factory=list, max_length=10)
    locked_products: list[Identifier] | None = None
    unresolved: bool | None = None
    error: str | None = None
    max_calls: int = Field(default=1, ge=0, le=2)
    predicates: list[Predicate] = Field(default_factory=list, max_length=20)
    category_ids: list[Identifier] = Field(default_factory=list, max_length=50)
    excluded_ids: list[Identifier] = Field(default_factory=list, max_length=20)
    min_price: Money | None = None
    exclusive_min: bool = False
    forbid_results: bool = False
    require_eligible: bool = False
    allow_clarification: bool = False
    clarification: ClarificationExpectation | None = None
    preserved_paths: dict[str, Any] = Field(default_factory=dict, max_length=30)


class Turn(Closed):
    message: str = Field(min_length=1, max_length=4000)
    model_output: dict[str, Any] = Field(default_factory=dict)
    expected: Expectation
    language_result: dict[str, Any] | None = None


class CartItem(Closed):
    product_id: Identifier
    name: str
    unit: str
    quantity: int = Field(ge=1)
    price: Money
    currency: str


class Case(Closed):
    id: str = Field(pattern=r"^[a-z0-9-]{1,100}$")
    snapshot: str
    store: Store
    language: Language
    journey: Literal[
        "discovery",
        "comparison",
        "gift",
        "compatibility",
        "meal",
        "shop",
        "optimize",
        "buy_again",
        "policy",
        "order_status",
        "support",
    ]
    kind: Literal["catalog", "basket", "policy"]
    suite: Literal[
        "golden", "catalog_grounded", "conversation", "journey", "adversarial"
    ]
    turns: list[Turn] = Field(min_length=1, max_length=4)
    candidates: list[Identifier] = Field(default_factory=list, max_length=5)
    cart_items: list[CartItem] = Field(default_factory=list, max_length=5)
    previous_goal: BasketGoal | None = None
    provider_fault: (
        Literal["timeout", "rate_limit", "invalid_response", "unauthorized_tool"] | None
    ) = None
    tool_fault: Literal["unavailable", "malformed"] | None = None
    live: bool = False

    @model_validator(mode="after")
    def outputs(self) -> Self:
        if self.kind == "basket" and self.journey not in {
            "shop",
            "optimize",
            "buy_again",
        }:
            raise ValueError("Basket mode required")
        for turn in self.turns:
            if self.kind == "catalog":
                ShoppingIntent.model_validate(turn.model_output)
            elif self.kind == "basket":
                BasketPlan.model_validate(turn.model_output)
        if self.live and (self.provider_fault or self.tool_fault):
            raise ValueError("Fault injection is deterministic only")
        return self


class Dataset(Closed):
    version: Literal["1"] = "1"
    revision: str = Field(min_length=1, max_length=100)
    snapshots: list[Snapshot] = Field(min_length=1, max_length=20)
    cases: list[Case] = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def references(self) -> Self:
        snapshots = {s.id: s for s in self.snapshots}
        if len(snapshots) != len(self.snapshots) or len(
            {c.id for c in self.cases}
        ) != len(self.cases):
            raise ValueError("Duplicate evaluation identity")
        stores: dict[UUID, str] = {}
        for snapshot in self.snapshots:
            if (
                snapshot.tenant_id in stores
                and stores[snapshot.tenant_id] != snapshot.store
            ):
                raise ValueError("Store tenant reused")
            stores[snapshot.tenant_id] = snapshot.store
        for case in self.cases:
            snapshot = snapshots.get(case.snapshot)
            if snapshot is None or snapshot.store != case.store:
                raise ValueError("Cross-store snapshot reference")
            known = {str(p.id) for p in snapshot.products}
            ids = set(case.candidates) | {p.product_id for p in case.cart_items}
            for turn in case.turns:
                ids |= set(turn.expected.ids or []) | set(
                    turn.expected.locked_products or []
                )
                ids |= set(turn.expected.excluded_ids)
            if not ids <= known:
                raise ValueError("Cross-snapshot expected product")
        return self


class Failure(Closed):
    assertion: str
    layer: Layer
    safety: bool = False


class CaseResult(Closed):
    id: str
    store: Store
    language: str
    journey: str
    suite: str
    status: Literal["passed", "failed", "quarantined", "not_run"]
    failures: list[Failure] = Field(default_factory=list)
    latency_ms: int = 0
    provider_calls: int = 0
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_micros: int | None = None
    tool_calls: list[str] = Field(default_factory=list)
    trace: list[dict[str, Any]] = Field(default_factory=list)


class Report(Closed):
    version: Literal["1"] = "1"
    mode: Literal["replay", "live"]
    dataset_revision: str
    dataset_sha256: str
    runtime_sha256: str
    created_at: AwareDatetime
    model: str
    status: Literal["passed", "failed", "incomplete"]
    results: list[CaseResult]
    segments: dict[str, Any]
    live_stores: dict[str, str]
    budget: dict[str, Any] | None = None
    retrieval_revision: str = "dataset-frozen-observations"
    retrieval_sha256: str | None = None
    runtime_features: list[
        Literal[
            "grounded_intent", "commerce_core", "commerce_meaning", "commerce_planning"
        ]
    ] = Field(default_factory=list)
    scope_id: str = "all-languages"
    scope_sha256: str | None = None
    scope_reason: str | None = None
    excluded_cases: dict[str, str] = Field(default_factory=dict)


class EvaluationScope(Closed):
    version: Literal["1"] = "1"
    id: str = Field(pattern=r"^[a-z0-9-]{1,80}$")
    languages: list[Language] = Field(min_length=1, max_length=5)
    reason: str = Field(min_length=1, max_length=1000)


class RetrievalObservations(Closed):
    version: Literal["1"] = "1"
    dataset_sha256: str
    engine_revision: str = Field(min_length=1, max_length=200)
    candidates: dict[str, list[Identifier]] = Field(max_length=2000)


def load_dataset(path):
    if path.stat().st_size > 8_000_000:
        raise ValueError("Dataset exceeds the bounded input size")
    return Dataset.model_validate_json(path.read_bytes())
