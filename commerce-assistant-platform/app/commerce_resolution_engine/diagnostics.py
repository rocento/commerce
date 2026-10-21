"""Opt-in operator diagnostics, separate from public events and performance logs."""

import asyncio
import hashlib
import inspect
import json
import linecache
import logging
import os
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from functools import wraps
from html import escape
from pathlib import Path
from types import CodeType
from typing import Any, cast
from uuid import UUID, uuid4

MAX_BYTES = 1_000_000
MAX_EVENTS = 96
TERMINAL_RESERVE_BYTES = 32_000


@dataclass
class IntentDebug:
    request_id: str
    directory: Path | None
    events: list[dict[str, object]] = field(default_factory=list)
    size: int = 0
    truncated: bool = False
    started: float = field(default_factory=time.perf_counter)
    sources: set[str] = field(default_factory=set)
    publish: Callable[[str, str, object], None] | None = None
    span: int = 0
    sequence: int = 0
    closed: bool = False
    upstream_span: str | None = None
    provider_attempts: int = 0
    provider_completed: int = 0
    provider_input_tokens: int = 0
    provider_output_tokens: int = 0

    def identity(self) -> dict[str, object]:
        self.sequence += 1
        return {
            "eventId": f"event-{self.sequence}",
            "traceId": self.request_id,
            "service": "assistant-python",
            "clockDomain": "python-perf-counter",
        }

    def emit(self, kind: str, data: object) -> None:
        if self.publish:
            try:
                self.publish(self.request_id, kind, data)
            except Exception:  # noqa: BLE001 -- diagnostics must never break chat
                logging.getLogger("assistant").warning("live_tracking_unavailable")

    def record(self, stage: str, data: object) -> None:
        if self.closed:
            return
        # Snapshot now so later metadata changes cannot rewrite earlier decisions.
        serialized = json.dumps({"stage": stage, "data": data}, ensure_ascii=False)
        size = len(serialized.encode())
        terminal = stage == "final_result"
        if terminal and self.size + size > MAX_BYTES - 1024 and isinstance(data, dict):
            # Preserve bounded terminal measurements and completion even if a large
            # answer/source snapshot would consume the reserved terminal budget.
            gate = data.get("language_gate")
            data = {
                **{
                    key: data[key]
                    for key in (
                        "outcome",
                        "route_reason",
                        "completion",
                        "measurements",
                        "provider_totals",
                        "completion_evidence",
                        "language_fallback",
                        "_journey",
                    )
                    if key in data
                },
                "answer": None,
                "response_blocks": None,
                "terminal_details_truncated": True,
            }
            if isinstance(gate, dict):
                data["language_gate"] = {
                    key: gate[key]
                    for key in ("status", "intent", "route")
                    if key in gate
                }
            meta = data.get("_journey")
            if isinstance(meta, dict):
                data["_journey"] = {
                    key: value for key, value in meta.items() if key != "function"
                }
            serialized = json.dumps({"stage": stage, "data": data}, ensure_ascii=False)
            size = len(serialized.encode())
            self.truncated = True
        if self.size + size > (
            MAX_BYTES - 1024 if terminal else MAX_BYTES - TERMINAL_RESERVE_BYTES - 1024
        ) or len(self.events) >= (MAX_EVENTS if terminal else MAX_EVENTS - 1):
            self.truncated = True
            return
        self.events.append(json.loads(serialized))
        self.size += size
        self.emit("stage", self.events[-1])

    def save(self) -> None:
        if self.directory is None:
            return
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        document = {
            "version": 2,
            "request_id": self.request_id,
            "truncated": self.truncated,
            "events": self.events,
        }
        body = json.dumps(document, indent=2, ensure_ascii=False)
        sections = "".join(
            "<details open><summary>"
            + escape(str(event["stage"]))
            + "</summary><pre>"
            + escape(json.dumps(event["data"], indent=2, ensure_ascii=False))
            + "</pre></details>"
            for event in self.events
        )
        html = (
            '<!doctype html><html lang="en"><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            "<title>Intent debug</title><style>body{font:16px system-ui;max-width:1100px;"
            "margin:40px auto;padding:0 20px;background:#f5f7f9;color:#182330}"
            "details{background:white;border:1px solid #ccd5df;border-radius:8px;"
            "padding:16px;margin:16px 0}summary{font-weight:600;cursor:pointer}"
            "pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}</style>"
            "<h1>Intent debug</h1><p>Request " + escape(self.request_id) + "</p>"
            "<p>Operator capture of this turn. No model request means no LLM input "
            "was captured. Historical requests cannot be reconstructed.</p>"
            + (
                "<p>Capture limit reached; some stages were omitted.</p>"
                if self.truncated
                else ""
            )
            + sections
            + "</html>"
        )
        for suffix, content in (("json", body), ("html", html)):
            target = self.directory / f"{self.request_id}.{suffix}"
            temporary = self.directory / f".{uuid4()}.tmp"
            try:
                descriptor = os.open(
                    temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
                )
                with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                    handle.write(content)
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)


_current: ContextVar[IntentDebug | None] = ContextVar("intent_debug", default=None)
_parent: ContextVar[tuple[IntentDebug, int, str | None] | None] = ContextVar(
    "diagnostic_parent", default=None
)


def capture_enabled() -> bool:
    capture = _current.get()
    return capture is not None and not capture.closed


def provider_totals() -> dict[str, object] | None:
    capture = _current.get()
    if capture is None or capture.closed:
        return None
    return {
        "version": 1,
        "scope": "openai_responses_dispatch",
        "attempts": capture.provider_attempts,
        "completed": capture.provider_completed,
        "input_tokens": capture.provider_input_tokens,
        "output_tokens": capture.provider_output_tokens,
        "usage_complete": capture.provider_attempts == capture.provider_completed,
    }


def capture_offset(started: float) -> float | None:
    capture = _current.get()
    return (
        round((started - capture.started) * 1000, 3)
        if capture and not capture.closed
        else None
    )


def record_provider_dispatch() -> None:
    if (capture := _current.get()) is not None and not capture.closed:
        capture.provider_attempts += 1


def record_provider_usage(input_tokens: int, output_tokens: int) -> None:
    if (capture := _current.get()) is not None and not capture.closed:
        capture.provider_completed += 1
        capture.provider_input_tokens += input_tokens
        capture.provider_output_tokens += output_tokens


def span_parent() -> str | None:
    parent = _parent.get()
    return f"span-{parent[1]}" if parent and parent[0] is _current.get() else None


def begin_span() -> tuple[
    float, int, Token[tuple[IntentDebug, int, str | None] | None]
]:
    """Internal capture scope; callers must first check capture_enabled()."""
    capture = _current.get()
    assert capture is not None and not capture.closed
    parent = span_parent()
    capture.span += 1
    return (
        time.perf_counter(),
        capture.span,
        _parent.set((capture, capture.span, parent)),
    )


def end_span(token: Token[tuple[IntentDebug, int, str | None] | None]) -> None:
    _parent.reset(token)


def span_metadata() -> dict[str, object]:
    parent = _parent.get()
    if parent and parent[0] is _current.get():
        return {
            "spanId": f"span-{parent[1]}",
            "parentSpanId": parent[2] or parent[0].upstream_span,
            "parentService": "assistant-python"
            if parent[2]
            else "api-gateway"
            if parent[0].upstream_span
            else None,
        }
    return {"spanId": None, "parentSpanId": None}


def begin_debug(
    request_id: str,
    message: str,
    *,
    enabled: bool = False,
    allowed: bool = True,
    publish: Callable[[str, str, object], None] | None = None,
) -> Token[IntentDebug | None]:
    if not allowed:
        return _current.set(None)
    directory = os.environ.get("AI_INTENT_DEBUG_DIR", "")
    capture = IntentDebug(str(UUID(request_id)), None) if enabled else None
    if directory:
        path = Path(directory)
        if path.is_absolute():
            capture = IntentDebug(str(UUID(request_id)), path)
    if capture:
        capture.publish = publish
    token = _current.set(capture)
    debug_record("customer_request", {"message": message})
    return token


# Retain the code object with its identity: id reuse cannot return another
# function's source, and cache hits avoid recursively hashing code constants.
_source_cache: OrderedDict[int, tuple[CodeType, dict[str, object] | None]] = (
    OrderedDict()
)
_source_lock = threading.RLock()


def _source(code: CodeType) -> dict[str, object] | None:
    with _source_lock:
        identity = id(code)
        if (entry := _source_cache.get(identity)) is not None and entry[0] is code:
            _source_cache.move_to_end(identity)
            return entry[1]
        result = _read_source(code)
        _source_cache[identity] = (code, result)
        _source_cache.move_to_end(identity)
        while len(_source_cache) > 256:
            _source_cache.popitem(last=False)
        return result


def _read_source(code: CodeType) -> dict[str, object] | None:
    """Only deployed application code; never arguments, locals or arbitrary paths."""
    root = Path(__file__).resolve().parents[1]
    try:
        path = Path(code.co_filename).resolve()
        relative = path.relative_to(root)
        # The verified filename and code line already identify the function.
        # inspect.getsourcelines(code) additionally searches imported modules.
        line = code.co_firstlineno
        file_lines = linecache.getlines(str(path))
        if not 0 < line <= len(file_lines):
            return None
        lines = inspect.getblock(file_lines[line - 1 :])
    except (OSError, TypeError, ValueError):
        return None
    source = "".join(lines)
    return {
        "id": hashlib.sha256((str(relative) + source).encode()).hexdigest(),
        "file": "app/" + str(relative),
        "name": code.co_qualname,
        "line": line,
        "sha256": hashlib.sha256(source.encode()).hexdigest(),
        "source": source[:24000],
        "truncated": len(source) > 24000,
    }


def _record(stage: str, data: object, code: CodeType | None, **timing: object) -> None:
    if (capture := _current.get()) is not None and not capture.closed:
        try:
            meta: dict[str, object] = {
                **capture.identity(),
                **span_metadata(),
                "atMs": round((time.perf_counter() - capture.started) * 1000, 3),
                **timing,
            }
            source = _source(code) if code else None
            if source:
                meta["sourceId"] = source["id"]
                source_id = str(source["id"])
                if source_id not in capture.sources:
                    meta["function"] = source
            # Preserve all original diagnostic fields, adding an operator-only key.
            payload = (
                {**data, "_journey": meta}
                if isinstance(data, dict)
                else {"value": data, "_journey": meta}
            )
            previous = len(capture.events)
            capture.record(stage, payload)
            if source and len(capture.events) > previous:
                capture.sources.add(str(source["id"]))
        except (TypeError, ValueError, OSError):
            capture.truncated = True


def debug_record(stage: str, data: object) -> None:
    if capture_enabled():
        frame = inspect.currentframe()
        try:
            _record(
                stage, data, frame.f_back.f_code if frame and frame.f_back else None
            )
        finally:
            del frame


_function_details: ContextVar[dict[str, object] | None] = ContextVar(
    "function_details", default=None
)


def record_function_details(details: dict[str, object]) -> None:
    """Attach explicitly selected diagnostic facts to the current function span."""
    if capture_enabled() and (target := _function_details.get()) is not None:
        target.update(details)


def function_details_enabled() -> bool:
    return capture_enabled() and _function_details.get() is not None


def traced[F: Callable[..., Any]](function: F) -> F:
    """Measure selected calls; only explicitly selected diagnostic facts are captured."""

    def start() -> tuple[float, int, Token[tuple[IntentDebug, int, str | None] | None]]:
        started, call_id, parent_token = begin_span()
        capture = _current.get()
        assert capture is not None
        # Start notifications are live-only; the durable report keeps completed spans.
        meta: dict[str, object] = {
            **capture.identity(),
            **span_metadata(),
            "atMs": round((started - capture.started) * 1000, 3),
            "startMs": round((started - capture.started) * 1000, 3),
        }
        if source := _source(function.__code__):
            meta.update({"function": source, "sourceId": source["id"]})
        capture.emit(
            "stage",
            {
                "stage": "python_function_start",
                "data": {
                    "function": function.__qualname__,
                    "callId": call_id,
                    "outcome": "running",
                    "_journey": meta,
                },
            },
        )
        return started, call_id, parent_token

    def finish(started: float, call_id: int, outcome: str) -> None:
        capture = _current.get()
        if capture and not capture.closed:
            _record(
                "python_function",
                {
                    "function": function.__qualname__,
                    "callId": call_id,
                    "outcome": outcome,
                    **(
                        {"details": dict(details)}
                        if (details := _function_details.get())
                        else {}
                    ),
                },
                function.__code__,
                startMs=round((started - capture.started) * 1000, 3),
                durationMs=round((time.perf_counter() - started) * 1000, 3),
            )

    if inspect.iscoroutinefunction(function):

        @wraps(function)
        async def asynchronous(*args: Any, **kwargs: Any) -> Any:
            if not capture_enabled():
                return await function(*args, **kwargs)
            (started, call_id, parent_token), outcome = start(), "error"
            details_token = _function_details.set({})
            try:
                result = await function(*args, **kwargs)
                outcome = "returned"
                return result
            except BaseException as error:
                if isinstance(error, (asyncio.CancelledError, GeneratorExit)):
                    outcome = "cancelled"
                raise
            finally:
                try:
                    finish(started, call_id, outcome)
                finally:
                    _function_details.reset(details_token)
                    end_span(parent_token)

        return cast(F, asynchronous)

    @wraps(function)
    def synchronous(*args: Any, **kwargs: Any) -> Any:
        if not capture_enabled():
            return function(*args, **kwargs)
        (started, call_id, parent_token), outcome = start(), "error"
        details_token = _function_details.set({})
        try:
            result = function(*args, **kwargs)
            outcome = "returned"
            return result
        finally:
            try:
                finish(started, call_id, outcome)
            finally:
                _function_details.reset(details_token)
                end_span(parent_token)

    return cast(F, synchronous)


def finish_debug(token: Token[IntentDebug | None]) -> dict[str, object] | None:
    capture = _current.get()
    _current.reset(token)
    if capture:
        capture.closed = True
        capture.emit("finished", {"truncated": capture.truncated})
        try:
            capture.save()
        except OSError:
            logging.getLogger("assistant").warning("intent_debug_write_unavailable")
        return {
            "version": 2,
            "request_id": capture.request_id,
            "truncated": capture.truncated,
            "events": capture.events,
        }
    return None
