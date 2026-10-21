"""Real HTTP/SSE round trip preserves the evidence reader and issued profile choice."""

import json
from dataclasses import replace
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_compound_clarification import NoModel
from test_domain_evidence import HD, PACK, sample
from test_domain_evidence import admitted as admitted  # noqa: PLC0414
from test_domain_evidence import node_results as node_results  # noqa: PLC0414
from test_shopping_clarification_sse import Questions, pending, text

from app.commerce_action_engine.application import bootstrap, handle_turn
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.platform.settings import Settings


def test_domain_feature_is_configurable_and_requires_database(monkeypatch):
    monkeypatch.setenv("AI_FEATURE_FLAGS", "domain_evidence")
    monkeypatch.delenv("AI_STORE_PASSWORD_FILE", raising=False)
    config = Settings.environment()
    assert "domain_evidence" in config.feature_flags
    with (
        pytest.raises(RuntimeError, match="requires the assistant database"),
        TestClient(bootstrap.create_app(replace(config, store_password_file=None))),
    ):
        pass


def test_profile_question_and_confirmation_use_scoped_evidence_without_a_model(
    identity, admitted, node_results, monkeypatch
):
    config, _, headers = identity
    tenant = UUID(config.tenant_id)
    store = Questions()
    store.pool = object()
    p, schema, facts = sample()
    facts = tuple(f.model_copy(update={"tenant_id": tenant}) for f in facts)
    seen = []

    class Reader:
        async def active_pack(self, scope):
            assert scope == tenant
            seen.append("pack")
            return PACK

        async def product_facts(self, scope, ids):
            assert scope == tenant and ids == (p.id,)
            seen.append("facts")
            return facts

    monkeypatch.setattr(bootstrap, "Store", lambda _: store)
    monkeypatch.setattr(bootstrap, "build_provider", lambda _: NoModel())
    monkeypatch.setattr(bootstrap, "PostgresDomainEvidence", lambda _: Reader())

    def raise_failure(error, request_id):
        raise error

    monkeypatch.setattr(handle_turn, "classify", raise_failure)
    language_calls = []

    async def resolve(url, message):
        language_calls.append(message)
        return gate.Resolution.model_validate(node_results["cases"][0]["result"])

    monkeypatch.setattr(gate, "resolve", resolve)
    searches = []

    def commerce(request):
        payload = json.loads(request.content)
        if payload["name"] == "get_catalog_schema":
            return httpx.Response(
                200,
                json={
                    "products": [],
                    "category": None,
                    "catalog_schema": schema.model_dump(mode="json"),
                    "default_currency": "USD",
                },
            )
        assert payload["name"] == "search_products"
        searches.append(payload["arguments"])
        return httpx.Response(
            200, json={"products": [p.model_dump(mode="json")], "category": None}
        )

    config = replace(
        config,
        store_password_file="test-only",
        feature_flags=config.feature_flags | {"domain_evidence"},
    )
    with TestClient(
        bootstrap.create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        conversation = str(uuid4())

        def send(message, clarification=None):
            request = str(uuid4())
            response = client.post(
                "/v1/chat",
                headers={
                    **headers(request_id=request),
                    "x-commerce-catalog-token": "test-scoped-read",
                },
                json={
                    "request_id": request,
                    "conversation_id": conversation,
                    "message": message,
                    **({"clarification": clarification} if clarification else {}),
                },
            )
            assert response.status_code == 200
            events = [
                json.loads(line[6:])
                for line in response.text.splitlines()
                if line.startswith("data: ")
            ]
            assert events[-1]["type"] == "done" and not any(
                e["type"] == "error" for e in events
            ), events
            return events

        question = pending(send(admitted[0][0]))
        assert HD.label in question["choices"] and not searches
        response = send(HD.label, {**question, "choices": ["forged browser choice"]})
        assert "Verified against this hardware profile" in text(response)
        assert "shotcut.org/FAQ" in text(response)
        assert language_calls == [admitted[0][0]]
        assert searches and all(
            s["max_price"] == "75" and s["currency"] == "USD" for s in searches
        )
        assert "facts" in seen
        assert "expired or were replaced" in text(send(HD.label, question))
