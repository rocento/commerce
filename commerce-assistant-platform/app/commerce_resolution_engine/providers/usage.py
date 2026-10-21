"""Per-turn provider accounting; stores no prompts or payloads."""

from collections.abc import AsyncGenerator, Callable
from contextlib import AbstractContextManager, aclosing, nullcontext
from dataclasses import dataclass
from typing import Literal

from app.commerce_resolution_engine.contracts import (
    ModelError,
    ModelEvent,
    ModelProvider,
    ModelRequest,
    ModelResponse,
)

TracePhase = Callable[[Literal["provider"]], AbstractContextManager[object]]


def untraced_phase(_name: Literal["provider"]) -> AbstractContextManager[object]:
    return nullcontext()


def ignore_token() -> None:
    pass


@dataclass
class CallBudget:
    limit: int
    attempts: int = 0

    def reserve(self) -> None:
        if self.attempts >= self.limit:
            raise ModelError("budget_exceeded")
        self.attempts += 1


class UsageProvider:
    """Track provider usage and enforce a bounded number of calls per turn."""

    def __init__(
        self,
        provider: ModelProvider,
        max_calls: int | None = None,
        budget: CallBudget | None = None,
        *,
        trace_phase: TracePhase = untraced_phase,
        on_token: Callable[[], None] = ignore_token,
    ):
        if max_calls is not None and max_calls < 1:
            raise ValueError("max_calls must be positive")
        self.provider = provider
        self.max_calls = max_calls
        self.budget = budget
        self.trace_phase = trace_phase
        self.on_token = on_token
        self.input_tokens = 0
        self.output_tokens = 0
        self.calls = 0
        self.attempts = 0
        self.model = ""

    def reserve_call(self) -> None:
        if self.max_calls is not None and self.attempts >= self.max_calls:
            raise ModelError("budget_exceeded")
        if self.budget:
            self.budget.reserve()
        self.attempts += 1

    def record(self, response: ModelResponse) -> None:
        self.calls += 1
        self.input_tokens += response.usage.input_tokens
        self.output_tokens += response.usage.output_tokens
        self.model = response.model[:100]

    async def generate(self, request: ModelRequest) -> ModelResponse:
        self.reserve_call()
        with self.trace_phase("provider"):
            response = await self.provider.generate(request)
        self.record(response)
        return response

    async def stream(self, request: ModelRequest) -> AsyncGenerator[ModelEvent, None]:
        self.reserve_call()
        with self.trace_phase("provider"):
            async with aclosing(self.provider.stream(request)) as stream:
                async for event in stream:
                    if event.type == "text_delta" and event.text:
                        self.on_token()
                    if event.type == "completed" and event.response:
                        self.record(event.response)
                    yield event

    async def aclose(self) -> None:
        pass  # Shared provider lifecycle belongs to application startup/shutdown.
