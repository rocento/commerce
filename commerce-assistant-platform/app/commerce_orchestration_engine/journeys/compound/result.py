"""Internal preparation outcome; not a new HTTP or SSE contract."""

from dataclasses import dataclass
from typing import Literal

from app.commerce_contracts.compound_plan import CompoundPlan


@dataclass(frozen=True)
class PreparationResult:
    status: Literal["unsupported", "unavailable", "superseded", "saved"]
    plan: CompoundPlan | None = None

    def __post_init__(self) -> None:
        if (self.status == "saved") != (self.plan is not None):
            raise ValueError(
                "saved preparation requires a plan; other outcomes cannot carry one"
            )
