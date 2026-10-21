"""Held standard routes cannot fall through to a model or commerce operation."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_language_fallback import install_provider, resolved

from app.commerce_action_engine.execution.language import gate
from app.main import create_app


@pytest.mark.parametrize(
    "status", ["DENIED", "UNSUPPORTED", "AMBIGUOUS", "NEEDS_CONTEXT"]
)
def test_held_write_request_uses_standard_route_without_side_effects(
    identity, monkeypatch, status
):
    config, request_id, headers = identity
    provider = install_provider(monkeypatch)

    async def resolve(url, message):
        return resolved(status=status, intent="ADD_TO_CART", message="Held request")

    def legacy_route(*args):
        pytest.fail("Live route selection must not call the legacy wire router")

    monkeypatch.setattr(gate, "resolve", resolve)
    monkeypatch.setattr(gate, "route", legacy_route, raising=False)
    with TestClient(
        create_app(
            config,
            transport=httpx.MockTransport(
                lambda _: pytest.fail("Held interpretation reached commerce")
            ),
        )
    ) as client:
        response = client.post(
            "/v1/chat",
            headers=headers(),
            json={"request_id": request_id, "message": "add shoes to cart"},
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert response.status_code == 200
    assert events[-1]["type"] == "done"
    assert [event["sequence"] for event in events] == list(range(len(events)))
    assert not provider.requests
    assert provider.closed
    assert not hasattr(gate, "current")
    if status == "DENIED":
        assert any(event.get("code") == "support_required" for event in events)
    else:
        assert any("Held request" in event.get("text", "") for event in events)
