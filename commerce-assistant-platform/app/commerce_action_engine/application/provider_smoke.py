"""Deployment composition for the opt-in provider smoke command."""

from app.commerce_action_engine.platform import Settings
from app.commerce_resolution_engine.contracts import ModelError
from app.commerce_resolution_engine.providers import ProviderConfig
from app.commerce_resolution_engine.providers.smoke import (
    check_provider,
    configured_provider,
)


async def main() -> None:
    provider = configured_provider(ProviderConfig.from_settings(Settings.environment()))
    if provider is None:
        raise ModelError("configuration")
    await check_provider(provider)
