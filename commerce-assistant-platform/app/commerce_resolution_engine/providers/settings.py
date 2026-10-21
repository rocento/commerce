"""Deployment-local provider settings. Secrets never appear in public responses."""

import json
import os
import re
import tempfile
from dataclasses import replace
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, SecretStr

from app.commerce_resolution_engine.contracts import ModelError
from app.commerce_resolution_engine.providers.config import (
    ProviderConfig,
    ProviderConfiguration,
)
from app.commerce_resolution_engine.providers.openai import OpenAIProvider


class ProviderInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    enabled: bool
    model: str = Field(
        min_length=1, max_length=100, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$"
    )
    api_key: SecretStr | None = None
    clear_key: bool = False


class StoredSettings(ProviderInput):
    # Null inherits the deployment key; an empty secret explicitly removes it.
    tenant: str


class ProviderStatus(BaseModel):
    enabled: bool
    provider: str = "openai"
    model: str
    key_configured: bool
    source: str
    editable: bool


class ProviderSettings:
    def __init__(self, settings: ProviderConfiguration):
        self.settings = ProviderConfig.from_settings(settings)
        self.path = (
            Path(settings.provider_settings_file)
            if settings.provider_settings_file
            else None
        )

    def read(self) -> StoredSettings | None:
        if self.path is None or not self.path.exists():
            return None
        try:
            value = StoredSettings.model_validate_json(self.path.read_text())
            if value.tenant != self.settings.tenant_id:
                raise ValueError("Tenant mismatch")
            return value
        except (OSError, ValueError):
            raise ModelError("configuration") from None

    def key(self, stored: StoredSettings | None) -> str:
        if stored is not None and stored.api_key is not None:
            return stored.api_key.get_secret_value()
        try:
            return (
                Path(self.settings.model_key_file).read_text().strip()
                if self.settings.model_key_file
                else ""
            )
        except (OSError, UnicodeError):
            return ""

    def status(self) -> ProviderStatus:
        stored = self.read()
        return ProviderStatus(
            enabled=stored.enabled
            if stored
            else self.path is None and self.settings.model_provider == "openai",
            model=stored.model if stored else self.settings.model_name,
            key_configured=bool(self.key(stored)),
            source="admin" if stored else "default" if self.path else "deployment",
            editable=self.path is not None,
        )

    def candidate(self, body: ProviderInput) -> StoredSettings:
        old = self.read()
        supplied = body.api_key.get_secret_value().strip() if body.api_key else ""
        if body.clear_key and supplied:
            raise ValueError("Choose either a replacement key or remove the saved key.")
        if supplied and (
            len(supplied) > 512 or not re.fullmatch(r"[\x21-\x7e]+", supplied)
        ):
            raise ValueError("Enter a valid API key without spaces.")
        key = (
            SecretStr("")
            if body.clear_key
            else SecretStr(supplied)
            if supplied
            else old.api_key
            if old
            else None
        )
        result = StoredSettings(
            enabled=body.enabled,
            model=body.model,
            api_key=key,
            tenant=self.settings.tenant_id,
        )
        if result.enabled and not self.key(result):
            raise ValueError("Add an API key before enabling OpenAI.")
        return result

    def save(self, body: ProviderInput) -> ProviderStatus:
        if self.path is None:
            raise ModelError("configuration")
        value = self.candidate(body)
        # Atomic replace with 0600 permissions; the directory is a private AI volume.
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        document = value.model_dump(exclude={"api_key"})
        document["api_key"] = (
            value.api_key.get_secret_value() if value.api_key is not None else None
        )
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", dir=self.path.parent, delete=False
            ) as file:
                temporary = file.name
                os.chmod(temporary, 0o600)
                json.dump(document, file)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, self.path)
        except OSError:
            raise ModelError("configuration") from None
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)
        return self.status()

    def provider(self, stored: StoredSettings) -> OpenAIProvider | None:
        if not stored.enabled:
            return None
        return OpenAIProvider(
            model=stored.model,
            api_key=self.key(stored),
            timeout=self.settings.model_timeout,
            url=self.settings.model_url,
        )

    def effective(self, stored: StoredSettings) -> ProviderConfig:
        return replace(
            self.settings,
            model_provider="openai" if stored.enabled else "disabled",
            model_name=stored.model,
        )
