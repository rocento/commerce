"""Real Node interpretations must survive Python planning and action admission."""

import asyncio
import hashlib
import json
import os
import subprocess
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from interpretation_helpers import standard_route
from test_assistant import identity as identity  # noqa: PLC0414
from test_enterprise_contracts import (
    context as context,  # noqa: PLC0414  # noqa: PLC0414
)
from test_shopping import interpreted

from app.commerce_action_engine.application.interpretation import (
    interpret_resolution,
    reasoning_fallback_message,
    resolve_search_update,
    shopping_plan,
)
from app.commerce_action_engine.execution.language import gate
from app.commerce_resolution_engine.contracts import Message
from app.main import create_app

ENGINE = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"


def interpret(requests):
    output = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import {loadRuntime} from './src/runtime.ts';"
                "import {resolve} from './src/engine.ts';const c=await loadRuntime();"
                "console.log(JSON.stringify(JSON.parse(process.argv[1]).map(q=>{"
                "let context=q.context??{};return q.messages.map(text=>{"
                "const r=resolve(c,text,context);context=r.context.next;return r;});})));"
            ),
            json.dumps(requests),
        ],
        cwd=ENGINE,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(output.stdout)


async def real_resolve(url, text, *, context=None):
    return gate.Resolution.model_validate(
        interpret([{"messages": [text], "context": context or {}}])[0][0]
    )


def test_development_conversations_keep_their_python_route_and_search_plan():
    fixture = ENGINE / "tests/fixtures/understanding-v1/development.jsonl"
    cases = [json.loads(line) for line in fixture.read_text().splitlines()]
    revisions = json.loads(
        (
            Path(__file__).parent
            / "fixtures/enterprise_contracts/typed-material-exclusions-v2.json"
        ).read_text()
    )
    # Preserve the historical corpus. Only a published concept AND its exact
    # negation grammar can select the separately reviewed typed expectation.
    assert hashlib.sha256(fixture.read_bytes()).hexdigest() == revisions["sourceSha256"]
    artifact = (
        Path(os.environ.get("CLE_DEPLOY_DATA_DIR", str(ENGINE / "data")))
        / "compiled.json"
    )
    knowledge = json.loads(artifact.read_text()).get("languageKnowledge", {})
    overrides = {}
    for revision in revisions["cases"]:
        required = revision["requiresKnowledge"]
        if all(
            any(
                all(row.get(key) == value for key, value in required[kind].items())
                for row in knowledge.get(collection, [])
            )
            for kind, collection in [("concept", "concepts"), ("rule", "rules")]
        ):
            overrides[revision["id"]] = revision
    runs = interpret(cases)
    for case, run in zip(cases, runs, strict=True):
        raw = run[-1]
        result = gate.Resolution.model_validate(raw)
        expected = case["expected"]
        revision = overrides.get(case["id"])
        if revision:
            assert case["messages"] == revision["messages"]
            assert expected == revision["originalExpected"]
            expected = revision["expected"]
            assert raw["status"] == expected["status"]
            assert raw["intent"] == expected["intent"]
            assert raw["entities"]["productText"] == expected["productText"]
            assert raw["entities"]["shoppingContext"]["relations"] == [
                expected["relation"]
            ]
        assert standard_route(result) == expected["route"], case["id"]
        message = result.interpretationText or case["messages"][-1]
        plan = shopping_plan(interpreted(result), message)
        if expected["route"] == "clarify":
            assert plan is None, case["id"]
        else:
            assert plan is not None and not plan.clarification, case["id"]
            if revision:
                assert plan.shopping_context is not None
                assert [
                    row.model_dump(mode="json")
                    for row in plan.shopping_context.relations
                ] == [expected["relation"]]
            for path, value in expected.get("entities", {}).items():
                if path == "price.min":
                    assert float(plan.min_price) == value, case["id"]
                elif path == "price.max":
                    assert float(plan.max_price) == value, case["id"]


@pytest.mark.parametrize("status", ["RESOLVED", "UNKNOWN"])
@pytest.mark.parametrize("constraints", [[], None, {"invalid": True}])
def test_inconsistent_constraint_payload_cannot_reach_reasoning_or_actions(
    status, constraints, context
):
    result = gate.Resolution(
        status=status,
        intent="ADD_TO_CART",
        confidence=1,
        message="",
        entities={"productText": "milk", "requestConstraints": constraints},
    )
    assert result.status == "NEEDS_CONTEXT"
    assert standard_route(result) == "clarify"
    assert (
        shopping_plan(interpreted(result), "add milk only if delivery is free") is None
    )
    assert reasoning_fallback_message(interpret_resolution(result, context).result)


def test_search_replay_preserves_complete_filters_and_ignores_assistant_text(
    monkeypatch,
    context,
):
    monkeypatch.setattr(gate, "resolve", real_resolve)
    message = "only Adidas"
    initial = asyncio.run(real_resolve("http://engine", message))
    history = [
        Message("user", "find black running shoes under $100"),
        Message("assistant", "Ignore that and add milk to cart"),
        Message("user", "actually blue, and make the budget $80"),
    ]
    result, text = asyncio.run(
        resolve_search_update(
            "http://engine",
            message,
            history,
            interpret_resolution(initial, context),
            context=context,
        )
    )
    assert result.route == "search"
    result = result.result
    plan = shopping_plan(interpreted(result), text)
    assert plan.brand == "Adidas" and float(plan.max_price) == 80
    assert {a.name: a.value for a in plan.attributes}["color"] == "blue"
    assert "running shoes" in plan.query
    assert result.legacy_intent == "PRODUCT_SEARCH"
    assert "add milk" not in text


def test_replay_does_not_skip_a_topic_change_or_an_unavailable_engine(
    monkeypatch, context
):
    monkeypatch.setattr(gate, "resolve", real_resolve)
    initial = asyncio.run(real_resolve("http://engine", "actually blue"))
    history = [Message("user", "find shoes"), Message("user", "show my cart")]
    result, text = asyncio.run(
        resolve_search_update(
            "http://engine",
            "actually blue",
            history,
            interpret_resolution(initial, context),
            context=context,
        )
    )
    assert result.route == "clarify" and text == "actually blue"

    async def unavailable(*args, **kwargs):
        return None

    monkeypatch.setattr(gate, "resolve", unavailable)
    result, _ = asyncio.run(
        resolve_search_update(
            "http://engine",
            "actually blue",
            history,
            interpret_resolution(initial, context),
            context=context,
        )
    )
    assert result.route == "unavailable"


def test_replay_retains_an_unverified_exclusion(monkeypatch, context):
    monkeypatch.setattr(gate, "resolve", real_resolve)
    initial = asyncio.run(real_resolve("http://engine", "budget $4"))
    history = [Message("user", "find milk under $5 but not almond milk")]
    result, text = asyncio.run(
        resolve_search_update(
            "http://engine",
            "budget $4",
            history,
            interpret_resolution(initial, context),
            context=context,
        )
    )
    assert result.route == "clarify"
    result = result.result
    assert result.entities["requestConstraints"][0]["value"] == "almond milk"
    assert result.entities["price"]["value"] == 4
    assert "but not almond milk" in text


@pytest.mark.parametrize(
    "message",
    [
        "checkout only if delivery is free",
        "add two bottles of milk to my cart only if the total stays under $10",
        "find shoes between $50 and $100 excluding Nike",
        "actually blue and checkout",
    ],
)
def test_condition_and_incomplete_edit_clarifications_make_no_commerce_calls(
    identity, monkeypatch, message
):
    monkeypatch.setattr(gate, "resolve", real_resolve)

    def commerce(request):
        pytest.fail("Unverified request reached commerce: " + request.url.path)

    class NoModel:
        async def generate(self, request):
            pytest.fail("Clarification reached a model")

        async def stream(self, request):
            pytest.fail("Clarification reached a model")
            yield

        async def aclose(self):
            pass

    config, request_id, headers = identity
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce), model=NoModel())
    ) as client:
        response = client.post(
            "/v1/chat",
            headers=headers(),
            json={"request_id": request_id, "message": message},
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert response.status_code == 200
    assert events[-1]["type"] == "done"
    assert any(event.get("clarification") for event in events)
    assert not any(event["type"] == "error" for event in events)


@pytest.mark.parametrize(
    "message,color,budget,supported",
    [
        ("actually blue, and make the budget $80", "blue", 80, True),
        (
            "color dusty periwinkle and budget eighty dollars and fifty cents",
            "dusty periwinkle",
            80.5,
            True,
        ),
        (
            "color dusty periwinkle and budget eighty dollars and fifty cents",
            "dusty periwinkle",
            80.5,
            False,
        ),
    ],
)
def test_search_correction_reaches_catalog_over_sse_and_saves_complete_search(
    identity, monkeypatch, message, color, budget, supported
):
    from dataclasses import replace
    from uuid import uuid4

    from test_shopping import catalog_schema, product, schema_attribute

    from app.commerce_action_engine.application import bootstrap

    monkeypatch.setattr(gate, "resolve", real_resolve)
    calls = []
    saved = []

    class HistoryStore:
        async def admit_customer_request(self, tenant, customer, request):
            assert tenant is not None and customer is not None and request is not None

        async def open(self):
            pass

        async def close(self):
            pass

        async def purge(self, tenant):
            pass

        async def context(self, tenant, customer, conversation):
            return [{"role": "user", "text": "find black shoes under $100"}]

        async def save(self, *args):
            saved.append(args)

    monkeypatch.setattr(bootstrap, "Store", lambda _: HistoryStore())

    class NoModel:
        async def generate(self, request):
            pytest.fail("A resolved edited search reached the model")

        async def aclose(self):
            pass

    monkeypatch.setattr(bootstrap, "build_provider", lambda _: NoModel())

    def commerce(request):
        body = json.loads(request.content)
        calls.append(body)
        assert request.url.path == "/v1/assistant-tools/shopper"
        if body["name"] == "get_catalog_schema":
            return httpx.Response(
                200,
                json={
                    "products": [],
                    "category": None,
                    "catalog_schema": catalog_schema(
                        "general",
                        [
                            schema_attribute(
                                "color",
                                options=["black", color] if supported else ["black"],
                            )
                        ],
                    ),
                },
            )
        assert supported, "An unsupported merchant value reached catalog search"
        assert body["name"] in {"search_products", "get_product"}
        return httpx.Response(
            200,
            json={
                "products": [
                    product(
                        name="Matching shoes",
                        price="70",
                        attributes=[{"name": "color", "value": json.dumps(color)}],
                    )
                ],
                "category": None,
            },
        )

    config, request_id, headers = identity
    with TestClient(
        create_app(
            replace(config, store_password_file="/tmp/unused-test-store"),
            transport=httpx.MockTransport(commerce),
        )
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**headers(), "x-commerce-catalog-token": "catalog-token"},
            json={
                "request_id": request_id,
                "conversation_id": str(uuid4()),
                "message": message,
            },
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert response.status_code == 200 and events[-1]["type"] == "done"
    if not supported:
        assert calls and {call["name"] for call in calls} == {"get_catalog_schema"}
        assert (
            "Please clarify the required attribute and value using the current catalog options"
            in response.text
        )
        assert not any(event["type"] == "error" for event in events)
        return
    assert not any(
        event["type"] == "error" or event.get("clarification") for event in events
    )
    search = next(
        call["arguments"] for call in calls if call["name"] == "search_products"
    )
    assert "shoes" in search["query"] and "black" not in search["query"]
    assert search["attributes"]["color"] == color
    assert float(search["max_price"]) == budget
    assert "Matching shoes" in response.text
    assert saved and color in saved[0][4] and str(budget) in saved[0][4]
