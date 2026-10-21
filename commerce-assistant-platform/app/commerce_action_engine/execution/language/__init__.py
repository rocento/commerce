"""Language interpretation contracts and deterministic routing."""

from importlib import import_module
from typing import Any

_MODULES = {
    "Resolution": "app.commerce_action_engine.execution.language.gate",
    "resolve": "app.commerce_action_engine.execution.language.gate",
    "saved_addresses_requested": "app.commerce_action_engine.execution.language.intents",
    "contains_phrase": "app.commerce_action_engine.execution.language.shopping",
    "english_query": "app.commerce_action_engine.execution.language.shopping",
    "refine_query": "app.commerce_action_engine.execution.language.shopping",
}

__all__ = list(_MODULES)


def __getattr__(name: str) -> Any:
    module = _MODULES.get(name)
    if module is None:
        raise AttributeError(name)
    value = getattr(import_module(module), name)
    globals()[name] = value
    return value
