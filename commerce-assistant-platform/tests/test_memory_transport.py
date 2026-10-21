"""Memory extraction preserves scoped transport and optional request-local behavior."""

import asyncio
import json
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import httpx
import pytest
from test_assistant import identity  # noqa: F401 -- shared authentication fixture
from test_personalization import snapshot, view

from app.commerce_action_engine.actions.shopping import personalization as m
from app.commerce_action_engine.adapters.memory import MemoryTransport


def test_domain_uses_typed_port_and_original_revision():
    async def run():
        memory = SimpleNamespace(load=AsyncMock(return_value=view()), save=AsyncMock())
        memory.load.return_value.context.revision = 17
        conversation = UUID(int=7)
        token = await m.begin(memory, conversation, "Find shoes")
        try:
            session = m.current()
            assert session is not None
            assert not hasattr(session, "client") and not hasattr(session, "token")
            await m.flush()
            memory.save.assert_not_awaited()
            session.snapshot = snapshot()
            await m.flush()
            memory.load.assert_awaited_once_with(conversation)
            memory.save.assert_awaited_once_with(conversation, 17, session.snapshot)
            assert session.view.context.revision == 17
        finally:
            m.reset(token)
        assert m.current() is None
        await m.flush()
        assert memory.save.await_count == 1

    asyncio.run(run())


@pytest.mark.parametrize(
    "missing", ["gateway", "conversation", "unavailable", "disabled"]
)
def test_missing_or_disabled_memory_creates_no_session(missing):
    async def run():
        data = view()
        data.enabled = missing != "disabled"
        memory = SimpleNamespace(
            load=AsyncMock(return_value=None if missing == "unavailable" else data),
            save=AsyncMock(),
        )
        token = await m.begin(
            None if missing == "gateway" else memory,
            None if missing == "conversation" else UUID(int=1),
            "shoes",
        )
        try:
            assert m.current() is None
            await m.flush()
            memory.save.assert_not_awaited()
            if missing in {"gateway", "conversation"}:
                memory.load.assert_not_awaited()
        finally:
            m.reset(token)

    asyncio.run(run())


def test_exact_wire_contract_and_revision_are_preserved():
    async def run():
        requests = []
        data = view()
        data.context.revision = 23

        def backend(request):
            requests.append(request)
            assert request.url.path == "/v1/assistant-tools/memory"
            assert request.headers["Authorization"] == "Bearer scoped-capability"
            assert request.headers["X-Commerce-Request"] == "1"
            assert set(request.extensions["timeout"].values()) == {2}
            return httpx.Response(200, json=data.model_dump(mode="json"))

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            token = await m.begin(
                MemoryTransport(client, "scoped-capability"), UUID(int=7), "Find shoes"
            )
            try:
                m.current().snapshot = snapshot()
                await m.flush()
            finally:
                m.reset(token)
        assert [r.method for r in requests] == ["GET", "PUT"]
        assert dict(requests[0].url.params) == {"conversation_id": str(UUID(int=7))}
        assert json.loads(requests[1].content) == {
            "conversation_id": str(UUID(int=7)),
            "expected_revision": 23,
            "snapshot": snapshot().model_dump(mode="json"),
        }

    asyncio.run(run())


@pytest.mark.parametrize(
    "failure", [403, 409, 410, 503, "offline", "timeout", "json", "schema", "oversize"]
)
def test_failed_reads_are_optional_without_retry(failure):
    async def run():
        calls = []

        def backend(request):
            calls.append(request)
            if failure == "offline":
                raise httpx.ConnectError("offline")
            if failure == "timeout":
                raise httpx.ReadTimeout("slow")
            if isinstance(failure, int):
                return httpx.Response(failure)
            if failure == "json":
                return httpx.Response(200, content=b"broken")
            if failure == "schema":
                return httpx.Response(200, json={"enabled": True})
            return httpx.Response(
                200, content=view().model_dump_json().encode() + b" " * 65536
            )

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            token = await m.begin(
                MemoryTransport(client, "capability"), UUID(int=7), "shoes"
            )
            try:
                assert m.current() is None
            finally:
                m.reset(token)
        assert len(calls) == 1

    asyncio.run(run())


def test_exact_read_size_limit_is_accepted():
    async def run():
        content = view().model_dump_json().encode()
        content += b" " * (65536 - len(content))
        async with httpx.AsyncClient(
            base_url="http://commerce",
            transport=httpx.MockTransport(
                lambda _: httpx.Response(200, content=content)
            ),
        ) as client:
            assert (
                await MemoryTransport(client, "capability").load(UUID(int=7)) == view()
            )

    asyncio.run(run())


@pytest.mark.parametrize("failure", [403, 409, 410, 503, "timeout"])
def test_failed_saves_never_retry_or_advance_revision(failure):
    async def run():
        writes = []
        data = view()
        data.context.revision = 23

        def backend(request):
            if request.method == "GET":
                return httpx.Response(200, json=data.model_dump(mode="json"))
            writes.append(json.loads(request.content))
            if failure == "timeout":
                raise httpx.ReadTimeout("slow")
            return httpx.Response(failure)

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            token = await m.begin(
                MemoryTransport(client, "capability"), UUID(int=7), "shoes"
            )
            try:
                m.current().snapshot = snapshot()
                await m.flush()
                assert m.current().view.context.revision == 23
            finally:
                m.reset(token)
        assert len(writes) == 1 and writes[0]["expected_revision"] == 23

    asyncio.run(run())


def test_empty_capability_performs_no_http():
    async def run():
        def backend(_):
            pytest.fail("Memory request without capability")

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            memory = MemoryTransport(client, "")
            assert await memory.load(UUID(int=7)) is None
            await memory.save(UUID(int=7), 0, snapshot())

    asyncio.run(run())


@pytest.mark.parametrize("operation", ["load", "save"])
def test_cancellation_propagates(operation):
    async def run():
        entered = asyncio.Event()
        calls = []

        async def backend(request):
            calls.append(request)
            entered.set()
            await asyncio.Event().wait()

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            memory = MemoryTransport(client, "capability")
            task = asyncio.create_task(
                memory.load(UUID(int=7))
                if operation == "load"
                else memory.save(UUID(int=7), 0, snapshot())
            )
            await entered.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert len(calls) == 1

    asyncio.run(run())


def test_concurrent_capabilities_and_revisions_stay_isolated():
    async def run():
        writes = []

        async def backend(request):
            await asyncio.sleep(0)
            if request.method == "GET":
                data = view()
                data.context.revision = int(
                    request.headers["Authorization"].split()[-1]
                )
                return httpx.Response(200, json=data.model_dump(mode="json"))
            writes.append(
                (request.headers["Authorization"], json.loads(request.content))
            )
            return httpx.Response(204)

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:

            async def turn(number):
                token = await m.begin(
                    MemoryTransport(client, str(number)), UUID(int=number), "shoes"
                )
                try:
                    await asyncio.sleep(0)
                    m.current().snapshot = snapshot()
                    await m.flush()
                finally:
                    m.reset(token)
                assert m.current() is None

            await asyncio.gather(turn(1), turn(2))
        assert sorted(
            (header, body["conversation_id"], body["expected_revision"])
            for header, body in writes
        ) == [(f"Bearer {number}", str(UUID(int=number)), number) for number in (1, 2)]

    asyncio.run(run())


@pytest.mark.parametrize(
    "module", ["actions.shopping.personalization", "adapters.memory"]
)
def test_fresh_imports_do_not_load_application_or_model_runtime(module):
    forbidden = [
        "app.commerce_action_engine.application",
        "app.commerce_action_engine.platform",
        "app.commerce_resolution_engine.runtime",
        "app.commerce_resolution_engine.providers",
    ]
    if module.startswith("actions"):
        forbidden += ["httpx", "app.commerce_action_engine.adapters"]
    script = f"""
import importlib, sys
importlib.import_module('app.commerce_action_engine.{module}')
for prefix in {forbidden!r}:
    assert not any(name == prefix or name.startswith(prefix + '.') for name in sys.modules), prefix
"""
    subprocess.run(
        [sys.executable, "-c", script], check=True, capture_output=True, text=True
    )


@pytest.mark.parametrize("available", [True, False])
def test_chat_composes_memory_and_finishes_when_optional_service_fails(
    request, monkeypatch, available
):
    from fastapi.testclient import TestClient

    from app.commerce_action_engine.execution.language import gate
    from app.main import create_app

    async def unavailable_language(url, text):
        return None

    monkeypatch.setattr(gate, "resolve", unavailable_language)
    config, request_id, headers = request.getfixturevalue("identity")
    app = create_app(config)
    seen = []
    sessions = []
    original_begin = m.begin

    async def begin(memory, conversation, message, bypass=False):
        token = await original_begin(memory, conversation, message, bypass)
        sessions.append(m.current())
        return token

    monkeypatch.setattr(m, "begin", begin)

    def backend(request):
        seen.append(request)
        assert request.headers["Authorization"] == "Bearer memory-capability"
        return (
            httpx.Response(200, json=view().model_dump(mode="json"))
            if available
            else httpx.Response(503)
        )

    with TestClient(app) as client:
        original_client = app.state.commerce
        app.state.commerce = httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        )
        try:
            response = client.post(
                "/v1/chat",
                headers={
                    **headers(),
                    "X-Commerce-Memory-Token": "memory-capability",
                    "X-Commerce-Personalize": "0",
                },
                json={
                    "request_id": request_id,
                    "conversation_id": str(UUID(int=7)),
                    "message": "find shoes",
                },
            )
        finally:
            client.portal.call(app.state.commerce.aclose)
            app.state.commerce = original_client
    assert response.status_code == 200
    assert "event: done" in response.text and "event: error" not in response.text
    assert len(seen) == 1
    assert dict(seen[0].url.params) == {"conversation_id": str(UUID(int=7))}
    assert len(sessions) == 1
    assert (sessions[0] is not None) is available
    if available:
        assert sessions[0].bypass is True
