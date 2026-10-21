import asyncio
from dataclasses import replace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414 -- pytest fixture

from app.commerce_action_engine.execution.language.readiness import LanguageReadiness
from app.main import create_app

HEALTH = {
    "status": "ok",
    "resolutionContractVersion": 1,
    "dictionaryVersion": 8,
    "intents": 181,
    "generationFingerprint": "release-a",
}


def probe(response, *, fingerprint="", url="http://language:3000"):
    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _: response)
        ) as client:
            return await LanguageReadiness(url, fingerprint).check(client)

    return asyncio.run(run())


@pytest.mark.parametrize(
    "payload,expected",
    [
        (HEALTH, "ready"),
        ({**HEALTH, "resolutionContractVersion": 2}, "incompatible"),
        ({**HEALTH, "resolutionContractVersion": True}, "incompatible"),
        (
            {k: v for k, v in HEALTH.items() if k != "resolutionContractVersion"},
            "incompatible",
        ),
        ({**HEALTH, "intents": 0}, "incompatible"),
        ({**HEALTH, "dictionaryVersion": "8"}, "incompatible"),
    ],
)
def test_health_contract(payload, expected):
    assert probe(httpx.Response(200, json=payload)) == expected


def test_release_pin_and_missing_configuration():
    assert (
        probe(httpx.Response(200, json=HEALTH), fingerprint="release-b")
        == "incompatible"
    )
    assert probe(httpx.Response(200, json=HEALTH), fingerprint="release-a") == "ready"
    assert probe(httpx.Response(200, json=HEALTH), url="") == "not_configured"


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(503),
        httpx.Response(302, headers={"location": "http://other"}),
        httpx.Response(200, content=b"x" * 4097),
    ],
)
def test_failure_responses_are_bounded(response):
    assert probe(response) == "unavailable"


def test_timeout_and_cancellation():
    async def run():
        async def slow(_):
            await asyncio.sleep(10)
            return httpx.Response(200, json=HEALTH)

        async with httpx.AsyncClient(transport=httpx.MockTransport(slow)) as client:
            assert (
                await LanguageReadiness("http://language", timeout=0.01).check(client)
                == "unavailable"
            )
            task = asyncio.create_task(
                LanguageReadiness("http://language").check(client)
            )
            await asyncio.sleep(0)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    asyncio.run(run())


def test_probe_coalesces_and_recovers_after_cached_outage():
    async def run():
        calls = []

        def handle(request):
            calls.append(request)
            assert request.method == "GET" and request.url.path == "/api/ready"
            assert "authorization" not in request.headers
            return (
                httpx.Response(503)
                if len(calls) == 1
                else httpx.Response(200, json=HEALTH)
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            readiness = LanguageReadiness("http://language", cache_seconds=0.01)
            assert (
                await asyncio.gather(*(readiness.check(client) for _ in range(5)))
                == ["unavailable"] * 5
            )
            assert len(calls) == 1
            await asyncio.sleep(0.02)
            assert await readiness.check(client) == "ready"
            assert len(calls) == 2

    asyncio.run(run())


def test_dependency_state_controls_readiness_not_model_availability(
    identity, monkeypatch
):
    config, _, _ = identity
    health = AsyncMock(return_value="ready")
    monkeypatch.setattr(LanguageReadiness, "check", health)
    with TestClient(create_app(config)) as client:
        response = client.get("/ready")
        assert response.status_code == 200
        assert response.json()["recommendations"] == "model-unavailable"
        assert response.json()["components"] == {
            "language": "ready",
            "storage": "not_configured",
        }
        for state in ["unavailable", "incompatible", "not_configured"]:
            health.return_value = state
            response = client.get("/ready")
            assert response.status_code == 503
            assert response.json()["components"]["language"] == state
        assert client.get("/health").json() == {"status": "ok"}
        assert health.await_count == 4


def test_disabled_service_does_not_probe_dependencies(identity, monkeypatch):
    config, _, _ = identity
    health = AsyncMock(side_effect=AssertionError("must not probe"))
    monkeypatch.setattr(LanguageReadiness, "check", health)
    with TestClient(create_app(replace(config, enabled=False))) as client:
        assert client.get("/ready").status_code == 503
        assert client.get("/health").status_code == 200
    health.assert_not_awaited()


def test_storage_failure_stays_unready_with_healthy_language(identity, monkeypatch):
    config, _, _ = identity
    storage = AsyncMock()
    storage.ready.return_value = False
    monkeypatch.setattr(
        "app.commerce_action_engine.application.bootstrap.Store", lambda _: storage
    )
    monkeypatch.setattr(LanguageReadiness, "check", AsyncMock(return_value="ready"))
    with TestClient(
        create_app(replace(config, store_password_file="test-only"))
    ) as client:
        response = client.get("/ready")
        assert response.status_code == 503
        assert response.json()["components"] == {
            "language": "ready",
            "storage": "unavailable",
        }
        storage.ready.side_effect = OSError("private datastore error")
        response = client.get("/ready")
        assert response.status_code == 503
        assert "private" not in response.text
        storage.ready.side_effect = None
        storage.ready.return_value = True
        assert client.get("/ready").status_code == 200
