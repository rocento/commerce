"""Standard provider text streaming and fixed connection probes."""

from collections.abc import AsyncGenerator
from contextlib import aclosing

from app.commerce_resolution_engine.contracts import (
    Message,
    ModelProvider,
    ModelRequest,
)


async def verify_connection(provider: ModelProvider) -> None:
    try:
        await provider.generate(
            ModelRequest((Message("user", "Reply with OK."),), max_tokens=256)
        )
    finally:
        await provider.aclose()


async def stream_chat(
    provider: ModelProvider, *, question: str, max_tokens: int
) -> AsyncGenerator[str, None]:
    async with aclosing(
        provider.stream(
            ModelRequest((Message("user", question),), max_tokens=max_tokens)
        )
    ) as chunks:
        async for event in chunks:
            if event.type == "text_delta":
                yield event.text
