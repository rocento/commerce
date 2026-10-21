"""Transport disconnect and preparation cleanup at the extracted turn boundary."""

import asyncio
import json
from contextvars import ContextVar
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import ClientDisconnect
from test_assistant import identity  # noqa: F401

from app.commerce_action_engine.application.api.chat import register_chat
from app.commerce_action_engine.application.api.events import (
    TurnStreamingResponse,
    serialize_event,
)
from app.commerce_action_engine.application.resources import TurnLease
from app.commerce_action_engine.contracts import AssistantEvent
from app.commerce_resolution_engine.providers.settings import ProviderSettings

ID = UUID(int=1)


def test_sse_preserves_schema_and_escapes_newlines():
    event = AssistantEvent(
        version="1",
        request_id=ID,
        sequence=3,
        type="message.delta",
        text="R\nnew line",
        response_source="R",
    )
    wire = serialize_event(event)
    lines = wire.splitlines()
    assert lines[0] == "event: message.delta"
    assert len(lines) == 3
    assert json.loads(lines[1][6:])["text"] == "R\nnew line"
    assert json.loads(lines[1][6:])["response_source"] == "R"


@pytest.mark.parametrize("spec", ["2.0", "2.4"])
def test_send_failure_closes_in_producer_context_and_releases_once(spec):
    async def scenario():
        semaphore = asyncio.Semaphore(1)
        await semaphore.acquire()
        lease = TurnLease(semaphore)
        closed = []
        marker = ContextVar("turn_test", default=False)

        async def close_resource():
            await asyncio.sleep(0)
            closed.append("resource")

        lease.resources.push_async_callback(close_resource)

        class Turn:
            async def run(self):
                token = marker.set(True)
                try:
                    yield AssistantEvent(
                        version="1",
                        request_id=ID,
                        sequence=0,
                        type="message.delta",
                        text="hello",
                    )
                    await asyncio.sleep(30)
                finally:
                    marker.reset(token)
                    closed.append("generator")
                    await lease.aclose()

            async def aclose(self):
                await lease.aclose()

        async def send(message):
            if message["type"] == "http.response.body":
                raise OSError("disconnected")

        async def receive():
            await asyncio.sleep(30)
            return {"type": "http.disconnect"}

        response = TurnStreamingResponse(Turn())
        with pytest.raises((OSError, ExceptionGroup, ClientDisconnect)):
            await response(
                {"type": "http", "asgi": {"spec_version": spec}}, receive, send
            )
        assert closed == ["generator", "resource"]
        assert marker.get() is False
        await lease.aclose()
        await asyncio.wait_for(semaphore.acquire(), 0.1)
        assert semaphore.locked()  # No double release from generator + response.

    asyncio.run(scenario())


def test_preparation_failure_releases_admission_slot(identity):  # noqa: F811
    config, request_id, headers = identity
    semaphore = asyncio.Semaphore(1)
    closed = []

    async def prepare(body, context, headers, saved, lease):
        async def cleanup():
            closed.append(True)

        lease.resources.push_async_callback(cleanup)
        raise RuntimeError("preparation failed")

    app = FastAPI()
    register_chat(app, config, ProviderSettings(config), semaphore, prepare)
    with TestClient(app, raise_server_exceptions=False) as client:
        for _ in range(2):
            response = client.post(
                "/v1/chat",
                headers=headers(),
                json={"request_id": request_id, "message": "hello"},
            )
            assert response.status_code == 500  # Second request is not stuck at 429.
    assert closed == [True, True]
    assert not semaphore.locked()


def test_cancellation_during_preparation_releases_resources(identity):  # noqa: F811
    import httpx

    config, request_id, headers = identity

    async def scenario():
        semaphore = asyncio.Semaphore(1)
        entered = asyncio.Event()
        closed = []

        async def prepare(body, context, headers, saved, lease):
            async def cleanup():
                await asyncio.sleep(0)
                closed.append(True)

            lease.resources.push_async_callback(cleanup)
            entered.set()
            await asyncio.sleep(30)

        app = FastAPI()
        register_chat(app, config, ProviderSettings(config), semaphore, prepare)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://test"
        ) as client:
            task = asyncio.create_task(
                client.post(
                    "/v1/chat",
                    headers=headers(),
                    json={"request_id": request_id, "message": "hello"},
                )
            )
            await entered.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert closed == [True]
        await asyncio.wait_for(semaphore.acquire(), 0.1)
        assert semaphore.locked()

    asyncio.run(scenario())
