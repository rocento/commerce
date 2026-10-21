from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from uuid import uuid4

import pytest

from app.commerce_resolution_engine.admission import (
    ReasoningGateway,
    install_permit,
    issue_unknown_permit,
    reset_permit,
)
from app.commerce_resolution_engine.chat import stream_chat
from app.commerce_resolution_engine.contracts import (
    Message,
    ModelEvent,
    ModelRequest,
    ModelResponse,
    Usage,
)
from app.commerce_resolution_engine.providers.usage import UsageProvider


class FakeModel:
    def __init__(self) -> None:
        self.generate_calls = 0
        self.stream_calls = 0

    async def generate(self, request: ModelRequest) -> ModelResponse:
        self.generate_calls += 1
        return ModelResponse("ok", (), None, Usage(3, 2, 5), "test-model", "stop")

    async def stream(self, request: ModelRequest) -> AsyncGenerator[ModelEvent, None]:
        self.stream_calls += 1
        yield ModelEvent("text_delta", text="ok")
        yield ModelEvent(
            "completed",
            response=ModelResponse(
                "ok", (), None, Usage(3, 2, 5), "test-model", "stop"
            ),
        )

    async def aclose(self) -> None:
        pass


@pytest.fixture
def model_request() -> ModelRequest:
    return ModelRequest(messages=(Message("user", "hello"),))


@pytest.mark.parametrize("method", ["generate", "stream"])
def test_gateway_denies_provider_calls_without_unknown_permit(method, model_request):
    async def run():
        model = FakeModel()
        gateway = ReasoningGateway(UsageProvider(model), uuid4())

        with pytest.raises(PermissionError, match="explicit UNKNOWN permit"):
            if method == "generate":
                await gateway.generate(model_request)
            else:
                async for _ in gateway.stream(model_request):
                    pass

        assert model.generate_calls == 0
        assert model.stream_calls == 0

    asyncio.run(run())


@pytest.mark.parametrize(
    "status",
    ["RESOLVED", "NEEDS_CONTEXT", "UNAVAILABLE", "AMBIGUOUS", "UNSUPPORTED", "DENIED"],
)
def test_only_unknown_status_can_issue_permit(status):
    assert issue_unknown_permit(status, uuid4()) is None


def test_unknown_permit_allows_and_accounts_for_generate_and_stream(model_request):
    async def run():
        model = FakeModel()
        request_id = uuid4()
        gateway = ReasoningGateway(UsageProvider(model), request_id)
        token = install_permit(issue_unknown_permit("UNKNOWN", request_id))
        try:
            response = await gateway.generate(model_request)
            events = [event async for event in gateway.stream(model_request)]
        finally:
            reset_permit(token)

        assert response.text == "ok"
        assert [event.type for event in events] == ["text_delta", "completed"]
        assert (model.generate_calls, model.stream_calls) == (1, 1)
        assert (gateway.calls, gateway.attempts) == (2, 2)
        assert (gateway.input_tokens, gateway.output_tokens) == (6, 4)

    asyncio.run(run())


def test_permit_is_bound_to_turn_request_id(model_request):
    async def run():
        model = FakeModel()
        gateway = ReasoningGateway(UsageProvider(model), uuid4())
        token = install_permit(issue_unknown_permit("UNKNOWN", uuid4()))
        try:
            with pytest.raises(PermissionError):
                await gateway.generate(model_request)
        finally:
            reset_permit(token)
        assert model.generate_calls == 0

    asyncio.run(run())


@pytest.mark.parametrize("text_only", [False, True])
@pytest.mark.parametrize("ending", ["close", "complete", "cancel", "error"])
def test_gateway_owns_nested_stream_lifetime(text_only, ending, model_request):
    async def run():
        entered = asyncio.Event()
        closed = []
        retained = []

        class StreamingModel(FakeModel):
            def stream(self, *args, **kwargs):
                async def generate():
                    try:
                        yield ModelEvent("text_delta", text="ok")
                        if ending == "cancel":
                            entered.set()
                            await asyncio.Event().wait()
                        if ending == "error":
                            raise RuntimeError("provider failed")
                    finally:
                        closed.append(True)

                stream = generate()
                retained.append(stream)  # Prevent garbage collection masking a leak.
                return stream

        model = StreamingModel()
        request_id = uuid4()
        token = install_permit(issue_unknown_permit("UNKNOWN", request_id))
        gateway = ReasoningGateway(UsageProvider(model), request_id)
        stream = (
            stream_chat(gateway, question="hello", max_tokens=10)
            if text_only
            else gateway.stream(model_request)
        )
        try:
            await anext(stream)
            assert closed == []
            if ending == "close":
                await stream.aclose()
            elif ending == "cancel":
                task = asyncio.create_task(anext(stream))
                await entered.wait()
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
            elif ending == "error":
                with pytest.raises(RuntimeError, match="provider failed"):
                    await anext(stream)
            else:
                assert [item async for item in stream] == []
            assert closed == [True]
        finally:
            await stream.aclose()
            for inner in retained:
                await inner.aclose()
            reset_permit(token)

    asyncio.run(run())


def test_standard_text_stream_preserves_request_and_filters_completion():
    async def run():
        requests = []

        class Provider(FakeModel):
            async def stream(self, request):
                requests.append(request)
                async for event in super().stream(request):
                    yield event

        request_id = uuid4()
        gateway = ReasoningGateway(UsageProvider(Provider()), request_id)
        with pytest.raises(PermissionError):
            await anext(stream_chat(gateway, question="hello", max_tokens=17))
        assert requests == []
        token = install_permit(issue_unknown_permit("UNKNOWN", request_id))
        try:
            assert [
                text
                async for text in stream_chat(gateway, question="hello", max_tokens=17)
            ] == ["ok"]
        finally:
            reset_permit(token)
        assert requests == [ModelRequest((Message("user", "hello"),), max_tokens=17)]

    asyncio.run(run())


def test_unconfigured_standard_provider_retains_safe_reply():
    from app.commerce_resolution_engine.providers import UnconfiguredModel

    async def run():
        provider = UnconfiguredModel()
        request_id = uuid4()
        gateway = ReasoningGateway(UsageProvider(provider), request_id)
        token = install_permit(issue_unknown_permit("UNKNOWN", request_id))
        try:
            text = "".join(
                [
                    chunk
                    async for chunk in stream_chat(
                        gateway, question="hello", max_tokens=1024
                    )
                ]
            )
        finally:
            reset_permit(token)
        assert (
            text
            == "I don't have verified information to answer that. Please open a support ticket so our team can help."
        )
        await provider.aclose()

    asyncio.run(run())
