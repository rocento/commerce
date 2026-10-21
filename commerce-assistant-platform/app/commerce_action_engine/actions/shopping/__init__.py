"""Lazy public exports for shopping domain contracts and rules."""

from importlib import import_module
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.commerce_action_engine.actions.shopping.baskets import (
        INSTRUCTIONS as BASKET_INSTRUCTIONS,
    )
    from app.commerce_action_engine.actions.shopping.baskets import (
        BasketGoal,
        BasketPlan,
        ProductLockEvidence,
        QuantityEdit,
        SearchLine,
        preserve_product_locks,
    )
    from app.commerce_action_engine.actions.shopping.constraints import (
        matches_attribute,
        mismatches,
        normalized,
        preserve_schema_constraints,
        schema_value,
        structured_filters,
        values,
    )
    from app.commerce_action_engine.actions.shopping.contracts import (
        Constraint,
        ShoppingIntent,
    )
    from app.commerce_action_engine.actions.shopping.selection import (
        select,
    )

_EXPORTS = {
    "BASKET_INSTRUCTIONS": (
        "app.commerce_action_engine.actions.shopping.baskets",
        "INSTRUCTIONS",
    ),
    "BasketGoal": ("app.commerce_action_engine.actions.shopping.baskets", "BasketGoal"),
    "BasketPlan": ("app.commerce_action_engine.actions.shopping.baskets", "BasketPlan"),
    "ProductLockEvidence": (
        "app.commerce_action_engine.actions.shopping.baskets",
        "ProductLockEvidence",
    ),
    "QuantityEdit": (
        "app.commerce_action_engine.actions.shopping.baskets",
        "QuantityEdit",
    ),
    "SearchLine": ("app.commerce_action_engine.actions.shopping.baskets", "SearchLine"),
    "preserve_product_locks": (
        "app.commerce_action_engine.actions.shopping.baskets",
        "preserve_product_locks",
    ),
    "Constraint": (
        "app.commerce_action_engine.actions.shopping.contracts",
        "Constraint",
    ),
    "ShoppingIntent": (
        "app.commerce_action_engine.actions.shopping.contracts",
        "ShoppingIntent",
    ),
    "matches_attribute": (
        "app.commerce_action_engine.actions.shopping.constraints",
        "matches_attribute",
    ),
    "mismatches": (
        "app.commerce_action_engine.actions.shopping.constraints",
        "mismatches",
    ),
    "normalized": (
        "app.commerce_action_engine.actions.shopping.constraints",
        "normalized",
    ),
    "preserve_schema_constraints": (
        "app.commerce_action_engine.actions.shopping.constraints",
        "preserve_schema_constraints",
    ),
    "schema_value": (
        "app.commerce_action_engine.actions.shopping.constraints",
        "schema_value",
    ),
    "select": ("app.commerce_action_engine.actions.shopping.selection", "select"),
    "structured_filters": (
        "app.commerce_action_engine.actions.shopping.constraints",
        "structured_filters",
    ),
    "values": ("app.commerce_action_engine.actions.shopping.constraints", "values"),
}

__all__ = [
    "BASKET_INSTRUCTIONS",
    "BasketGoal",
    "BasketPlan",
    "Constraint",
    "ProductLockEvidence",
    "QuantityEdit",
    "SearchLine",
    "ShoppingIntent",
    "matches_attribute",
    "mismatches",
    "normalized",
    "preserve_product_locks",
    "preserve_schema_constraints",
    "schema_value",
    "select",
    "structured_filters",
    "values",
]


def __getattr__(name: str) -> Any:
    target = _EXPORTS.get(name)
    if target is None:
        raise AttributeError(name)
    module, member = target
    value = getattr(import_module(module), member)
    globals()[name] = value
    return value
