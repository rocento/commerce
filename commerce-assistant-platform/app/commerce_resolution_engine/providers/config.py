"""Provider-only configuration; deployment environment loading belongs to the application."""

from dataclasses import dataclass
from typing import Protocol


class ProviderConfiguration(Protocol):
    """Read-only input shape also satisfied by legacy deployment Settings."""

    @property
    def tenant_id(self) -> str: ...

    @property
    def model_provider(self) -> str: ...

    @property
    def model_name(self) -> str: ...

    @property
    def model_key_file(self) -> str: ...

    @property
    def model_timeout(self) -> float: ...

    @property
    def model_url(self) -> str: ...

    @property
    def embedding_model(self) -> str: ...

    @property
    def provider_settings_file(self) -> str: ...


@dataclass(frozen=True)
class ProviderConfig:
    """Snapshot of provider inputs, without commerce credentials or turn policy."""

    tenant_id: str
    model_provider: str
    model_name: str
    model_key_file: str
    model_timeout: float
    model_url: str
    embedding_model: str
    provider_settings_file: str

    @classmethod
    def from_settings(cls, settings: ProviderConfiguration) -> "ProviderConfig":
        return cls(
            tenant_id=settings.tenant_id,
            model_provider=settings.model_provider,
            model_name=settings.model_name,
            model_key_file=settings.model_key_file,
            model_timeout=settings.model_timeout,
            model_url=settings.model_url,
            embedding_model=settings.embedding_model,
            provider_settings_file=settings.provider_settings_file,
        )
