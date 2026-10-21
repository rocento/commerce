"""Oldest-order requests override selected context and use the scoped oldest read."""

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
@pytest.mark.parametrize("selected", [None, "00000000-0000-0000-0000-000000000007"])
@pytest.mark.parametrize(
    "message",
    ["pls show me first order", "first order /", "my first order", "earliest order?"],
)
def test_first_order_question_real_language_to_sse(
    identity, monkeypatch, authenticated, has_orders, message, selected
):
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import {buildExpandedDictionary} from './src/generation/dictionary.ts'; import {compile} from './src/compiler.ts'; import {resolve} from './src/engine.ts';"
                "console.log(JSON.stringify(resolve(compile(buildExpandedDictionary()),process.argv[1])));"
            ),
            message,
        ],
        cwd=engine,
        capture_output=True,
        text=True,
        check=True,
    )
    resolution = language_gate.Resolution.model_validate_json(result.stdout)
    assert resolution.status == "RESOLVED" and resolution.intent == "ORDER_HISTORY"
    assert resolution.entities["ordinal"] == 1

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
        assert request.url.params["selection"] == "oldest"
        calls.append(request.url.path)
        return httpx.Response(200, json=[order(1)] if has_orders else [])

    config, request_id, headers = identity
    auth = headers() if authenticated else headers(sub=None, sid=None)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**auth, "x-commerce-tool-token": "scoped-orders"},
            json={
                "request_id": request_id,
                "message": message,
                "order_id": selected,
            },
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
        [1] if authenticated and has_orders else []
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


def test_first_order_read_does_not_reuse_selected_order():
    from uuid import UUID

    from app.commerce_action_engine.actions.orders import order_read

    for message in (
        "show my first order",
        "show my oldest order",
        "show my earliest order",
    ):
        query = order_read(message, {}, UUID(int=7))
        assert query.oldest and query.order_id is None
        assert query.tool_name == "oldest_order_read"
    query = order_read("show my first order #305", {}, UUID(int=7))
    assert query.number == 305 and not query.oldest
