"""Opt-in read recovery shares retrieval and does not spend generation budgets."""

import importlib
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_cart_actions import snapshot
from test_language_fallback import install_provider, resolved, unknown
from test_semantic_read_recovery import evidence
from test_semantic_read_recovery import real_reads as real_reads  # noqa: PLC0414

from app.commerce_action_engine.adapters.commerce import CommerceTools
from app.commerce_action_engine.application.handle_turn import HandleTurn
from app.commerce_action_engine.application.interpretation import shopping_plan
from app.commerce_action_engine.execution.language import gate
from app.commerce_resolution_engine.runtime import AgentRuntime
from app.main import create_app


@pytest.mark.parametrize(
    "mode",
    [
        "recovered",
        "generation-budget-exhausted",
        "no-generator",
        "miss",
        "retrieval-failure",
        "zero-embedding-budget",
    ],
)
def test_chat_recovery_placement_reuses_one_retrieval(
    identity, monkeypatch, real_reads, mode
):
    config, request_id, headers = identity
    config = replace(
        config,
        feature_flags=config.feature_flags | {"semantic_read_recovery"},
        semantic_recovery_embedding_budget=0 if mode == "zero-embedding-budget" else 1,
        intent_example_collection="intent_examples",
        store_password_file="test-store",
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
        model_budget_available=AsyncMock(
            return_value=mode != "generation-budget-exhausted"
        ),
    )
    monkeypatch.setattr(
        importlib.import_module("app.commerce_action_engine.application.bootstrap"),
        "Store",
        lambda _: store,
    )
    message = "could ya rustle up three apples under 150 EGP"
    retrieve = AsyncMock(return_value=() if mode == "miss" else (evidence(),))
    if mode == "retrieval-failure":
        retrieve.side_effect = OSError("unavailable")
    old_init = HandleTurn.__init__

    def init(self, prepared, body):
        changes = {"retrieve_intent_examples": retrieve}
        if mode == "no-generator":
            changes.update(tracked={}, runtime=None, has_catalog=False)
        old_init(self, replace(prepared, **changes), body)

    monkeypatch.setattr(HandleTurn, "__init__", init)
    calls = []

    async def resolve(url, text):
        calls.append(text)
        if text == message:
            return unknown()
        if text == "show my cart":
            return resolved()
        assert text == "find three apples under 150 EGP"
        return real_reads

    monkeypatch.setattr(gate, "resolve", resolve)
    cart = AsyncMock(return_value=snapshot())
    monkeypatch.setattr(CommerceTools, "cart", cart)
    plans = []

    async def stream(self, **kwargs):
        plan = shopping_plan(
            kwargs["shopping_handler"].keywords["interpretation"], kwargs["message"]
        )
        assert (
            plan
            and plan.query == "apples"
            and plan.max_price == "150"
            and plan.exclusive_max
        )
        plans.append(plan)
        if False:
            yield

    monkeypatch.setattr(AgentRuntime, "stream", stream)
    with TestClient(
        create_app(
            config,
            transport=httpx.MockTransport(
                lambda _: pytest.fail("Unexpected commerce request")
            ),
        )
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**headers(), "x-commerce-catalog-token": "catalog"},
            json={
                "request_id": request_id,
                "conversation_id": request_id,
                "message": message,
            },
        )
    assert response.status_code == 200 and "event: error" not in response.text, (
        response.text
    )
    retrieve.assert_awaited_once_with(message)
    fallback = mode in {"miss", "retrieval-failure", "zero-embedding-budget"}
    assert len(provider.requests) == int(fallback)
    cart.assert_not_awaited()
    assert len(plans) == int(mode in {"recovered", "generation-budget-exhausted"})
    saved = store.save.await_args.args
    assert saved[4] == message
    assert saved[7]["intent_retrieval"]["embedding_query_attempts"] == 1
    if not fallback:
        store.model_budget_available.assert_not_awaited()
    assert calls == (
        [message] if fallback else [message, "find three apples under 150 EGP"]
    )


def test_embedding_only_bootstrap_without_generation_provider(
    identity, monkeypatch, real_reads
):
    from uuid import UUID

    from test_enterprise_contracts import context as test_context
    from test_intent_examples import INTENT_SOURCE
    from test_knowledge import Embeddings, Index, hit

    from app.commerce_action_engine.application.interpretation import (
        interpret_resolution,
    )
    from app.commerce_action_engine.execution.language.example_policy import (
        resolution_fingerprint,
    )
    from app.commerce_contracts.intent_example import (
        IndexedIntentExample,
        IntentExample,
    )

    config, request_id, headers = identity
    config = replace(
        config,
        feature_flags=config.feature_flags | {"semantic_read_recovery"},
        semantic_recovery_embedding_budget=1,
        intent_example_collection="intent_examples",
        embedding_model="test-embeddings",
        store_password_file="test-store",
    )
    bootstrap = importlib.import_module(
        "app.commerce_action_engine.application.bootstrap"
    )
    monkeypatch.setattr(bootstrap, "build_provider", lambda _: None)
    embeddings = Embeddings()
    embeddings.aclose = AsyncMock()
    monkeypatch.setattr(bootstrap, "build_embedder", lambda _: embeddings)
    message = "could ya rustle up three apples under 150 EGP"
    example = IntentExample.model_validate(
        {
            **evidence().example.model_dump(),
            "utterance": message,
            "canonical_text": "find three apples under 150 EGP",
        }
    )
    fingerprint = resolution_fingerprint(
        interpret_resolution(real_reads, test_context.__wrapped__()).result
    )
    record = IndexedIntentExample(
        **example.model_dump(),
        schema_version="intent-example-v2",
        resolution_fingerprint=fingerprint,
    )
    index = Index(
        [
            hit(
                record.model_dump_json(),
                source=INTENT_SOURCE.model_copy(
                    update={"tenant": UUID(config.tenant_id)}
                ),
            )
        ]
    )
    monkeypatch.setattr(bootstrap, "PostgresKnowledgeIndex", lambda _: index)
    store = SimpleNamespace(
        admit_customer_request=AsyncMock(return_value=None),
        pool=object(),
        open=AsyncMock(),
        close=AsyncMock(),
        purge=AsyncMock(),
        context=AsyncMock(return_value=[]),
        save=AsyncMock(),
        metric=AsyncMock(),
        model_budget_available=AsyncMock(return_value=False),
    )
    monkeypatch.setattr(bootstrap, "Store", lambda _: store)
    resolve = AsyncMock(
        side_effect=lambda url, text: unknown() if text == message else real_reads
    )
    monkeypatch.setattr(gate, "resolve", resolve)
    with TestClient(
        create_app(
            config,
            transport=httpx.MockTransport(
                lambda _: pytest.fail("Unexpected commerce request")
            ),
        )
    ) as client:
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
    assert embeddings.calls == 1
    embeddings.aclose.assert_awaited_once()
    store.model_budget_available.assert_not_awaited()
    assert resolve.await_count == 3
    metadata = store.save.await_args.args[7]
    assert metadata["semantic_read_recovery"]["outcome"] == "search"
    assert "language_fallback" not in metadata
    assert metadata["route_reason"] == "resolved_intent_without_capability"
