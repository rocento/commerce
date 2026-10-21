"""Operator diagnostics cannot leak into responses, logs, or another request."""

import asyncio
import json
import stat
from uuid import uuid4

from test_model_provider import provider, result

from app.commerce_resolution_engine.contracts import Message, ModelRequest
from app.commerce_resolution_engine.diagnostics import (
    begin_debug,
    debug_record,
    finish_debug,
)


def test_disabled_capture_writes_nothing(monkeypatch, tmp_path):
    monkeypatch.delenv("AI_INTENT_DEBUG_DIR", raising=False)
    token = begin_debug(str(uuid4()), "private")
    debug_record("test", {"private": "value"})
    finish_debug(token)
    assert list(tmp_path.iterdir()) == []


def test_provider_wire_payload_matches_request_without_credentials(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("AI_INTENT_DEBUG_DIR", str(tmp_path))
    request_id = str(uuid4())
    wire = []

    def handle(request):
        wire.append(json.loads(request.content))
        return __import__("httpx").Response(200, json=result())

    async def scenario():
        token = begin_debug(request_id, '<script>alert("x")</script>')
        model = provider(handle)
        try:
            await model.generate(ModelRequest((Message("user", "hello"),)))
        finally:
            await model.aclose()
            finish_debug(token)

    asyncio.run(scenario())
    document = (tmp_path / f"{request_id}.json").read_text()
    assert "secret-canary" not in document
    capture = json.loads(document)
    observed = dict(capture["events"][1]["data"])
    assert observed.pop("_journey")["function"]["name"].endswith("._payload")
    assert observed == wire[0]
    html = (tmp_path / f"{request_id}.html").read_text()
    assert "<script>" not in html and "&lt;script&gt;" in html
    assert stat.S_IMODE((tmp_path / f"{request_id}.json").stat().st_mode) == 0o600


def test_concurrent_captures_are_isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("AI_INTENT_DEBUG_DIR", str(tmp_path))
    ids = [str(uuid4()), str(uuid4())]

    async def capture(request_id):
        token = begin_debug(request_id, request_id)
        await asyncio.sleep(0)
        debug_record("test", {"id": request_id})
        finish_debug(token)

    async def scenario():
        await asyncio.gather(*(capture(request_id) for request_id in ids))

    asyncio.run(scenario())
    for request_id in ids:
        data = json.loads((tmp_path / f"{request_id}.json").read_text())
        assert data["events"][1]["data"]["id"] == request_id


def test_capture_limits_and_write_failure_do_not_break_chat(monkeypatch, tmp_path):
    monkeypatch.setenv("AI_INTENT_DEBUG_DIR", str(tmp_path / "blocked"))
    (tmp_path / "blocked").write_text("file")
    token = begin_debug(str(uuid4()), "hello")
    debug_record("oversize", "x" * 1_000_001)
    finish_debug(token)


def test_function_timing_source_identity_and_disabled_capture(monkeypatch):
    from app.commerce_action_engine.application.interpretation import (
        reasoning_fallback_message,
    )
    from app.commerce_resolution_engine.diagnostics import traced

    monkeypatch.delenv("AI_INTENT_DEBUG_DIR", raising=False)
    wrapped = traced(reasoning_fallback_message)
    assert wrapped(None) is None
    token = begin_debug(str(uuid4()), "hello", enabled=True)
    try:
        assert wrapped(None) is None
        assert wrapped(None) is None
    finally:
        report = finish_debug(token)
    events = [e["data"] for e in report["events"] if e["stage"] == "python_function"]
    first, second = [e["_journey"] for e in events]
    assert first["durationMs"] >= 0 and first["startMs"] <= first["atMs"]
    assert first["function"]["file"].startswith("app/")
    assert "def reasoning_fallback_message" in first["function"]["source"]
    assert first["sourceId"] == second["sourceId"]
    assert "function" not in second
    assert all(e["outcome"] == "returned" for e in events)


def test_traced_errors_and_concurrent_async_calls_preserve_behavior(monkeypatch):
    from app.commerce_resolution_engine.diagnostics import traced

    monkeypatch.delenv("AI_INTENT_DEBUG_DIR", raising=False)

    @traced
    async def operation(private_argument):
        await asyncio.sleep(0)
        raise ValueError(private_argument)

    async def run():
        token = begin_debug(str(uuid4()), "hello", enabled=True)
        try:
            try:
                await operation("sensitive-argument-canary")
            except ValueError as error:
                assert str(error) == "sensitive-argument-canary"
        finally:
            report = finish_debug(token)
        assert "sensitive-argument-canary" not in json.dumps(report)
        assert report["events"][-1]["data"]["outcome"] == "error"
        # Test files live outside app and cannot be used as source browsing targets.
        assert "function" not in report["events"][-1]["data"]["_journey"]

    asyncio.run(run())


def test_disabled_runtime_switch_skips_source_timing_and_debug_directory(
    monkeypatch, tmp_path
):
    from app.commerce_resolution_engine import diagnostics

    monkeypatch.setenv("AI_INTENT_DEBUG_DIR", str(tmp_path))
    monkeypatch.setattr(
        diagnostics,
        "_source",
        lambda _: (_ for _ in ()).throw(AssertionError("Source capture must not run")),
    )
    monkeypatch.setattr(
        diagnostics.time,
        "perf_counter",
        lambda: (_ for _ in ()).throw(AssertionError("Timing must not run")),
    )

    @diagnostics.traced
    def call():
        diagnostics.debug_record("test", {"hello": "world"})
        return 42

    token = diagnostics.begin_debug(str(uuid4()), "hello", enabled=False, allowed=False)
    assert call() == 42
    assert diagnostics.finish_debug(token) is None
    assert list(tmp_path.iterdir()) == []


def test_function_details_are_isolated_between_concurrent_calls(monkeypatch):
    from app.commerce_resolution_engine.diagnostics import (
        record_function_details,
        traced,
    )

    monkeypatch.delenv("AI_INTENT_DEBUG_DIR", raising=False)

    @traced
    async def operation(name):
        record_function_details({"operation": name})
        await asyncio.sleep(0)
        if name == "failure":
            raise ValueError("private-error-canary")
        return name

    async def run():
        token = begin_debug(str(uuid4()), "hello", enabled=True)
        try:
            await asyncio.gather(
                operation("first"), operation("failure"), return_exceptions=True
            )
        finally:
            report = finish_debug(token)
        calls = [e["data"] for e in report["events"] if e["stage"] == "python_function"]
        assert [(e["details"]["operation"], e["outcome"]) for e in calls] == [
            ("first", "returned"),
            ("failure", "error"),
        ]
        assert "private-error-canary" not in json.dumps(report)

    asyncio.run(run())
