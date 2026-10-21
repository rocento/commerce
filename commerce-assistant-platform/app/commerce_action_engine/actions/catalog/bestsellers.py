"""Sales-backed ranking contract; catalog candidates alone cannot prove sales."""

from collections.abc import Mapping
from datetime import datetime
from typing import Literal, Protocol

from pydantic import Field

from app.commerce_action_engine.actions.catalog import DTO, Product

SalesPeriod = Literal["today", "last_week", "last_month", "last_year"]


class Bestsellers(DTO):
    products: list[Product] = Field(max_length=8)
    period: SalesPeriod
    start: datetime
    end: datetime
    timezone: Literal["UTC"]
    metric: Literal["completed_order_units"]
    ranked_limit: Literal[50]
    scope: Literal["delivery_area", "global"] = "global"


class BestsellerReader(Protocol):
    async def bestsellers(self, period: SalesPeriod) -> Bestsellers: ...


def sales_period(entities: Mapping[str, object]) -> SalesPeriod:
    """Select an explicit supported period; defaults belong to interpretation."""
    match entities.get("salesPeriod"):
        case "today":
            return "today"
        case "last_week":
            return "last_week"
        case "last_month":
            return "last_month"
        case "last_year":
            return "last_year"
        case _:
            raise ValueError("A supported sales period is required")
