"""Commerce domains; importing a domain must not initialize the tool registry."""

from importlib import import_module
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.commerce_action_engine.actions.registry import (
        ActionRegistry,
        ActionRegistryError,
        default_registry,
    )

__all__ = ["ActionRegistry", "ActionRegistryError", "default_registry"]


def __getattr__(name: str) -> Any:
    if name not in __all__:
        raise AttributeError(name)
    value = getattr(import_module("app.commerce_action_engine.actions.registry"), name)
    globals()[name] = value
    return value
