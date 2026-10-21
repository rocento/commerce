"""Provider delegation guarded by an injected capability policy."""

from collections.abc import AsyncGenerator
from contextlib import aclosing
from typing import Protocol

from app.commerce_resolution_engine.contracts import (
    ModelEvent,
    ModelProvider,
    ModelRequest,
    ModelResponse,
)


class CapabilityCheck(Protocol):
    def __call__(self, request: ModelRequest, *, streaming: bool) -> None: ...


class ReasoningAdapter:
    def __init__(self, delegate: ModelProvider, check: CapabilityCheck):
        self.delegate, self.check = delegate, check

    async def generate(self, request: ModelRequest) -> ModelResponse:
        self.check(request, streaming=False)
        return await self.delegate.generate(request)

    async def stream(self, request: ModelRequest) -> AsyncGenerator[ModelEvent, None]:
        self.check(request, streaming=True)
        async with aclosing(self.delegate.stream(request)) as events:
            async for event in events:
                yield event

    async def aclose(self) -> None:
        await self.delegate.aclose()
