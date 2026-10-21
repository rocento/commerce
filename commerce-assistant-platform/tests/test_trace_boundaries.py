"""M4 links carry identifiers only and never align independent service clocks."""

import asyncio
from uuid import uuid4

import httpx
import pytest

from app.commerce_resolution_engine.boundaries import (
    REQUEST_HEADER,
    RESPONSE_HEADER,
    boundary,
    gateway_dispatch,
)
from app.commerce_resolution_engine.diagnostics import begin_debug, finish_debug, traced


def test_gateway_and_concurrent_remote_links_are_request_scoped():
    async def run():
        request = str(uuid4())
        token = begin_debug(request, "test", enabled=True)
        gateway_dispatch(f"1/{uuid4()}/wrong")
        gateway_dispatch(f"1/{request}/gateway-fixture")

        @traced
        async def child():
            with boundary("language-engine", "resolve") as call:
                assert call is not None
                await asyncio.sleep(0)
                call.received(
                    {RESPONSE_HEADER: f"{call.headers[REQUEST_HEADER]}/{uuid4()}/2.5"},
                    200,
                )

        await asyncio.gather(child(), child())
        return finish_debug(token)

    report = asyncio.run(run())
    remote = [e["data"] for e in report["events"] if e["stage"] == "service_span"]
    assert len(remote) == 3
    assert remote[0]["_journey"]["service"] == "api-gateway"
    assert remote[0]["_journey"]["startMs"] is None
    assert len({r["_journey"]["parentSpanId"] for r in remote[1:]}) == 2
    for row in remote[1:]:
        assert row["_journey"]["parentService"] == "assistant-python"
        assert row["_journey"]["clockDomain"] == "remote-handler"
        assert row["_journey"]["durationMs"] == 2.5
    functions = [
        e["data"]["_journey"]
        for e in report["events"]
        if e["stage"] == "python_function"
    ]
    assert all(
        r["parentSpanId"] == "gateway-fixture" and r["parentService"] == "api-gateway"
        for r in functions
    )


@pytest.mark.parametrize(
    "suffix",
    [
        "/not-a-uuid/1",
        f"/{uuid4()}/nan",
        f"/{uuid4()}/inf",
        f"/{uuid4()}/-1",
        f"/{uuid4()}/300001",
        "/" + ("x" * 300),
    ],
)
def test_malformed_remote_metadata_is_ignored(suffix):
    token = begin_debug(str(uuid4()), "test", enabled=True)
    with boundary("language-engine", "resolve") as call:
        call.received({RESPONSE_HEADER: call.headers[REQUEST_HEADER] + suffix}, 200)
    report = finish_debug(token)
    assert not any(e["stage"] == "service_span" for e in report["events"])
    assert report["events"][-1]["data"]["remote_evidence"] == "not_recorded"


def test_mismatched_request_and_parent_are_not_accepted():
    token = begin_debug(str(uuid4()), "test", enabled=True)
    with boundary("language-engine", "resolve") as call:
        for context in [
            f"1/{uuid4()}/{call.span_id}",
            f"1/{call.trace_id}/another-span",
        ]:
            call.received({RESPONSE_HEADER: f"{context}/{uuid4()}/1"}, 200)
        assert call.remote is None
    finish_debug(token)


def test_disabled_and_cancelled_capture_preserve_behavior(monkeypatch):
    monkeypatch.delenv("AI_INTENT_DEBUG_DIR", raising=False)
    token = begin_debug(str(uuid4()), "test", allowed=False)
    with boundary("language-engine", "resolve") as call:
        assert call is None
    assert finish_debug(token) is None
    token = begin_debug(str(uuid4()), "test", enabled=True)
    with pytest.raises(asyncio.CancelledError), boundary("language-engine", "resolve"):
        raise asyncio.CancelledError()
    report = finish_debug(token)
    assert report["events"][-1]["data"]["outcome"] == "cancelled"


def test_real_language_adapter_sends_context_and_captures_remote_failure(monkeypatch):
    from app.commerce_action_engine.execution.language import gate

    original = httpx.AsyncClient

    def handle(request):
        context = request.headers[REQUEST_HEADER]
        return httpx.Response(
            400,
            json={"error": "incompatible_version"},
            headers={RESPONSE_HEADER: f"{context}/{uuid4()}/1.25"},
        )

    monkeypatch.setattr(
        gate.httpx,
        "AsyncClient",
        lambda **kw: original(transport=httpx.MockTransport(handle), **kw),
    )
    token = begin_debug(str(uuid4()), "test", enabled=True)
    result = asyncio.run(gate.resolve("http://language", "hello"))
    report = finish_debug(token)
    assert result.code == "incompatible_version"
    remote = next(e["data"] for e in report["events"] if e["stage"] == "service_span")
    assert remote["outcome"] == "failed" and remote["_journey"]["durationMs"] == 1.25


def test_catalog_transport_propagates_only_when_captured():
    from test_catalog_tools import DATA, WHO
    from test_catalog_transport import transport

    from app.commerce_action_engine.actions.catalog import SearchToolArgs

    seen = []

    def handle(request):
        seen.append(request.headers.get(REQUEST_HEADER))
        headers = {RESPONSE_HEADER: f"{seen[-1]}/{uuid4()}/3"} if seen[-1] else {}
        return httpx.Response(200, json=DATA, headers=headers)

    async def run():
        async with httpx.AsyncClient(
            base_url="http://catalog", transport=httpx.MockTransport(handle)
        ) as client:
            return await transport(client).read(
                "search_products", SearchToolArgs(query="fruit"), WHO
            )

    token = begin_debug(str(uuid4()), "test", enabled=True)
    captured = asyncio.run(run())
    report = finish_debug(token)
    token = begin_debug(str(uuid4()), "test", allowed=False)
    uncaptured = asyncio.run(run())
    finish_debug(token)
    assert captured == uncaptured and seen[0] and seen[1] is None
    assert any(
        e["stage"] == "service_span"
        and e["data"]["_journey"]["service"] == "api-gateway"
        for e in report["events"]
    )


def test_redaction_preserves_remote_clock_and_link_ids():
    from app.commerce_action_engine.platform.live_tracking import LiveFeed
    from app.commerce_action_engine.platform.tracking import redact_tracking

    request, gateway, remote = str(uuid4()), str(uuid4()), str(uuid4())
    feed = LiveFeed()
    cursor = feed.read("tenant")["cursor"]
    token = begin_debug(
        request,
        "test@example.com",
        enabled=True,
        publish=lambda r, k, d: feed.publish("tenant", r, k, d),
    )
    gateway_dispatch(f"1/{request}/{gateway}")
    with boundary("language-engine", "resolve") as call:
        call.received(
            {RESPONSE_HEADER: f"{call.headers[REQUEST_HEADER]}/{remote}/4"}, 200
        )
    report = finish_debug(token)
    import json

    for document in [redact_tracking(report), feed.read("tenant", cursor)]:
        serialized = json.dumps(document)
        assert gateway in serialized and remote in serialized
        assert "test@example.com" not in serialized


def test_many_remote_boundaries_keep_capture_bounded_and_terminal_reserved():
    import json

    from app.commerce_resolution_engine.diagnostics import (
        MAX_BYTES,
        MAX_EVENTS,
        debug_record,
    )

    token = begin_debug(str(uuid4()), "test", enabled=True)
    for _ in range(100):
        with boundary("language-engine", "resolve") as call:
            call.received(
                {RESPONSE_HEADER: f"{call.headers[REQUEST_HEADER]}/{uuid4()}/1"}, 200
            )
    debug_record("final_result", {"outcome": "completed"})
    report = finish_debug(token)
    assert report["truncated"] and len(report["events"]) <= MAX_EVENTS
    assert report["events"][-1]["stage"] == "final_result"
    assert len(json.dumps(report).encode()) < MAX_BYTES
