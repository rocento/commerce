"""Composition root loads data-only procedures and binds existing argument schemas."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from app.commerce_action_engine.actions.catalog import (
    DEFINITIONS,
    DTO,
    CatalogResult,
    Identifier,
)
from app.commerce_action_engine.contracts import (
    AssistantCart,
    AssistantDelivery,
    AssistantOrder,
    AssistantOrderArgs,
)
from app.commerce_action_engine.contracts.action import Contract
from app.commerce_action_engine.execution.core.planning import (
    ExecutableSkill,
    IndustryRules,
    PlanningLibrary,
    Procedure,
)
from app.commerce_contracts.compound_plan import CompoundReceipt
from app.commerce_contracts.compound_write import CompoundDispatch


class GoalInput(DTO):
    message: str = Field(max_length=4000)


class TaskInput(DTO):
    task_id: Identifier


class ProposalReceipt(DTO):
    id: Identifier
    can_apply: bool


class LocalReceipt(DTO):
    status: Literal["checked", "unknown"]


class LibraryDocument(Contract):
    skills: tuple[ExecutableSkill, ...]
    procedures: tuple[Procedure, ...]
    industries: tuple[IndustryRules, ...]


@lru_cache(maxsize=1)
def document() -> LibraryDocument:
    return LibraryDocument.model_validate_json(
        Path(__file__).with_name("planning_library.json").read_bytes()
    )


@lru_cache(maxsize=1)
def library() -> PlanningLibrary:
    # Deferred imports avoid coupling the pure domain to runtime DTOs.
    from app.commerce_action_engine.actions.shopping import BasketPlan, ShoppingIntent

    schemas: dict[str, type[BaseModel]] = {"catalog://result-v1": CatalogResult}
    schemas.update({"catalog://" + d.name + "-v1": d.arguments for d in DEFINITIONS})
    schemas.update(
        {
            "planning://goal-v1": GoalInput,
            "planning://task-v1": TaskInput,
            "planning://receipt-v1": LocalReceipt,
            "shopping://intent-v1": ShoppingIntent,
            "shopping://basket-plan-v1": BasketPlan,
            "shopping://proposal-ref-v1": ProposalReceipt,
            "commerce://cart-v1": AssistantCart,
            "commerce://order-args-v1": AssistantOrderArgs,
            "commerce://order-v1": AssistantOrder,
            "commerce://delivery-v1": AssistantDelivery,
            "commerce://compound-dispatch-v1": CompoundDispatch,
            "commerce://compound-receipt-v1": CompoundReceipt,
        }
    )
    data = document()
    return PlanningLibrary(data.skills, data.procedures, schemas)


def industry_rules(industry: str | None, attributes: tuple[str, ...]) -> IndustryRules:
    """Attributes come from the actual store schema, never the pack's industry name."""
    pack = next(
        (p for p in document().industries if p.id == f"industry://commerce/{industry}"),
        document().industries[0],
    )
    return pack.model_copy(
        update={"attributes": tuple(a for a in attributes if a in pack.attributes)}
    )


def pinned_prices(
    model: object, configured_model: str, input_rate: int, output_rate: int
) -> tuple[int, int] | None:
    """A changed provider model cannot silently inherit another model's spend estimate."""
    if model != configured_model or min(input_rate, output_rate) <= 0:
        return None
    return input_rate, output_rate
