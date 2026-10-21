"""The screenshot's tracking question reaches an authorized read without a model."""

import json
import subprocess
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414 -- pytest fixture
from test_order_read_routes import order

from app.commerce_action_engine.execution.language import gate as language_gate
from app.main import create_app


@pytest.mark.parametrize(
    "authenticated,has_orders", [(True, True), (True, False), (False, True)]
)
def test_latest_order_question_real_language_to_sse(
    identity, monkeypatch, authenticated, has_orders
):
    message = "Where is my last order?"
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import {loadRuntime} from './src/runtime.ts'; import {resolve} from './src/engine.ts';"
                "console.log(JSON.stringify(resolve(await loadRuntime(),process.argv[1])));"
            ),
            message,
        ],
        cwd=engine,
        capture_output=True,
        text=True,
        check=True,
    )
    resolution = language_gate.Resolution.model_validate_json(result.stdout)
    assert resolution.status == "RESOLVED" and resolution.intent == "TRACK_ORDER"
    assert resolution.entities["orderSelection"] == "LATEST"

    async def resolve(url, text):
        assert text == message
        return resolution

    monkeypatch.setattr(language_gate, "resolve", resolve)
    calls = []

    def commerce(request):
        assert authenticated
        assert request.method == "GET"
        assert request.url.path == "/v1/assistant-tools/orders"
        assert request.headers["authorization"] == "Bearer scoped-orders"
        calls.append(request.url.path)
        return httpx.Response(200, json=[order(305), order(304)] if has_orders else [])

    config, request_id, headers = identity
    auth = headers() if authenticated else headers(sub=None, sid=None)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**auth, "x-commerce-tool-token": "scoped-orders"},
            json={"request_id": request_id, "message": message},
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert response.status_code == 200 and events[-1]["type"] == "done"
    assert not any(event["type"] == "error" for event in events)
    cards = [event["order"] for event in events if event["type"] == "card.order"]
    assert [card["number"] for card in cards] == (
        [305] if authenticated and has_orders else []
    )
    assert len(calls) == int(authenticated)
    expected = (
        (
            "Current status: in transit"
            if has_orders
            else "You don't have any orders yet"
        )
        if authenticated
        else "Please sign in"
    )
    assert expected in response.text
    assert '"response_source":"L"' not in response.text
