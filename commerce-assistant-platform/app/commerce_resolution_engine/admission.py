"""UNKNOWN-only model admission for customer chat turns."""

from collections.abc import AsyncGenerator
from contextlib import aclosing
from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from app.commerce_resolution_engine.contracts import (
    ModelEvent,
    ModelRequest,
    ModelResponse,
)
from app.commerce_resolution_engine.providers import UsageProvider


@dataclass(frozen=True)
class FallbackPermit:
    """Internal per-turn permit. Never deserialize this from a client or model."""

    request_id: UUID
    status: str
    reason: str = "language_engine_unknown"


_active_permit: ContextVar[FallbackPermit | None] = ContextVar(
    "reasoning_fallback_permit", default=None
)


def issue_unknown_permit(status: str, request_id: UUID) -> FallbackPermit | None:
    if status != "UNKNOWN":
        return None
    return FallbackPermit(request_id=request_id, status="UNKNOWN")


def install_permit(permit: FallbackPermit | None) -> Token[FallbackPermit | None]:
    return _active_permit.set(permit)


def reset_permit(token: Token[FallbackPermit | None]) -> None:
    _active_permit.reset(token)


def require_permit(request_id: UUID) -> FallbackPermit:
    permit = _active_permit.get()
    if permit is None or permit.status != "UNKNOWN" or permit.request_id != request_id:
        raise PermissionError(
            "Model call requires an explicit UNKNOWN permit for this turn"
        )
    return permit


class ReasoningGateway:
    """Sole customer-chat boundary to structured provider generate/stream methods."""

    def __init__(self, provider: UsageProvider, request_id: UUID):
        self._provider = provider
        self._request_id = request_id

    @property
    def calls(self) -> int:
        return self._provider.calls

    @property
    def attempts(self) -> int:
        return self._provider.attempts

    @property
    def input_tokens(self) -> int:
        return self._provider.input_tokens

    @property
    def output_tokens(self) -> int:
        return self._provider.output_tokens

    @property
    def model(self) -> str:
        return self._provider.model

    @property
    def configured_model(self) -> str | None:
        model = getattr(self._provider.provider, "model", None)
        return model if isinstance(model, str) else None

    @property
    def budget(self) -> Any:
        return getattr(self._provider, "budget", None)

    @budget.setter
    def budget(self, value: Any) -> None:
        setattr(self._provider, "budget", value)  # noqa: B010 -- wrapped usage provider

    @property
    def max_calls(self) -> Any:
        return getattr(self._provider, "max_calls", None)

    @max_calls.setter
    def max_calls(self, value: Any) -> None:
        setattr(self._provider, "max_calls", value)  # noqa: B010 -- wrapped usage provider

    async def generate(self, request: ModelRequest) -> ModelResponse:
        require_permit(self._request_id)
        return await self._provider.generate(request)

    def stream(self, request: ModelRequest) -> AsyncGenerator[ModelEvent, None]:
        async def guarded() -> AsyncGenerator[ModelEvent, None]:
            require_permit(self._request_id)
            async with aclosing(self._provider.stream(request)) as stream:
                async for event in stream:
                    yield event

        return guarded()

    async def aclose(self) -> None:
        await self._provider.aclose()
