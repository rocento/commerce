"""Opt-in real-provider acceptance: python -m app.commerce_resolution_engine.providers.smoke.

Uses configured server-side credentials and sends only synthetic prompts.
"""

import asyncio
from contextlib import aclosing

from pydantic import BaseModel, ConfigDict

from app.commerce_resolution_engine.contracts import (
    Message,
    ModelError,
    ModelProvider,
    ModelRequest,
    ToolDefinition,
)
from app.commerce_resolution_engine.providers.config import ProviderConfiguration
from app.commerce_resolution_engine.providers.factory import build_provider
from app.commerce_resolution_engine.providers.settings import ProviderSettings


class Check(BaseModel):
    model_config = ConfigDict(extra="forbid")
    value: str


def configured_provider(settings: ProviderConfiguration) -> ModelProvider | None:
    """Use exactly the same settings precedence as live chat; never test a stale fallback key."""
    managed = ProviderSettings(settings)
    if managed.path is not None:
        stored = managed.read()
        return managed.provider(stored) if stored is not None else None
    return build_provider(settings)


async def check_provider(provider: ModelProvider) -> None:
    try:
        response = await provider.generate(
            ModelRequest((Message("user", "Reply with OK."),))
        )
        assert response.text
        print("PASS generate; usage:", response.usage)
        async with aclosing(
            provider.stream(ModelRequest((Message("user", "Reply with OK."),)))
        ) as events:
            completed = False
            async for event in events:
                completed |= event.type == "completed"
            assert completed
        print("PASS stream")
        structured = await provider.generate(
            ModelRequest(
                (Message("user", "Return value OK in the required JSON object."),),
                output_schema=Check,
            )
        )
        assert structured.structured == Check(value="OK")
        print("PASS structured output")
        tool = await provider.generate(
            ModelRequest(
                (
                    Message(
                        "user",
                        "Call report_check with value OK. Do not answer in prose.",
                    ),
                ),
                tools=(
                    ToolDefinition(
                        "report_check", "Report a synthetic test value", Check
                    ),
                ),
            )
        )
        assert tool.tool_calls and tool.tool_calls[0].arguments == {"value": "OK"}
        print("PASS tool calling (no tool executed)")
    finally:
        await provider.aclose()


async def main() -> None:
    # Keep the operational command while deferring deployment setup to composition.
    from app.commerce_action_engine.application.provider_smoke import main as run

    await run()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except ModelError as error:
        raise SystemExit(str(error)) from None
