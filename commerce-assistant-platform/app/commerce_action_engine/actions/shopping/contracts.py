"""Shared shopping-domain value objects."""

from typing import Literal

from pydantic import (
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    StrictStr,
    model_validator,
)

from app.commerce_action_engine.actions.catalog import DTO, Identifier, Money


class Constraint(DTO):
    name: str = Field(min_length=1, max_length=100)
    value: str = Field(min_length=1, max_length=100)
    operator: Literal["eq", "neq", "lt", "lte", "gt", "gte", "contains"] = Field(
        default="eq", exclude_if=lambda v: v == "eq"
    )


class UnresolvedRequirement(DTO):
    """Customer wording that must not accidentally become a product name filter."""

    text: str = Field(min_length=1, max_length=200)
    kind: Literal["preference", "required", "ambiguous"]
    start: int = Field(ge=0)
    end: int = Field(gt=0)

    @model_validator(mode="after")
    def valid_span(self) -> "UnresolvedRequirement":
        if self.end <= self.start:
            raise ValueError("Invalid customer source span")
        return self


class GiftContext(DTO):
    core_text: str = Field(min_length=1, max_length=500)
    occasion: str | None = Field(default=None, max_length=100)
    recipient: str | None = Field(default=None, max_length=100)


class ShoppingRelation(DTO):
    relation: Literal[
        "intended_use",
        "recipient",
        "audience",
        "occasion",
        "color",
        "material",
        "origin_country",
        "destination_country",
        "market_country",
    ]
    value: StrictStr = Field(min_length=1, max_length=200)
    text: StrictStr = Field(min_length=1, max_length=400)
    start: StrictInt = Field(ge=0)
    end: StrictInt = Field(gt=0)
    negated: StrictBool
    conceptId: StrictStr = Field(pattern=r"^[a-z][a-zA-Z0-9_.:-]{0,119}$")
    ruleId: StrictStr = Field(pattern=r"^[a-z][a-zA-Z0-9_.:-]{0,119}$")


class ShoppingContext(DTO):
    version: Literal[1]
    relations: list[ShoppingRelation] = Field(max_length=20)
    sentenceRoles: list["ShoppingSentenceRole"] = Field(
        default_factory=list, max_length=20
    )
    responsePreferences: list["ResponsePreference"] = Field(
        default_factory=list, max_length=8
    )
    # Diagnostic language output only; never a replacement for the source request.
    coreText: StrictStr = Field(min_length=1, max_length=1500)

    @model_validator(mode="after")
    def has_evidence(self) -> "ShoppingContext":
        if not self.relations and not self.sentenceRoles:
            raise ValueError("Shopping context requires source evidence")
        if len(set(self.responsePreferences)) != len(self.responsePreferences):
            raise ValueError("Duplicate response preferences")
        return self


ResponsePreference = Literal[
    "short",
    "explain_fit",
    "tradeoffs",
    "uncertainty",
    "no_assumptions",
    "practical_start",
    "two_options",
    "one_question",
]


class ShoppingSentenceRole(DTO):
    role: Literal["background", "search_prompt", "response_preference"]
    text: StrictStr = Field(min_length=1, max_length=400)
    start: StrictInt = Field(ge=0)
    end: StrictInt = Field(gt=0)
    ruleId: StrictStr = Field(pattern=r"^[a-z][a-zA-Z0-9_.:-]{0,119}$")


class ShoppingIntent(DTO):
    # Server-issued profile choice; fresh model/language extraction cannot admit it.
    domain_profile: str | None = Field(
        default=None,
        pattern=r"^[a-f0-9]{64}:[a-z][a-z0-9_.-]{0,99}$",
        exclude_if=lambda v: v is None,
    )
    gift_context: GiftContext | None = Field(
        default=None, exclude_if=lambda v: v is None
    )
    shopping_context: ShoppingContext | None = Field(
        default=None, exclude_if=lambda v: v is None
    )
    shopping: bool
    presentation: Literal["recommend", "search", "compare", "detail"] = "recommend"
    query: str = Field(default="", max_length=200)
    category: str | None = Field(default=None, max_length=100)
    category_id: Identifier | None = Field(default=None, exclude_if=lambda v: v is None)
    required_product_ids: list[Identifier] = Field(
        default_factory=list, max_length=5, exclude_if=lambda v: not v
    )
    min_price: Money | None = None
    max_price: Money | None = None
    exclusive_min: bool = False
    exclusive_max: bool = False
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    brand: str | None = Field(default=None, max_length=100)
    attributes: list[Constraint] = Field(default_factory=list, max_length=10)
    in_stock: bool = False
    intended_use: str | None = Field(default=None, max_length=100)
    preferences: list[Constraint] = Field(default_factory=list, max_length=5)
    sort_by: Literal["price_asc", "price_desc"] | None = None
    cheaper: bool = False
    alternatives: bool = False
    clarification: str | None = Field(default=None, max_length=2000)
    unresolved_requirements: list[UnresolvedRequirement] = Field(
        default_factory=list, max_length=10, exclude_if=lambda v: not v
    )
    discovery_refined: bool = Field(default=False, exclude_if=lambda v: not v)

    @model_validator(mode="after")
    def range_valid(self) -> "ShoppingIntent":
        from .pricing import empty_price_range

        if empty_price_range(self):
            raise ValueError("Invalid budget")
        if self.exclusive_min and self.min_price is None:
            raise ValueError("Exclusive minimum requires a minimum price")
        return self


class ShoppingChoice(DTO):
    label: str = Field(min_length=1, max_length=120)
    value: StrictStr | StrictBool | StrictInt | StrictFloat
    operator: Literal["eq", "lt", "lte", "gt", "gte"] = "eq"
    field: str | None = Field(default=None, min_length=1, max_length=64)


class ShoppingClarification(DTO):
    question: str = Field(min_length=1, max_length=1000)
    field: str = Field(min_length=1, max_length=64)
    choices: list[ShoppingChoice] = Field(default_factory=list, max_length=8)
    frame: ShoppingIntent
    descriptor_revision: str = Field(min_length=1, max_length=200)
    optional: bool = True
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    # Server-owned source spans resolved by an attribute-disambiguation choice.
    resolves: list[UnresolvedRequirement] = Field(default_factory=list, max_length=10)


__all__ = [
    "Constraint",
    "ShoppingChoice",
    "ShoppingClarification",
    "ShoppingIntent",
    "UnresolvedRequirement",
]
