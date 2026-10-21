"""Real language -> action -> authenticated fake commerce -> customer answer."""

import json
import subprocess
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from interpretation_helpers import standard_route
from test_assistant import identity as identity  # noqa: PLC0414
from test_cart_pricing import cart

from app.commerce_action_engine.execution.language import gate as language_gate
from app.main import create_app


@pytest.mark.parametrize(
    "message",
    ["total cart items", "total items in my cart", "how many items are in my cart"],
)
def test_cart_summary_journey(identity, monkeypatch, message):
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            "import {loadRuntime} from './src/runtime.ts';import {resolve} from './src/engine.ts';console.log(JSON.stringify(resolve(await loadRuntime(),process.argv[1])));",
            message,
        ],
        cwd=Path(__file__).resolve().parents[1] / "app/commerce_language_engine",
        capture_output=True,
        text=True,
        check=True,
    )
    resolution = language_gate.Resolution.model_validate_json(result.stdout)
    assert standard_route(resolution) == "cart"

    async def resolve(url, text):
        assert text == message
        return resolution

    calls = []

    def commerce(request):
        calls.append(request)
        assert request.method == "GET"
        assert request.url.path == "/v1/assistant-tools/cart"
        assert request.headers["authorization"] == "Bearer cart-read-only"
        return httpx.Response(200, json=cart().model_dump(mode="json"))

    monkeypatch.setattr(language_gate, "resolve", resolve)
    config, request_id, headers = identity
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**headers(), "x-commerce-cart-token": "cart-read-only"},
            json={"request_id": request_id, "message": message},
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert response.status_code == 200 and events[-1]["type"] == "done"
    assert not any(e["type"] == "error" for e in events)
    assert len(calls) == 1
    assert "2 items" in response.text and "10.20 USD" in response.text
    assert "before tax and delivery" in response.text
    assert not any(e.get("response_source") == "L" for e in events)
