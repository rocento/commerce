"""Verified single-unit catalog promotion results, separate from ordinary prices."""

from decimal import Decimal
from typing import Literal, Protocol
from uuid import UUID

from pydantic import Field, model_validator

from app.commerce_action_engine.actions.catalog import DTO, Product


class Offer(DTO):
    product_id: UUID
    currency: str = Field(min_length=3, max_length=3)
    original_price: Decimal = Field(gt=0, allow_inf_nan=False)
    discounted_price: Decimal = Field(ge=0, allow_inf_nan=False)
    savings: Decimal = Field(gt=0, allow_inf_nan=False)
    discount_percent: Decimal = Field(gt=0, le=100, allow_inf_nan=False)


class DiscountProduct(DTO):
    product: Product
    offer: Offer

    @model_validator(mode="after")
    def consistent(self) -> "DiscountProduct":
        o = self.offer
        if (
            self.product.id != o.product_id
            or self.product.currency != o.currency
            or Decimal(self.product.price) != o.original_price
            or o.original_price - o.savings != o.discounted_price
            or abs(o.savings / o.original_price * 100 - o.discount_percent)
            > Decimal("0.000001")
        ):
            raise ValueError("Inconsistent promotion evidence")
        return self


class DiscountRecommendations(DTO):
    offers: list[DiscountProduct] = Field(max_length=8)
    candidate_limit: Literal[50] | None
    scope: Literal["all_eligible_catalog_products"] | None = None
    metric: Literal["catalog_discount_percent"]
    quantity: Literal[1]

    @model_validator(mode="after")
    def complete_scope(self) -> "DiscountRecommendations":
        if (self.candidate_limit is None) != (
            self.scope == "all_eligible_catalog_products"
        ):
            raise ValueError("Discount search scope must agree with its limit")
        return self


class DiscountReader(Protocol):
    async def discounts(self) -> DiscountRecommendations: ...
