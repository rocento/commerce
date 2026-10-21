"""Durable compound review and outcome identities; never execution permissions."""

from typing import Annotated, Literal
from uuid import UUID, uuid5

from pydantic import Field, model_validator

from app.commerce_contracts.base import Contract

Quantity = Annotated[int, Field(ge=1, le=1_000_000)]
State = Literal[
    "needs_input",
    "ready",
    "running",
    "succeeded",
    "failed",
    "outcome_unknown",
    "not_started",
    "superseded",
]


class CompoundScope(Contract):
    tenant_id: UUID
    customer_id: UUID
    conversation_id: UUID


class ProductChoice(Contract):
    product_id: UUID
    name: str = Field(min_length=1, max_length=1000)
    sku: str = Field(max_length=200)


class ProductBinding(Contract):
    product_id: UUID
    name: str = Field(min_length=1, max_length=1000)
    sku: str = Field(max_length=200)
    observed_at: int = Field(ge=0)
    # Catalog product IDs are the sellable identity exposed by today's facade.
    # There is no independently selectable variant contract in this protocol.
    expires_at: int = Field(ge=0)

    @model_validator(mode="after")
    def freshness(self) -> "ProductBinding":
        if not self.observed_at < self.expires_at <= self.observed_at + 30:
            raise ValueError("invalid_binding_freshness")
        return self


class CompoundReceipt(Contract):
    """Authenticated commerce receipt, not a client or language field.

    The compound adapter validates gateway origin and correlation before the
    store records it. Constructing this value alone never proves an outcome.
    """

    scope: CompoundScope
    revision: UUID
    action_id: UUID
    operation_id: UUID
    receipt_id: UUID
    product_id: UUID
    quantity: Quantity
    destination: Literal["cart", "wishlist"]
    outcome: Literal["succeeded", "failed"]
    observed_at: int = Field(ge=0)


class CompoundAction(Contract):
    id: UUID
    operation_id: UUID
    source_label: str = Field(pattern=r"^request[1-9][0-9]{0,2}$")
    intent: Literal["ADD_TO_CART", "ADD_TO_WISHLIST"]
    destination: Literal["cart", "wishlist"]
    operation: Literal["cart.add", "cart.save_to_wishlist"]
    query: str = Field(min_length=1, max_length=200)
    quantity: Quantity
    unit: Literal["piece", "pieces", "pack", "packs"] | None = None
    customer_after: UUID | None = None
    depends_on: UUID | None = None
    lookup_node: Literal["lookup1", "lookup2"]
    product_node: Literal["product1", "product2"]
    state: State
    binding: ProductBinding | None = None
    choices: tuple[ProductChoice, ...] = Field(default=(), max_length=5)
    reason: (
        Literal[
            "selection_required",
            "not_found",
            "stock_unverified",
            "catalog_unavailable",
            "quantity_not_supported",
            "superseded",
            "dependency_stopped",
            "transport_unknown",
            "execution_stopped",
        ]
        | None
    ) = None
    receipt: CompoundReceipt | None = None

    @model_validator(mode="after")
    def coherent(self) -> "CompoundAction":
        expected = "cart" if self.intent == "ADD_TO_CART" else "wishlist"
        operation = "cart.add" if expected == "cart" else "cart.save_to_wishlist"
        if (
            self.destination != expected
            or self.operation_id != uuid5(self.id, "add:" + expected)
            or self.operation != operation
        ):
            raise ValueError("invalid_operation_binding")
        if (
            self.state in {"ready", "running", "succeeded", "failed", "outcome_unknown"}
            and self.binding is None
        ):
            raise ValueError("missing_product_binding")
        if self.state in {
            "ready",
            "running",
            "succeeded",
            "failed",
            "outcome_unknown",
        } and (
            self.unit is not None
            or self.destination == "wishlist"
            and self.quantity != 1
        ):
            raise ValueError("unsupported_operation_quantity")
        if self.state in {"succeeded", "failed"}:
            if self.receipt is None or self.receipt.outcome != self.state:
                raise ValueError("missing_authoritative_receipt")
        elif self.receipt is not None:
            raise ValueError("unexpected_receipt")
        return self


class CompoundPlan(Contract):
    id: UUID
    scope: CompoundScope
    request_id: UUID
    input_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    revision: UUID
    playbook: Literal[
        "playbook://commerce/compound-review", "playbook://commerce/compound-execute"
    ] = "playbook://commerce/compound-review"
    version: Literal["1.0.0"] = "1.0.0"
    created_at: int = Field(ge=0)
    # Immutable origin marker. Only fresh admitted plans use compound-execute;
    # flags cannot promote a persisted review. Capabilities are checked separately.
    execution_enabled: bool = False
    language_status: Literal["RESOLVED", "NEEDS_CONTEXT", "AMBIGUOUS"]
    interpretation_issues: tuple[Literal["INTERPRETATION_CONFLICT"], ...] = Field(
        default=(), max_length=1
    )
    actions: tuple[CompoundAction, CompoundAction]

    @model_validator(mode="after")
    def coherent(self) -> "CompoundPlan":
        if self.execution_enabled != (
            self.playbook == "playbook://commerce/compound-execute"
        ):
            raise ValueError("invalid_execution_procedure")
        if self.execution_enabled and (
            self.language_status != "RESOLVED" or self.interpretation_issues
        ):
            raise ValueError("unadmitted_execution_plan")
        if self.id != uuid5(self.revision, "compound-plan"):
            raise ValueError("invalid_plan_identity")
        if {a.intent for a in self.actions} != {"ADD_TO_CART", "ADD_TO_WISHLIST"}:
            raise ValueError("unsupported_composition")
        seen: set[UUID] = set()
        for i, action in enumerate(self.actions):
            if (
                action.id != uuid5(self.revision, f"action:{i}")
                or action.source_label != f"request{i + 1}"
            ):
                raise ValueError("invalid_action_identity")
            if (
                action.lookup_node != f"lookup{i + 1}"
                or action.product_node != f"product{i + 1}"
            ):
                raise ValueError("invalid_parent_mapping")
            if action.depends_on != (self.actions[i - 1].id if i else None):
                raise ValueError("serial_dependency_required")
            if action.customer_after is not None and action.customer_after not in seen:
                raise ValueError("invalid_customer_dependency")
            seen.add(action.id)
            receipt = action.receipt
            if receipt and (
                receipt.scope != self.scope
                or receipt.revision != self.revision
                or receipt.action_id != action.id
                or receipt.operation_id != action.operation_id
                or action.binding is None
                or receipt.product_id != action.binding.product_id
                or receipt.quantity != action.quantity
                or receipt.destination != action.destination
                or receipt.observed_at < self.created_at
            ):
                raise ValueError("receipt_correlation_failed")
        return self
