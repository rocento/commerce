"""Real chat orchestration: retrieval -> one proposal -> revalidation -> handler."""

import asyncio
import importlib
import json
import subprocess
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_cart_actions import snapshot
from test_intent_examples import COLLECTION, INTENT_SOURCE, record
from test_knowledge import Embeddings, Index, hit
from test_language_fallback import install_provider, proposal, resolved, unknown

from app.commerce_action_engine.adapters.commerce import CommerceTools
from app.commerce_action_engine.adapters.runtime_knowledge import RuntimeKnowledge
from app.commerce_action_engine.execution.language import gate
from app.commerce_knowledge_rag import Retriever
from app.main import create_app


@pytest.fixture(scope="module")
def checkout_resolutions():
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    output = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import {loadRuntime} from './src/runtime.ts';"
                "import {resolve} from './src/engine.ts';"
                "const runtime=await loadRuntime();"
                "console.log(JSON.stringify(Object.fromEntries("
                "['pleas checkout','please checkout','resume checkout','create order']"
                ".map(text=>[text,resolve(runtime,text)]))));"
            ),
        ],
        cwd=engine,
        capture_output=True,
        text=True,
        check=True,
    )
    return {
        text: gate.Resolution.model_validate(value)
        for text, value in json.loads(output.stdout).items()
    }


@pytest.mark.parametrize(
    "intent,canonical",
    [
        ("START_CHECKOUT", "please checkout"),
        ("CONTINUE_CHECKOUT", "resume checkout"),
        ("CREATE_ORDER", "create order"),
    ],
)
@pytest.mark.parametrize("accepted", [False, True])
def test_typo_checkout_proposal_hands_off_only_after_engine_revalidation(
    identity, monkeypatch, checkout_resolutions, intent, canonical, accepted
):
    config, request_id, headers = identity
    message = "pleas checkout"
    provider = install_provider(monkeypatch, proposal(intent, canonical))
    calls = []

    async def resolve(url, text):
        calls.append(text)
        if text == message:
            result = checkout_resolutions[text]
            assert result.status == "UNKNOWN"
            return result
        result = checkout_resolutions[text]
        assert result.intent == intent
        return (
            result
            if accepted
            else result.model_copy(update={"status": "NEEDS_CONTEXT"})
        )

    monkeypatch.setattr(gate, "resolve", resolve)
    cart = AsyncMock(return_value=snapshot(2))
    change_cart = AsyncMock()
    monkeypatch.setattr(CommerceTools, "cart", cart)
    monkeypatch.setattr(CommerceTools, "change_cart", change_cart)
    with TestClient(
        create_app(
            config,
            transport=httpx.MockTransport(
                lambda _: pytest.fail("Unexpected commerce HTTP")
            ),
        )
    ) as client:
        response = client.post(
            "/v1/chat",
            headers=headers(),
            json={
                "request_id": request_id,
                "message": message,
            },
        )
    assert response.status_code == 200 and "event: error" not in response.text
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    handoffs = [event for event in events if event.get("code") == "open_checkout"]
    assert len(handoffs) == int(accepted)
    if accepted:
        assert handoffs[0]["response_source"] == "L"
        assert handoffs[0]["type"] == "message.delta"
    assert calls == [message, canonical]
    assert len(provider.requests) == 1
    assert cart.await_count == int(accepted)
    change_cart.assert_not_awaited()


@pytest.mark.parametrize(
    "mode", ["retrieved", "empty", "unavailable", "timeout", "disabled", "budget"]
)
@pytest.mark.parametrize("capture_enabled", [True, False])
def test_chat_retrieval_keeps_one_model_attempt_and_existing_cart_read(
    identity, monkeypatch, mode, tmp_path, capture_enabled
):
    monkeypatch.setenv("AI_INTENT_DEBUG_DIR", str(tmp_path))
    config, request_id, headers = identity
    from app.commerce_action_engine.platform import tracking_control

    capture_config = replace(
        config, provider_settings_file=str(tmp_path / "settings" / "provider.json")
    )
    tracking_control.save(capture_config, capture_enabled)
    monkeypatch.setattr(
        importlib.import_module("app.commerce_action_engine.application.handle_turn"),
        "tracking_status",
        lambda _: tracking_control.status(capture_config),
    )
    provider = install_provider(monkeypatch)
    store = SimpleNamespace(
        admit_customer_request=AsyncMock(return_value=None),
        open=AsyncMock(),
        close=AsyncMock(),
        purge=AsyncMock(),
        context=AsyncMock(return_value=[]),
        save=AsyncMock(),
        metric=AsyncMock(),
        save_tracking=AsyncMock(),
        model_budget_available=AsyncMock(return_value=mode != "budget"),
    )
    monkeypatch.setattr(
        importlib.import_module("app.commerce_action_engine.application.bootstrap"),
        "Store",
        lambda _: store,
    )
    message = "Let me peek at my basket"
    calls = []

    async def resolve(url, text):
        calls.append(text)
        return unknown() if text == message else resolved()

    monkeypatch.setattr(gate, "resolve", resolve)
    cart = AsyncMock(return_value=snapshot())
    monkeypatch.setattr(CommerceTools, "cart", cart)
    source = INTENT_SOURCE.model_copy(update={"tenant": UUID(config.tenant_id)})
    embeddings = Embeddings()
    retriever = Retriever(
        embeddings, Index([] if mode == "empty" else [hit(record(), source=source)])
    )
    cancelled = []
    if mode == "unavailable":
        retriever.retrieve = AsyncMock(
            side_effect=OSError("private error must not reach prompt")
        )
    elif mode == "timeout":

        async def slow(*args, **kwargs):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.append(True)

        retriever.retrieve = AsyncMock(side_effect=slow)
    config = replace(
        config,
        intent_example_collection="" if mode == "disabled" else COLLECTION,
        store_password_file="test-store",
        turn_timeout=2 if mode == "timeout" else 25,
    )
    with TestClient(
        create_app(
            config,
            transport=httpx.MockTransport(
                lambda _: pytest.fail("Unexpected commerce HTTP")
            ),
        )
    ) as client:
        client.app.state.agent_runtime.retriever = RuntimeKnowledge(retriever)
        response = client.post(
            "/v1/chat",
            headers=headers(),
            json={
                "request_id": request_id,
                "conversation_id": request_id,
                "message": message,
            },
        )
    assert response.status_code == 200 and "event: error" not in response.text
    if not capture_enabled:
        store.save_tracking.assert_not_awaited()
        assert not (tmp_path / f"{request_id}.json").exists()
        assert not (tmp_path / f"{request_id}.html").exists()
        assert store.save.await_count == int(mode != "budget")
        store.metric.assert_awaited_once()
        return
    capture = json.loads((tmp_path / f"{request_id}.json").read_text())
    stages = {item["stage"]: item["data"] for item in capture["events"]}
    assert stages["customer_request"]["message"] == message
    assert "final_result" in stages
    assert capture["version"] == 2
    terminal = stages["final_result"]
    assert terminal["completion"]["version"] == 1
    assert terminal["measurements"]["trace_id"] == request_id
    assert terminal["measurements"]["request_duration_ms"] >= 0
    assert terminal["provider_totals"]["scope"] == "openai_responses_dispatch"
    store.save_tracking.assert_awaited_once()
    assert store.save_tracking.await_args.args[2]["request_id"] == request_id
    assert (tmp_path / f"{request_id}.html").exists()
    assert "language_model_request" not in response.text
    assert ("language_model_request" in stages) == (mode != "budget")
    if mode != "budget":
        assert stages["language_model_request"]["messages"][-1]["content"] == message
        assert stages["model_proposal"]["intent"] == "VIEW_CART"
    if mode == "retrieved":
        assert (
            stages["language_model_request"]["included_example_refs"]
            == stages["intent_retrieval"]["example_refs"]
        )
        audited_evidence = stages["intent_retrieval"]["examples"][0]
        assert audited_evidence["example"]["intent"] == "VIEW_CART"
        assert audited_evidence["source_id"] == str(source.id)
        assert audited_evidence["revision"] == source.revision
        assert audited_evidence["chunk_id"]
        assert store.save_tracking.await_args.args[2]["events"] == capture["events"]
    assert len(provider.requests) == (0 if mode == "budget" else 1)
    assert cart.await_count == (0 if mode == "budget" else 1)
    assert len(calls) == (1 if mode == "budget" else 3 if mode == "retrieved" else 2)
    if mode == "budget":
        assert embeddings.calls == 0
        assert "model budget is currently unavailable" in response.text
        return
    saved = store.save.await_args.args
    assert saved[4] == message
    if mode in {"disabled", "budget"}:
        assert "intent_retrieval" not in saved[7] and embeddings.calls == 0
    else:
        metadata = saved[7]["intent_retrieval"]
        assert metadata["status"] == ("unavailable" if mode == "timeout" else mode)
        assert metadata["count"] == int(mode == "retrieved")
        assert "utterance" not in str(metadata)
    if mode == "retrieved":
        assert embeddings.calls == 1
        evidence = json.loads(provider.requests[0].messages[0].text)[
            "untrusted_intent_examples"
        ]
        assert evidence == [
            {
                "utterance": audited_evidence["example"]["utterance"],
                "intent": "VIEW_CART",
                "canonical_text": audited_evidence["example"]["canonical_text"],
            }
        ]
        assert (
            json.loads(stages["language_model_request"]["messages"][0]["content"])[
                "untrusted_intent_examples"
            ]
            == evidence
        )
        assert provider.requests[0].messages[-1].text == message
    elif mode != "budget":
        assert len(provider.requests[0].messages) == 1
    if mode == "timeout":
        assert cancelled == [True]


@pytest.mark.parametrize(
    "status",
    ["RESOLVED", "NEEDS_CONTEXT", "AMBIGUOUS", "DENIED", "UNSUPPORTED", "UNAVAILABLE"],
)
def test_retrieval_never_bypasses_language_admission(identity, monkeypatch, status):
    config, request_id, headers = identity
    provider = install_provider(monkeypatch)
    monkeypatch.setattr(
        gate,
        "resolve",
        AsyncMock(
            return_value=None if status == "UNAVAILABLE" else resolved(status=status)
        ),
    )
    monkeypatch.setattr(CommerceTools, "cart", AsyncMock(return_value=snapshot()))
    retriever = Retriever(Embeddings(), Index())
    retriever.retrieve = AsyncMock(
        side_effect=AssertionError("Non-UNKNOWN must not retrieve")
    )
    with TestClient(
        create_app(replace(config, intent_example_collection=COLLECTION))
    ) as client:
        client.app.state.agent_runtime.retriever = RuntimeKnowledge(retriever)
        response = client.post(
            "/v1/chat",
            headers=headers(),
            json={"request_id": request_id, "message": "show my cart"},
        )
    assert response.status_code == 200
    assert provider.requests == []
    retriever.retrieve.assert_not_awaited()
