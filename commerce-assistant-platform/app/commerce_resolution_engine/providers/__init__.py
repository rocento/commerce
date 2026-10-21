"""Lazy provider exports keep transport imports independent of application setup."""

from importlib import import_module
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.commerce_resolution_engine.providers.chat import (
        EmbeddingModel,
        UnconfiguredModel,
    )
    from app.commerce_resolution_engine.providers.config import ProviderConfig
    from app.commerce_resolution_engine.providers.factory import (
        build_embedder,
        build_provider,
    )
    from app.commerce_resolution_engine.providers.openai import (
        OpenAIProvider,
        strict_schema,
    )
    from app.commerce_resolution_engine.providers.settings import (
        ProviderInput,
        ProviderSettings,
        ProviderStatus,
        StoredSettings,
    )
    from app.commerce_resolution_engine.providers.usage import CallBudget, UsageProvider


__all__ = [
    "CallBudget",
    "EmbeddingModel",
    "OpenAIProvider",
    "ProviderConfig",
    "ProviderInput",
    "ProviderSettings",
    "ProviderStatus",
    "StoredSettings",
    "UnconfiguredModel",
    "UsageProvider",
    "build_embedder",
    "build_provider",
    "strict_schema",
]

_EXPORTS = {
    "EmbeddingModel": "chat",
    "UnconfiguredModel": "chat",
    "build_embedder": "factory",
    "build_provider": "factory",
    "OpenAIProvider": "openai",
    "strict_schema": "openai",
    "ProviderConfig": "config",
    "ProviderInput": "settings",
    "ProviderSettings": "settings",
    "ProviderStatus": "settings",
    "StoredSettings": "settings",
    "CallBudget": "usage",
    "UsageProvider": "usage",
}


def __getattr__(name: str) -> Any:
    module = _EXPORTS.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(f"{__name__}.{module}"), name)
    globals()[name] = value
    return value
