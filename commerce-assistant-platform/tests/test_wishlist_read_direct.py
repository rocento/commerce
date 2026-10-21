"""Real wishlist language reaches grounded SSE responses with no model calls."""

import asyncio
import importlib
import json
import shutil
import subprocess
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414 -- pytest fixture
from test_enterprise_contracts import (
    context as context,  # noqa: PLC0414 -- pytest fixture
)
from test_shopping import product

from app.commerce_action_engine.application.followups import resolve_reply
from app.commerce_action_engine.execution.language import gate
from app.main import create_app

MESSAGES = (
    "where is my wishlist ?",
    "please show my wish list",
    "list my favorites",
)
SAVED_IDS = [str(UUID(int=number)) for number in range(1, 6)]
AMBIGUOUS_MESSAGES = ("what's my saved?", "what my saved?", "my saved")
COLLECTION_CHOICES = (
    ("wishlist", "wishlist"),
    ("1", "wishlist"),
    ("saved addresses", "locations"),
    ("2", "locations"),
    ("delete wishlist", None),
    ("saved credit cards", None),
    ("wishlist and clear my cart", None),
    ("maybe", None),
)


def real_resolutions(queries):
    if not shutil.which("node"):
        pytest.skip("Node is required for real wishlist language admission")
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import {loadRuntime} from './src/runtime.ts';"
                "import {resolve} from './src/engine.ts';"
                "const runtime=await loadRuntime();"
                "console.log(JSON.stringify(JSON.parse(process.argv[1])"
                ".map(({text,context})=>{"
                "const {debug,evidence,alternatives,...result}="
                "resolve(runtime,text,context);return result;})));"
            ),
            json.dumps(queries),
        ],
        cwd=engine,
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    return [gate.Resolution.model_validate(row) for row in json.loads(result.stdout)]


@pytest.fixture(scope="module")
def wishlist_resolutions():
    resolutions = dict(
        zip(
            MESSAGES,
            real_resolutions([{"text": text} for text in MESSAGES]),
            strict=True,
        )
    )
    for message, resolution in resolutions.items():
        assert resolution.status == "RESOLVED", message
        assert resolution.intent == "VIEW_WISHLIST", message
        assert not resolution.requiresConfirmation, message
    return resolutions


@pytest.fixture(scope="module")
def saved_collection_resolutions():
    keys = [(original, None) for original in AMBIGUOUS_MESSAGES] + [
        (original, reply)
        for original in AMBIGUOUS_MESSAGES
        for reply, _ in COLLECTION_CHOICES
    ]
    queries = [
        {"text": original}
        if reply is None
        else {"text": reply, "context": {"pendingRequest": original}}
        for original, reply in keys
    ]
    resolutions = dict(zip(keys, real_resolutions(queries), strict=True))
    for original in AMBIGUOUS_MESSAGES:
        initial = resolutions[original, None]
        assert initial.status == "NEEDS_CONTEXT"
        assert initial.intent is None
        assert initial.entities == {}
        assert initial.missing == ["savedCollection"]
        assert initial.context["next"]["pendingRequest"] == original
    return resolutions


class FailingModel:
    def __init__(self):
        self.requests = []

    async def generate(self, request):
        self.requests.append(request)
        pytest.fail("A resolved wishlist read called the completion model")

    async def stream(self, request):
        self.requests.append(request)
        pytest.fail("A resolved wishlist read streamed the completion model")
        yield  # pragma: no cover

    async def aclose(self):
        pass


@pytest.mark.parametrize("provider_mode", ["disabled", "failing"])
@pytest.mark.parametrize(
    "case,message,expected",
    [
        (
            "populated",
            MESSAGES[0],
            "You have 5 saved items in your wishlist. Here are up to three:",
        ),
        ("empty", MESSAGES[0], "Your wishlist is empty."),
        ("guest", MESSAGES[0], "Please sign in to view your wishlist."),
        ("unavailable", MESSAGES[0], "Assistant temporarily unavailable"),
        (
            "products_unavailable",
            MESSAGES[2],
            "Your wishlist has 5 saved items, but I couldn't load their current product details.",
        ),
        (
            "single_item",
            MESSAGES[1],
            "You have 1 saved item in your wishlist. Here are up to three:",
        ),
    ],
)
def test_real_wishlist_read_does_not_require_completion(
    identity, monkeypatch, wishlist_resolutions, provider_mode, case, message, expected
):
    config, request_id, headers = identity
    provider = FailingModel()
    monkeypatch.setattr(
        importlib.import_module("app.commerce_action_engine.application.bootstrap"),
        "build_provider",
        lambda _: provider if provider_mode == "failing" else None,
    )
    resolved_messages = []

    async def resolve(url, text):
        resolved_messages.append(text)
        return wishlist_resolutions[text]

    monkeypatch.setattr(gate, "resolve", resolve)
    calls = []

    def commerce(request):
        assert case != "guest", "An anonymous wishlist read reached commerce"
        calls.append((request.method, request.url.path))
        if request.method == "GET" and request.url.path.endswith("/wishlist"):
            assert request.headers["authorization"] == "Bearer wishlist-read"
            if case == "unavailable":
                return httpx.Response(503, json={})
            return httpx.Response(
                200,
                json=[]
                if case == "empty"
                else SAVED_IDS[:1]
                if case == "single_item"
                else SAVED_IDS,
            )
        assert request.method == "POST"
        assert request.url.path == "/v1/assistant-tools/shopper"
        assert request.headers["authorization"] == "Bearer catalog-read"
        body = json.loads(request.content)
        index = len(calls) - 2
        assert body == {
            "name": "get_product",
            "arguments": {"product_id": SAVED_IDS[index]},
        }
        if case == "products_unavailable":
            return httpx.Response(503, json={})
        return httpx.Response(
            200,
            json={
                "products": [
                    product(id=SAVED_IDS[index], name=f"Saved tea {index + 1}")
                ],
                "category": None,
            },
        )

    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={
                **headers(**({"sub": None, "sid": None} if case == "guest" else {})),
                "x-commerce-wishlist-token": "wishlist-read",
                "x-commerce-catalog-token": "catalog-read",
            },
            json={
                "request_id": request_id,
                "message": message,
                "shopping_mode": "shop",
                "conversation_id": str(uuid4()),
            },
        )
    assert response.status_code == 200
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert expected in "".join(event.get("text", "") for event in events)
    assert events[-1]["type"] == "done"
    assert [event["sequence"] for event in events] == list(range(len(events)))
    assert all(event.get("response_source", "R") == "R" for event in events)
    assert resolved_messages == [message]
    assert provider.requests == []
    assert calls == (
        []
        if case == "guest"
        else [("GET", "/v1/assistant-tools/wishlist")]
        + [("POST", "/v1/assistant-tools/shopper")]
        * (
            1
            if case == "single_item"
            else 3
            if case in {"populated", "products_unavailable"}
            else 0
        )
    )
    blocks = [block for event in events for block in event.get("blocks", [])]
    if case in {"populated", "single_item"}:
        assert len(blocks) == 1 and blocks[0]["kind"] == "product_list"
        assert blocks[0]["title"] == "Your wishlist"
        assert [item["id"] for item in blocks[0]["products"]] == SAVED_IDS[
            : 1 if case == "single_item" else 3
        ]
        assert [source["product_id"] for source in blocks[0]["sources"]] == [
            item["id"] for item in blocks[0]["products"]
        ]
    else:
        assert blocks == []
    if case == "guest":
        assert (
            next(event for event in events if event["type"] == "message.delta")["code"]
            == "login_required"
        )
    assert any(event["type"] == "error" for event in events) == (case == "unavailable")


def stream_events(response):
    assert response.status_code == 200
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert events[-1]["type"] == "done"
    assert [event["sequence"] for event in events] == list(range(len(events)))
    assert all(event.get("response_source", "R") == "R" for event in events)
    return events


@pytest.mark.parametrize("original", AMBIGUOUS_MESSAGES)
@pytest.mark.parametrize("reply,collection", COLLECTION_CHOICES)
def test_generic_saved_question_waits_for_a_read_collection_choice(
    identity, monkeypatch, saved_collection_resolutions, original, reply, collection
):
    config, request_id, headers = identity
    provider = FailingModel()
    monkeypatch.setattr(
        importlib.import_module("app.commerce_action_engine.application.bootstrap"),
        "build_provider",
        lambda _: provider,
    )
    resolver_calls = []

    async def resolve(url, text, *, context=None):
        resolver_calls.append((text, context))
        assert context is None or context == {"pendingRequest": original}
        return saved_collection_resolutions[
            original, text if context is not None else None
        ]

    monkeypatch.setattr(gate, "resolve", resolve)
    calls = []

    def commerce(request):
        calls.append((request.method, request.url.path))
        assert request.method == "GET"
        if collection == "wishlist":
            assert request.url.path == "/v1/assistant-tools/wishlist"
            assert request.headers["authorization"] == "Bearer wishlist-read"
            return httpx.Response(200, json=[])
        assert collection == "locations", "An unchosen collection reached commerce"
        assert request.url.path == "/v1/assistant-tools/locations"
        assert request.headers["authorization"] == "Bearer locations-read"
        return httpx.Response(
            200,
            json=[
                {
                    "label": "Home",
                    "is_default": True,
                    "formatted_address": "10 Garden Street",
                }
            ],
        )

    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        first = stream_events(
            client.post(
                "/v1/chat",
                headers=headers(),
                json={
                    "request_id": request_id,
                    "message": original,
                    "shopping_mode": "shop",
                },
            )
        )
        question = next(
            event["clarification"] for event in first if event.get("clarification")
        )
        assert question["original_message"] == original
        assert "wishlist" in question["question"].casefold()
        assert "saved addresses" in question["question"].casefold()
        assert calls == []
        assert provider.requests == []
        response = stream_events(
            client.post(
                "/v1/chat",
                headers={
                    **headers(),
                    "x-commerce-wishlist-token": "wishlist-read",
                    "x-commerce-locations-token": "locations-read",
                },
                json={
                    "request_id": request_id,
                    "message": reply,
                    "shopping_mode": "shop",
                    "clarification": question,
                },
            )
        )
    assert resolver_calls == [
        (original, None),
        (original, None),
        (reply, {"pendingRequest": original}),
    ]
    assert provider.requests == []
    text = "".join(event.get("text", "") for event in response)
    if collection:
        assert calls == [
            (
                "GET",
                "/v1/assistant-tools/wishlist"
                if collection == "wishlist"
                else "/v1/assistant-tools/locations",
            )
        ]
        assert (
            "Your wishlist is empty."
            if collection == "wishlist"
            else "Home (default): 10 Garden Street"
        ) in text
        assert not any(event.get("clarification") for event in response)
    else:
        assert calls == []
        assert text == question["question"]
        assert (
            next(
                event["clarification"]
                for event in response
                if event.get("clarification")
            )
            == question
        )


@pytest.mark.parametrize(
    "changes",
    [
        {"intent": "REMOVE_FROM_WISHLIST", "entities": {"productText": "all"}},
        {"intent": "ACCOUNT_ADDRESS_ADD"},
        {"intent": "VIEW_CART"},
        {"entities": {"productText": "tea"}},
        {"requiresConfirmation": True},
        {"clarificationReply": False},
        {"interpretationText": None},
        {"status": "UNKNOWN"},
    ],
)
def test_saved_collection_resume_accepts_only_verified_read_results(
    context, monkeypatch, saved_collection_resolutions, changes
):
    original = AMBIGUOUS_MESSAGES[0]
    prior = saved_collection_resolutions[original, None]
    calls = []

    async def resolve(url, text, *, context=None):
        calls.append((text, context))
        if context is None:
            return prior
        return gate.Resolution.model_validate(
            {
                "status": "RESOLVED",
                "intent": "VIEW_WISHLIST",
                "message": "Understood.",
                "confidence": 1.0,
                "clarificationReply": True,
                "interpretationText": "show my wishlist",
                **changes,
            }
        )

    monkeypatch.setattr(gate, "resolve", resolve)
    interpretation, message = asyncio.run(
        resolve_reply("http://engine", original, "wishlist", context=context)
    )
    assert message == original
    assert interpretation.route == "clarify"
    assert interpretation.result.message == prior.message
    assert calls == [(original, None), ("wishlist", {"pendingRequest": original})]
