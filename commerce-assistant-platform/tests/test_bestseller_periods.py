"""Sales-backed calendar requests through real language interpretation and SSE."""

import json
import subprocess
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from interpretation_helpers import standard_route
from test_assistant import identity as identity  # noqa: PLC0414 -- pytest fixture
from test_shopping import interpreted, product

from app.commerce_action_engine.application.interpretation import shopping_plan
from app.commerce_action_engine.execution.language import gate as language_gate
from app.main import create_app


def interpret(message, *, context=None):
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import {loadRuntime} from './src/runtime.ts';import {resolve} from './src/engine.ts';"
                "console.log(JSON.stringify(resolve(await loadRuntime(),process.argv[1],JSON.parse(process.argv[2]))));"
            ),
            message,
            json.dumps(context or {}),
        ],
        cwd=Path(__file__).resolve().parents[1] / "app/commerce_language_engine",
        capture_output=True,
        text=True,
        check=True,
    )
    return language_gate.Resolution.model_validate_json(result.stdout)


@pytest.mark.parametrize(
    "period", ["today", "last_week", "last_month", "last_year", None]
)
@pytest.mark.parametrize("empty", [False, True])
def test_period_bestsellers_sse(identity, monkeypatch, period, empty):
    message = (
        "Recommend best-selling products"
        if period is None
        else "what best seller items " + period.replace("_", " ") + " ?"
    )
    period = period or "last_month"
    resolution = interpret(message)
    assert standard_route(resolution) == "bestsellers"

    async def resolve(url, text):
        assert text == message
        return resolution

    monkeypatch.setattr(language_gate, "resolve", resolve)
    requests = []

    def commerce(request):
        requests.append(request)
        assert request.url.path == "/v1/assistant-tools/shopper"
        assert request.headers["authorization"] == "Bearer catalog-capability"
        assert json.loads(request.content) == {
            "name": "get_bestsellers",
            "arguments": {"period": period},
        }
        return httpx.Response(
            200,
            json={
                "products": []
                if empty
                else [
                    product(1, name="Sales winner", price="7"),
                    product(2, name="Runner up", price="50"),
                ],
                "period": period,
                "start": "2026-01-01T00:00:00Z",
                "end": "2026-02-01T00:00:00Z",
                "timezone": "UTC",
                "metric": "completed_order_units",
                "ranked_limit": 50,
            },
        )

    config, request_id, headers = identity
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**headers(), "x-commerce-catalog-token": "catalog-capability"},
            json={"request_id": request_id, "message": message},
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert response.status_code == 200 and events[-1]["type"] == "done"
    assert not any(e["type"] == "error" for e in events)
    assert len(requests) == 1
    assert "UTC" in response.text
    assert '"response_source":"L"' not in response.text
    if empty:
        assert (
            "No current catalog products with qualifying completed sales"
            in response.text
        )
        assert not any(e["type"] == "content.blocks" for e in events)
    else:
        block = next(e for e in events if e["type"] == "content.blocks")["blocks"][0]
        assert set(block) == {"kind", "title", "products", "sources"}
        cards = block["products"]
        assert [card["name"] for card in cards] == ["Sales winner", "Runner up"]
        assert "units in completed orders" in response.text


def test_general_today_recommendation_is_not_a_sales_claim():
    resolution = interpret("Recommend a product for today")
    assert standard_route(resolution) == "search"
    assert "salesPeriod" not in resolution.entities
    assert (
        shopping_plan(interpreted(resolution), "Recommend a product for today").query
        == "*"
    )


@pytest.mark.parametrize(
    "failure", ["denied", "timeout", "wrong_period", "reversed_dates", "oversized"]
)
def test_sales_read_never_retries_or_falls_back_to_catalog_candidates(failure):
    import asyncio

    from app.commerce_action_engine.adapters.commerce import CommerceTools
    from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable

    calls = []

    def transport(request):
        calls.append(request)
        if failure == "timeout":
            raise httpx.ReadTimeout("unavailable")
        if failure == "denied":
            return httpx.Response(403)
        if failure == "oversized":
            return httpx.Response(200, content=b" " * 131073)
        return httpx.Response(
            200,
            json={
                "products": [],
                "period": "last_year" if failure == "wrong_period" else "today",
                "start": "2026-02-01T00:00:00Z",
                "end": "2026-01-01T00:00:00Z",
                "timezone": "UTC",
                "metric": "completed_order_units",
                "ranked_limit": 50,
            },
        )

    async def run():
        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(transport)
        ) as client:
            reader = CommerceTools(client, "", catalog_capability="catalog")
            with pytest.raises(ToolDenied if failure == "denied" else ToolUnavailable):
                await reader.bestsellers("today")

    asyncio.run(run())
    assert len(calls) == 1
