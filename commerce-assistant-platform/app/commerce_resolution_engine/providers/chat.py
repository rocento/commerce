"""Provider-neutral chat boundaries. Disabled mode never fabricates store facts."""

from collections.abc import AsyncGenerator, Sequence
from typing import Protocol

from app.commerce_resolution_engine.contracts import (
    ModelEvent,
    ModelRequest,
    ModelResponse,
    Usage,
)

__all__ = ["EmbeddingModel", "UnconfiguredModel"]


class EmbeddingModel(Protocol):
    async def embed(self, texts: Sequence[str]) -> list[list[float]]: ...


class UnconfiguredModel:
    async def generate(self, request: ModelRequest) -> ModelResponse:
        return ModelResponse(
            "I don't have verified information to answer that. Please open a support ticket so our team can help.",
            (),
            None,
            Usage(0, 0, 0),
            "unconfigured",
            "stop",
        )

    async def stream(self, request: ModelRequest) -> AsyncGenerator[ModelEvent, None]:
        response = await self.generate(request)
        yield ModelEvent("text_delta", text=response.text)
        yield ModelEvent("completed", response=response)

    async def aclose(self) -> None:
        pass
