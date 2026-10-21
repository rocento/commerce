"""Composition root: configuration selects adapters, application code does not."""

from pathlib import Path

from app.commerce_resolution_engine.contracts import ModelError, ModelProvider
from app.commerce_resolution_engine.providers.config import ProviderConfiguration
from app.commerce_resolution_engine.providers.embeddings import OpenAIEmbeddings
from app.commerce_resolution_engine.providers.openai import OpenAIProvider


def build_provider(settings: ProviderConfiguration) -> ModelProvider | None:
    if settings.model_provider == "disabled":
        return None
    if settings.model_provider != "openai":
        raise ModelError("configuration")
    try:
        key = Path(settings.model_key_file).read_text().strip()
    except (OSError, UnicodeError):
        raise ModelError("configuration") from None
    return OpenAIProvider(
        model=settings.model_name,
        api_key=key,
        timeout=settings.model_timeout,
        url=settings.model_url,
    )


def build_embedder(settings: ProviderConfiguration) -> OpenAIEmbeddings | None:
    if not settings.embedding_model:
        return None
    try:
        key = Path(settings.model_key_file).read_text().strip()
    except (OSError, UnicodeError):
        raise ModelError("configuration") from None
    return OpenAIEmbeddings(
        model=settings.embedding_model,
        api_key=key,
        timeout=settings.model_timeout,
        url=settings.model_url,
    )
