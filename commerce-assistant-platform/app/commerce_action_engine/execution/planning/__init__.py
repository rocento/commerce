"""Planning library, bounded runtime, commerce guards, and receipts."""

from importlib import import_module
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.commerce_action_engine.execution.planning.execution import (
        ExecutionReceipt,
        verify_receipt,
    )
    from app.commerce_action_engine.execution.planning.library import (
        GoalInput,
        LocalReceipt,
        industry_rules,
        library,
        pinned_prices,
    )
    from app.commerce_action_engine.execution.planning.runtime import (
        PlanningSession,
        planned_read,
        start_planning,
    )

_MODULES = {
    "ExecutionReceipt": "app.commerce_action_engine.execution.planning.execution",
    "verify_receipt": "app.commerce_action_engine.execution.planning.execution",
    "GoalInput": "app.commerce_action_engine.execution.planning.library",
    "LocalReceipt": "app.commerce_action_engine.execution.planning.library",
    "industry_rules": "app.commerce_action_engine.execution.planning.library",
    "library": "app.commerce_action_engine.execution.planning.library",
    "pinned_prices": "app.commerce_action_engine.execution.planning.library",
    "PlanningSession": "app.commerce_action_engine.execution.planning.runtime",
    "planned_read": "app.commerce_action_engine.execution.planning.runtime",
    "start_planning": "app.commerce_action_engine.execution.planning.runtime",
}

__all__ = [
    "ExecutionReceipt",
    "GoalInput",
    "LocalReceipt",
    "PlanningSession",
    "industry_rules",
    "library",
    "pinned_prices",
    "planned_read",
    "start_planning",
    "verify_receipt",
]


def __getattr__(name: str) -> Any:
    module = _MODULES.get(name)
    if module is None:
        raise AttributeError(name)
    value = getattr(import_module(module), name)
    globals()[name] = value
    return value
