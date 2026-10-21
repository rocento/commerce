"""Opt-in transport-attempt evidence. No credentials, locals, or exception text."""

import asyncio
import hashlib
import json
import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass

from app.commerce_resolution_engine.contracts import ModelResponse
from app.commerce_resolution_engine.diagnostics import (
    _record,
    begin_span,
    capture_enabled,
    capture_offset,
    end_span,
    record_provider_dispatch,
    record_provider_usage,
)


@dataclass
class ProviderCapture:
    attempt_id: str
    started: float | None = None
    response: ModelResponse | None = None
    prompt_fingerprint: str | None = None

    def complete(self, response: ModelResponse) -> None:
        if self.response is None:
            self.response = response
            record_provider_usage(
                response.usage.input_tokens, response.usage.output_tokens
            )


_active: ContextVar[ProviderCapture | None] = ContextVar(
    "provider_capture", default=None
)


def dispatched() -> None:
    if capture_enabled() and (attempt := _active.get()) is not None:
        attempt.started = time.perf_counter()
        record_provider_dispatch()


def prepared(payload: dict[str, object]) -> None:
    if capture_enabled() and (attempt := _active.get()) is not None:
        prompt = {key: payload.get(key) for key in ("instructions", "tools", "text")}
        attempt.prompt_fingerprint = hashlib.sha256(
            json.dumps(prompt, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()


@contextmanager
def provider_capture(model: str, mode: str) -> Iterator[ProviderCapture | None]:
    if not capture_enabled():
        yield None
        return
    scope_started, span_id, parent_token = begin_span()
    attempt = ProviderCapture(f"span-{span_id}")
    token = _active.set(attempt)
    outcome, error_code = "incomplete", None
    try:
        yield attempt
        outcome = "completed" if attempt.response is not None else "incomplete"
    except BaseException as error:
        outcome = (
            "cancelled"
            if isinstance(error, (asyncio.CancelledError, GeneratorExit))
            else "failed"
        )
        code = getattr(error, "code", None)
        if isinstance(code, str) and code in {
            "invalid_response",
            "invalid_request",
            "timeout",
            "unavailable",
            "rate_limit",
            "refused",
            "authentication",
            "output_limit",
        }:
            error_code = code
        raise
    finally:
        try:
            if attempt.started is not None and capture_enabled():
                finished = time.perf_counter()
                response = attempt.response
                # A completed event may be followed by generator close from its caller.
                if response is not None:
                    outcome = "completed"
                _record(
                    "provider_attempt",
                    {
                        "attempt_id": attempt.attempt_id,
                        "provider": "openai_responses",
                        "remote_evidence": "not_recorded",
                        "mode": mode,
                        "dispatch_start_ms": capture_offset(attempt.started),
                        "dispatch_duration_ms": round(
                            (finished - attempt.started) * 1000, 3
                        ),
                        "requested_model": model[:200],
                        "prompt_fingerprint": attempt.prompt_fingerprint,
                        "outcome": outcome,
                        "error_code": error_code,
                        "adapter_validation": "accepted"
                        if response
                        else "failed"
                        if error_code == "invalid_response"
                        else "not_recorded",
                        "model": response.model[:200] if response else None,
                        "finish_reason": response.finish_reason if response else None,
                        "input_tokens": response.usage.input_tokens
                        if response
                        else None,
                        "output_tokens": response.usage.output_tokens
                        if response
                        else None,
                    },
                    None,
                    durationMs=round((finished - scope_started) * 1000, 3),
                    startMs=capture_offset(scope_started),
                )
        finally:
            _active.reset(token)
            end_span(parent_token)
