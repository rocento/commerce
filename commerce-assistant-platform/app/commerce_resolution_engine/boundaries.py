"""Bounded internal trace links; no payloads, credentials, or clock alignment."""

import asyncio
import re
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from uuid import UUID

from app.commerce_resolution_engine.diagnostics import (
    _current,
    _record,
    begin_span,
    capture_enabled,
    capture_offset,
    end_span,
)

REQUEST_HEADER = "x-commerce-trace-request"
RESPONSE_HEADER = "x-commerce-trace-response"
_ID = re.compile(r"[a-zA-Z0-9-]{1,64}\Z")


def valid_context(value: str | None, request_id: str) -> str | None:
    if not value or len(value) > 160:
        return None
    parts = value.split("/")
    if len(parts) != 3 or parts[0] != "1" or parts[1] != request_id:
        return None
    return parts[2] if _ID.fullmatch(parts[2]) else None


def gateway_dispatch(value: str | None) -> None:
    capture = _current.get()
    if not capture_enabled() or capture is None:
        return
    parent = valid_context(value, capture.request_id)
    if parent is None:
        return
    capture.upstream_span = parent
    _record(
        "service_span",
        {
            "operation": "assistant dispatch",
            "outcome": "dispatched",
            "boundary": "gateway_to_python",
            "completion": "not_captured",
        },
        None,
        service="api-gateway",
        spanId=parent,
        parentSpanId=None,
        parentService=None,
        clockDomain=None,
        atMs=None,
        startMs=None,
    )


@dataclass
class Boundary:
    trace_id: str
    span_id: str
    service: str
    operation: str
    status: int | None = None
    remote: tuple[str, float] | None = None
    headers: dict[str, str] = field(default_factory=dict)

    def received(self, headers: Mapping[str, str], status: int) -> None:
        self.status = status
        value = headers.get(RESPONSE_HEADER, "")
        if len(value) > 240:
            return
        parts = value.split("/")
        if len(parts) != 5 or "/".join(parts[:3]) != self.headers[REQUEST_HEADER]:
            return
        try:
            remote_id = str(UUID(parts[3]))
            duration = float(parts[4])
        except (ValueError, OverflowError):
            return
        if remote_id != parts[3] or not 0 <= duration <= 300_000:
            return
        self.remote = (remote_id, duration)


@contextmanager
def boundary(service: str, operation: str) -> Iterator[Boundary | None]:
    if not capture_enabled():
        yield None
        return
    capture = _current.get()
    assert capture is not None
    started, span_id, token = begin_span()
    call = Boundary(capture.request_id, f"span-{span_id}", service, operation)
    call.headers[REQUEST_HEADER] = f"1/{call.trace_id}/{call.span_id}"
    outcome = "failed"
    try:
        yield call
        outcome = (
            ("failed" if call.status >= 400 else "received")
            if call.status is not None
            else "completion_not_captured"
        )
    except BaseException as error:
        if isinstance(error, (asyncio.CancelledError, GeneratorExit)):
            outcome = "cancelled"
        raise
    finally:
        try:
            if capture_enabled():
                _record(
                    "http_boundary",
                    {
                        "operation": operation,
                        "peer_service": service,
                        "outcome": outcome,
                        "http_status": call.status,
                        "remote_evidence": "recorded"
                        if call.remote
                        else "not_recorded",
                    },
                    None,
                    startMs=capture_offset(started),
                    durationMs=round((time.perf_counter() - started) * 1000, 3),
                )
                if call.remote:
                    remote_id, duration = call.remote
                    _record(
                        "service_span",
                        {
                            "operation": operation,
                            "outcome": "completed"
                            if call.status is not None and call.status < 400
                            else "failed",
                            "http_status": call.status,
                            "timing_scope": "remote_handler",
                            "alignment": "unavailable",
                        },
                        None,
                        service=service,
                        spanId=remote_id,
                        parentSpanId=call.span_id,
                        parentService="assistant-python",
                        clockDomain="remote-handler",
                        clockId=remote_id,
                        atMs=duration,
                        startMs=0,
                        durationMs=duration,
                    )
        finally:
            end_span(token)
