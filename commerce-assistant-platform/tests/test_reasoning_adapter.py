"""Injected capability policy runs before provider calls and preserves closure."""

import asyncio

import pytest

from app.commerce_resolution_engine.adapter import ReasoningAdapter
from app.commerce_resolution_engine.contracts import ModelEvent, ModelRequest


@pytest.mark.parametrize("denied", [False, True])
def test_stream_checks_before_call_and_closes_delegate(denied):
    async def run():
        checks, calls, closed, retained = [], [], [], []
        request = ModelRequest(messages=())

        def check(value, *, streaming):
            checks.append((value, streaming))
            if denied:
                raise PermissionError("denied")

        class Provider:
            def stream(self, value):
                calls.append(value)

                async def events():
                    try:
                        yield ModelEvent("text_delta", text="ok")
                        yield ModelEvent("text_delta", text="later")
                    finally:
                        closed.append(True)

                stream = events()
                retained.append(stream)
                return stream

            async def aclose(self):
                closed.append("provider")

        adapter = ReasoningAdapter(Provider(), check)
        stream = adapter.stream(request)
        if denied:
            with pytest.raises(PermissionError):
                await anext(stream)
            assert calls == closed == []
        else:
            assert (await anext(stream)).text == "ok"
            assert calls == [request]
            await stream.aclose()
            assert closed == [True]
        assert checks == [(request, True)]
        await adapter.aclose()
        assert closed[-1] == "provider"

    asyncio.run(run())
