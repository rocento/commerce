import asyncio
import json
from contextlib import aclosing
from uuid import uuid4

import httpx
import pytest
from pydantic import BaseModel, ConfigDict, field_validator

from app.commerce_action_engine.platform.settings import Settings
from app.commerce_resolution_engine.contracts import (
    Message,
    ModelError,
    ModelRequest,
    ToolCall,
    ToolDefinition,
    ToolResult,
)
from app.commerce_resolution_engine.diagnostics import begin_debug, finish_debug
from app.commerce_resolution_engine.providers.factory import build_provider
from app.commerce_resolution_engine.providers.openai import (
    MAX_BYTES,
    MAX_INVALID_OUTPUT_BYTES,
    MAX_VALIDATION_ISSUES,
    OpenAIProvider,
)


class Answer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    answer: str


class Args(BaseModel):
    model_config = ConfigDict(extra="forbid")
    product_id: str


REQUEST = ModelRequest((Message("user", "hello"),))


def test_all_shopper_tools_can_be_sent_to_provider():
    from app.commerce_action_engine.actions.catalog import DEFINITIONS

    def handle(request):
        data = json.loads(request.content)
        assert len(data["tools"]) == len(DEFINITIONS)
        search = next(t for t in data["tools"] if t["name"] == "search_products")
        assert search["parameters"]["properties"]["attributes"]["type"] == "array"
        return httpx.Response(200, json=result())

    async def scenario():
        p = provider(handle)
        try:
            response = await p.generate(
                ModelRequest(REQUEST.messages, tools=DEFINITIONS)
            )
            assert response.text == "hello"
        finally:
            await p.aclose()

    run(scenario())


def result(text="hello", **overrides):
    return {
        "status": "completed",
        "model": "configured-model-snapshot",
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text}],
            }
        ],
        "usage": {"input_tokens": 10, "output_tokens": 2, "total_tokens": 12},
        **overrides,
    }


def provider(handler, **kwargs):
    return OpenAIProvider(
        model="configured-model",
        api_key="secret-canary",
        transport=httpx.MockTransport(handler),
        **kwargs,
    )


def run(coro):
    return asyncio.run(coro)


def test_generate_contract_and_request_privacy():
    def handle(request):
        data = json.loads(request.content)
        assert data["model"] == "configured-model"
        assert data["store"] is False and data["stream"] is False
        assert "temperature" not in data and "previous_response_id" not in data
        assert request.url == "https://api.openai.com/v1/responses"
        assert request.headers["authorization"] == "Bearer secret-canary"
        return httpx.Response(200, json=result())

    async def scenario():
        p = provider(handle)
        try:
            response = await p.generate(REQUEST)
            assert response.text == "hello"
            assert response.usage.total_tokens == 12
            assert response.model == "configured-model-snapshot"
            assert response.finish_reason == "stop"
        finally:
            await p.aclose()
        assert p.client.is_closed

    run(scenario())


@pytest.mark.parametrize(
    "status,code",
    [
        (401, "authentication"),
        (403, "authentication"),
        (429, "rate_limit"),
        (500, "unavailable"),
        (503, "unavailable"),
        (504, "timeout"),
        (400, "invalid_request"),
        (302, "invalid_request"),
    ],
)
@pytest.mark.parametrize("stream", [False, True])
def test_http_failures_are_normalized_and_private(status, code, stream):
    async def scenario():
        p = provider(lambda _: httpx.Response(status, text="secret-canary"))
        try:
            with pytest.raises(ModelError) as caught:
                if stream:
                    _ = [event async for event in p.stream(REQUEST)]
                else:
                    await p.generate(REQUEST)
            assert caught.value.code == code
            assert "secret-canary" not in str(caught.value)
        finally:
            await p.aclose()

    run(scenario())


@pytest.mark.parametrize(
    "body,code",
    [
        ({}, "invalid_response"),
        ([], "invalid_response"),
        (result(usage=None), "invalid_response"),
        (
            result(usage={"input_tokens": -1, "output_tokens": 2, "total_tokens": 1}),
            "invalid_response",
        ),
        (result(status="incomplete"), "output_limit"),
        (result(status="failed", error={"code": "server_error"}), "unavailable"),
        (result(output=[]), "invalid_response"),
        (
            result(
                output=[
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "refusal"}],
                    }
                ]
            ),
            "refused",
        ),
    ],
)
def test_malformed_and_unsuccessful_results(body, code):
    async def scenario():
        p = provider(lambda _: httpx.Response(200, json=body))
        try:
            with pytest.raises(ModelError) as caught:
                await p.generate(REQUEST)
            assert caught.value.code == code
        finally:
            await p.aclose()

    run(scenario())


def test_structured_output_validated_locally():
    async def scenario():
        for text, valid in [
            ('{"answer":"yes"}', True),
            ('{"answer":4}', False),
            ('{"answer":"yes","extra":1}', False),
            ("not json", False),
        ]:

            def handle(req, text=text):
                fmt = json.loads(req.content)["text"]["format"]
                assert fmt["strict"] is True and fmt["type"] == "json_schema"
                return httpx.Response(200, json=result(text))

            p = provider(handle)
            try:
                request = ModelRequest(REQUEST.messages, output_schema=Answer)
                if valid:
                    response = await p.generate(request)
                    assert response.structured == Answer(answer="yes")
                else:
                    with pytest.raises(ModelError, match="invalid_response"):
                        await p.generate(request)
            finally:
                await p.aclose()

    run(scenario())


def test_invalid_structured_output_captures_private_bounded_evidence(caplog):
    class SensitiveValidatorAnswer(Answer):
        @field_validator("answer")
        @classmethod
        def reject_answer(cls, value):
            raise ValueError("private-validator-context-canary")

    async def scenario():
        response = result(
            '{"answer":"bad"}',
            private_vendor_field="private-provider-body-canary",
        )
        p = provider(lambda _: httpx.Response(200, json=response))
        token = begin_debug(str(uuid4()), "hello", enabled=True)
        try:
            with pytest.raises(ModelError, match="invalid_response") as caught:
                await p.generate(
                    ModelRequest(
                        REQUEST.messages, output_schema=SensitiveValidatorAnswer
                    )
                )
            assert caught.value.code == "invalid_response"
        finally:
            report = finish_debug(token)
            await p.aclose()
        event = next(
            event["data"]
            for event in report["events"]
            if event["stage"] == "provider_invalid_response"
        )
        assert event.pop("_journey")["atMs"] >= 0
        assert event == {
            "phase": "structured_output",
            "output_schema": "SensitiveValidatorAnswer",
            "model_output": '{"answer":"bad"}',
            "model_output_truncated": False,
            "validation_issues": [{"type": "value_error", "location": ["answer"]}],
            "validation_issues_truncated": False,
            "reported_usage": {
                "validation": "unverified_provider_counts",
                "input_tokens": 10,
                "output_tokens": 2,
                "total_tokens": 12,
            },
        }
        captured = json.dumps(report)
        assert "private-validator-context-canary" not in captured
        assert "private-provider-body-canary" not in captured
        assert "secret-canary" not in captured
        assert "authorization" not in captured.casefold()
        assert "private" not in caplog.text

    run(scenario())


def test_invalid_structured_capture_bounds_output_and_validation_details():
    async def scenario():
        text = json.dumps(
            {"answer": 4, **{f"untrusted-field-{i}": "🍎" * 1000 for i in range(32)}},
            ensure_ascii=False,
        )
        p = provider(lambda _: httpx.Response(200, json=result(text)))
        token = begin_debug(str(uuid4()), "hello", enabled=True)
        try:
            with pytest.raises(ModelError, match="invalid_response"):
                await p.generate(ModelRequest(REQUEST.messages, output_schema=Answer))
        finally:
            report = finish_debug(token)
            await p.aclose()
        event = next(
            event["data"]
            for event in report["events"]
            if event["stage"] == "provider_invalid_response"
        )
        assert len(event["model_output"].encode()) <= MAX_INVALID_OUTPUT_BYTES
        assert text.startswith(event["model_output"])
        assert "\ufffd" not in event["model_output"]
        assert event["model_output_truncated"] is True
        assert len(event["validation_issues"]) == MAX_VALIDATION_ISSUES
        assert event["validation_issues_truncated"] is True
        assert all(
            issue
            in (
                {"type": "string_type", "location": ["answer"]},
                {"type": "extra_forbidden", "location": ["unknown_field"]},
            )
            for issue in event["validation_issues"]
        )

    run(scenario())


@pytest.mark.parametrize(
    "body,phase,usage",
    [
        (
            result(
                '{"answer":"yes"}',
                usage={"input_tokens": 10, "output_tokens": 2, "total_tokens": 99},
            ),
            "response_usage",
            {"input_tokens": 10, "output_tokens": 2, "total_tokens": 99},
        ),
        (
            result(
                '{"answer":"yes"}',
                usage={
                    "input_tokens": "secret-canary",
                    "output_tokens": True,
                    "total_tokens": -1,
                },
            ),
            "response_usage",
            None,
        ),
        (
            result('{"answer":"yes"}', model=None),
            "response_model",
            {"input_tokens": 10, "output_tokens": 2, "total_tokens": 12},
        ),
        (
            {"status": "completed", "output": "private-canary"},
            "response_envelope",
            None,
        ),
    ],
)
def test_invalid_structured_capture_distinguishes_envelope_usage_and_model(
    body, phase, usage
):
    async def scenario():
        p = provider(lambda _: httpx.Response(200, json=body))
        token = begin_debug(str(uuid4()), "hello", enabled=True)
        try:
            with pytest.raises(ModelError, match="invalid_response"):
                await p.generate(ModelRequest(REQUEST.messages, output_schema=Answer))
        finally:
            report = finish_debug(token)
            await p.aclose()
        event = next(
            event["data"]
            for event in report["events"]
            if event["stage"] == "provider_invalid_response"
        )
        assert event["phase"] == phase
        assert "validation_issues" not in event
        if usage is None:
            assert "reported_usage" not in event
        else:
            assert event["reported_usage"] == {
                "validation": "unverified_provider_counts",
                **usage,
            }
        assert "secret-canary" not in json.dumps(report)
        assert "private-canary" not in json.dumps(report)

    run(scenario())


def test_invalid_structured_capture_is_disabled_by_default(monkeypatch, caplog):
    monkeypatch.delenv("AI_INTENT_DEBUG_DIR", raising=False)

    async def scenario():
        p = provider(lambda _: httpx.Response(200, json=result('{"answer":4}')))
        token = begin_debug(str(uuid4()), "hello")
        try:
            with pytest.raises(ModelError, match="invalid_response"):
                await p.generate(ModelRequest(REQUEST.messages, output_schema=Answer))
        finally:
            report = finish_debug(token)
            await p.aclose()
        assert report is None
        assert caplog.text == ""

    run(scenario())


@pytest.mark.parametrize("stream", [False, True])
def test_invalid_conversation_proposal_records_validator_issue_without_releasing_json(
    stream,
):
    from app.commerce_contracts.language_proposal import LanguageProposal

    async def scenario():
        text = json.dumps(
            {
                "status": "CONVERSATION",
                "intent": "CONVERSATION_JOKE",
                "canonical_text": "I was only kidding about ordering apples",
            }
        )
        raw = sse({"type": "response.output_text.delta", "delta": text})
        raw += sse({"type": "response.completed", "response": result(text)})
        p = provider(
            lambda _: (
                streaming(Chunks([raw]))
                if stream
                else httpx.Response(200, json=result(text))
            )
        )
        token = begin_debug(
            str(uuid4()), "I was only kidding about ordering apples", enabled=True
        )
        events = []
        try:
            request = ModelRequest(REQUEST.messages, output_schema=LanguageProposal)
            with pytest.raises(ModelError, match="invalid_response"):
                if stream:
                    async for event in p.stream(request):
                        events.append(event)
                else:
                    await p.generate(request)
        finally:
            report = finish_debug(token)
            await p.aclose()
        assert events == []
        failure = next(
            event["data"]
            for event in report["events"]
            if event["stage"] == "provider_invalid_response"
        )
        assert failure["phase"] == "structured_output"
        assert json.loads(failure["model_output"])["canonical_text"] is not None
        assert failure["validation_issues"] == [{"type": "value_error", "location": []}]
        assert "intent and canonical_text" not in json.dumps(failure)

    run(scenario())


def test_tool_call_validation_and_result_roundtrip():
    async def scenario():
        for name, arguments, valid in [
            ("get_product", '{"product_id":"p1"}', True),
            ("sql", "{}", False),
            ("get_product", '{"product_id":3}', False),
            ("get_product", '{"product_id":"p1","url":"bad"}', False),
        ]:

            def handle(req, name=name, arguments=arguments):
                data = json.loads(req.content)
                assert data["tools"][0]["type"] == "function"
                assert data["input"][-1]["type"] == "function_call_output"
                return httpx.Response(
                    200,
                    json=result(
                        output=[
                            {
                                "type": "function_call",
                                "name": name,
                                "call_id": "call-2",
                                "arguments": arguments,
                            }
                        ]
                    ),
                )

            p = provider(handle)
            request = ModelRequest(
                REQUEST.messages,
                tools=(ToolDefinition("get_product", "Read a product", Args),),
                tool_results=(
                    ToolResult(
                        ToolCall("call-1", "get_product", {"product_id": "p0"}),
                        "unavailable",
                    ),
                ),
            )
            try:
                if valid:
                    response = await p.generate(request)
                    assert response.tool_calls[0].arguments == {"product_id": "p1"}
                    assert response.finish_reason == "tool_calls"
                else:
                    with pytest.raises(ModelError, match="invalid_response"):
                        await p.generate(request)
            finally:
                await p.aclose()

    run(scenario())


class Chunks(httpx.AsyncByteStream):
    def __init__(self, chunks, pause=False):
        self.chunks = chunks
        self.pause = pause
        self.closed = False
        self.started = asyncio.Event()

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk
        self.started.set()
        if self.pause:
            await asyncio.sleep(10)

    async def aclose(self):
        self.closed = True


def sse(event):
    return ("data: " + json.dumps(event) + "\r\n\r\n").encode()


def streaming(chunks):
    return httpx.Response(
        200, headers={"content-type": "text/event-stream"}, stream=chunks
    )


def test_stream_fragmentation_usage_and_private_reasoning():
    async def scenario():
        raw = b": heartbeat\r\n\r\n" + sse(
            {"type": "response.reasoning_summary_text.delta", "delta": "private"}
        )
        raw += sse({"type": "response.output_text.delta", "delta": "hello"})
        raw += sse({"type": "response.completed", "response": result()})
        chunks = Chunks([bytes([byte]) for byte in raw])
        p = provider(lambda _: streaming(chunks))
        try:
            events = [event async for event in p.stream(REQUEST)]
            assert [event.type for event in events] == ["text_delta", "completed"]
            assert (
                events[0].text == "hello"
                and events[-1].response.usage.total_tokens == 12
            )
            assert "private" not in repr(events)
            assert chunks.closed
        finally:
            await p.aclose()

    run(scenario())


@pytest.mark.parametrize(
    "raw,code",
    [
        (
            sse({"type": "response.output_text.delta", "delta": "partial"}),
            "invalid_response",
        ),
        (b"data: not-json\n\n", "invalid_response"),
        (sse({"type": "response.completed", "response": result()}), "invalid_response"),
        (
            sse(
                {
                    "type": "error",
                    "code": "rate_limit_exceeded",
                    "message": "secret-canary",
                }
            ),
            "rate_limit",
        ),
        (b"x" * (MAX_BYTES + 1), "output_limit"),
    ],
)
def test_bad_streams_close(raw, code):
    async def scenario():
        chunks = Chunks([raw])
        p = provider(lambda _: streaming(chunks))
        try:
            with pytest.raises(ModelError) as caught:
                _ = [event async for event in p.stream(REQUEST)]
            assert caught.value.code == code and chunks.closed
        finally:
            await p.aclose()

    run(scenario())


@pytest.mark.parametrize("cancel", [False, True])
def test_total_stream_deadline_and_task_cancellation(cancel):
    async def scenario():
        chunks = Chunks([], pause=True)
        p = provider(lambda _: streaming(chunks), timeout=0.02 if not cancel else 1)

        async def consume():
            return [event async for event in p.stream(REQUEST)]

        try:
            task = asyncio.create_task(consume())
            await chunks.started.wait()
            if cancel:
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
            else:
                with pytest.raises(ModelError, match="timeout"):
                    await task
            assert chunks.closed
        finally:
            await p.aclose()

    run(scenario())


def test_consumer_stop_closes_stream():
    async def scenario():
        chunks = Chunks(
            [sse({"type": "response.output_text.delta", "delta": "hello"})], pause=True
        )
        p = provider(lambda _: streaming(chunks))
        try:
            async with aclosing(p.stream(REQUEST)) as events:
                await anext(events)
            assert chunks.closed
        finally:
            await p.aclose()

    run(scenario())


@pytest.mark.parametrize(
    "error,code",
    [
        (httpx.ConnectError("secret-canary"), "unavailable"),
        (httpx.ReadTimeout("secret-canary"), "timeout"),
    ],
)
def test_transport_error(error, code):
    async def handle(_):
        raise error

    async def scenario():
        p = provider(handle)
        try:
            with pytest.raises(ModelError, match=code):
                await p.generate(REQUEST)
        finally:
            await p.aclose()

    run(scenario())


def test_configuration_and_disabled_mode(tmp_path):
    assert build_provider(Settings()) is None
    with pytest.raises(ModelError, match="configuration"):
        build_provider(Settings(model_provider="unknown"))
    with pytest.raises(ModelError, match="configuration"):
        build_provider(
            Settings(model_provider="openai", model_key_file=str(tmp_path / "missing"))
        )
    for url in [
        "http://postgres:5432",
        "https://example.com",
        "https://api.openai.com/other",
    ]:
        with pytest.raises(ModelError, match="configuration"):
            OpenAIProvider(model="model", api_key="key", url=url)


def test_structured_stream_and_tool_stream():
    async def scenario():
        for structured in (False, True):
            request = ModelRequest(
                REQUEST.messages,
                output_schema=Answer if structured else None,
                tools=()
                if structured
                else (ToolDefinition("get_product", "Read", Args),),
            )
            text = '{"answer":"yes"}' if structured else ""
            output = (
                result(text)
                if structured
                else result(
                    output=[
                        {
                            "type": "function_call",
                            "name": "get_product",
                            "call_id": "c1",
                            "arguments": '{"product_id":"p1"}',
                        }
                    ]
                )
            )
            raw = (
                sse({"type": "response.output_text.delta", "delta": text})
                if text
                else b""
            )
            raw += sse({"type": "response.completed", "response": output})
            p = provider(lambda _, raw=raw: streaming(Chunks([raw])))
            try:
                events = [event async for event in p.stream(request)]
                assert len(events) == 1 and events[0].type == "completed"
                if structured:
                    assert events[0].response.structured == Answer(answer="yes")
                else:
                    assert events[0].response.tool_calls[0].name == "get_product"
            finally:
                await p.aclose()

    run(scenario())


@pytest.mark.parametrize("cancel", [False, True])
def test_generate_deadline_and_cancellation(cancel):
    async def scenario():
        chunks = Chunks([], pause=True)
        p = provider(
            lambda _: httpx.Response(200, stream=chunks), timeout=1 if cancel else 0.02
        )
        try:
            task = asyncio.create_task(p.generate(REQUEST))
            await chunks.started.wait()
            if cancel:
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
            else:
                with pytest.raises(ModelError, match="timeout"):
                    await task
            assert chunks.closed
        finally:
            await p.aclose()

    run(scenario())


def test_invalid_requests_do_not_reach_provider():
    class OpenSchema(BaseModel):
        answer: str

    def handle(_):
        pytest.fail("invalid request reached transport")

    async def scenario():
        p = provider(handle)
        try:
            for request in [
                ModelRequest(()),
                ModelRequest(REQUEST.messages, max_tokens=0),
                ModelRequest((Message("user", "x" * 131073),)),
                ModelRequest(REQUEST.messages, output_schema=OpenSchema),
                ModelRequest(
                    REQUEST.messages, tools=(ToolDefinition("../sql", "", Args),)
                ),
            ]:
                with pytest.raises(ModelError, match="invalid_request"):
                    await p.generate(request)
        finally:
            await p.aclose()

    run(scenario())


def test_configured_factory_uses_file_and_model(tmp_path):
    path = tmp_path / "key"
    path.write_text("secret-canary\n")

    async def scenario():
        p = build_provider(
            Settings(
                model_provider="openai", model_name="my-model", model_key_file=str(path)
            )
        )
        try:
            assert p.model == "my-model"
            assert p.client.headers["authorization"] == "Bearer secret-canary"
        finally:
            await p.aclose()

    run(scenario())
