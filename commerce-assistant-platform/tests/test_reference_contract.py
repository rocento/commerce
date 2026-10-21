"""Real Node references survive both Python boundaries without granting authority."""

import asyncio
import json
from copy import deepcopy

import httpx
import pytest
from fastapi.testclient import TestClient
from interpretation_helpers import standard_route
from pydantic import ValidationError
from test_assistant import identity as identity  # noqa: PLC0414
from test_enterprise_contracts import context as context  # noqa: PLC0414
from test_language_fallback import install_provider
from test_language_understanding import interpret

from app.commerce_action_engine.application.interpretation import interpret_resolution
from app.commerce_action_engine.contracts.interpretation import (
    InterpretationFailure,
    InterpretedRequest,
)
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.execution.language.compatibility import (
    adapt_legacy_resolution,
)
from app.main import create_app


@pytest.fixture(scope="module")
def reference_runs():
    return interpret(
        [
            {"messages": ["pls add two product to cart", "fish"]},
            {"messages": ["create an order for two apples and deliver it there"]},
            {
                "messages": ["add it to cart"],
                "context": {
                    "selectedItems": [{"productText": "apple"}, {"productText": "milk"}]
                },
            },
            {
                "messages": ["add it to cart"],
                "context": {"selectedItems": [{"productText": "apple"}]},
            },
            {
                "messages": ["add cheapest one to cart"],
                "context": {"resultSetItems": [{"productText": "apple"}]},
            },
        ]
    )


def test_real_references_preserve_metadata_and_followup(context, reference_runs):
    assert [run[0]["status"] for run in reference_runs] == [
        "NEEDS_CONTEXT",
        "NEEDS_CONTEXT",
        "AMBIGUOUS",
        "RESOLVED",
        "RESOLVED",
    ]
    assert reference_runs[0][1]["status"] == "RESOLVED"
    assert reference_runs[2][0]["references"][0]["candidates"]
    assert reference_runs[4][0]["references"][0]["state"] == "AUTHORITY_LOOKUP_REQUIRED"
    for run in reference_runs:
        for raw in run:
            standalone = adapt_legacy_resolution(raw, context)
            source = gate.Resolution.model_validate(raw)
            decision = interpret_resolution(source, context)
            assert isinstance(standalone, InterpretedRequest)
            assert isinstance(decision.result, InterpretedRequest)
            assert decision.result.references == standalone.references
            assert [
                r.model_dump(exclude_unset=True) for r in source.references
            ] == raw.get("references", [])
            assert decision.result.entities == standalone.entities
            assert decision.result.context_next == standalone.context_next
            assert decision.route == standard_route(source)
            assert not decision.allows_fallback


@pytest.mark.parametrize(
    "change",
    [
        {"state": "AUTHORIZED"},
        {"state": 1},
        {"resolved": "true"},
        {"kind": "capability"},
        {"authorized": True},
        {"selectionStrategy": "x" * 129},
        {"selectionStrategy": {}},
        {"candidates": [{"kind": "PRODUCT_REFERENCE", "value": "apple", "score": 1.1}]},
        {
            "candidates": [
                {"kind": "PRODUCT_REFERENCE", "value": "apple", "score": float("nan")}
            ]
        },
        {
            "candidates": [
                {
                    "kind": "PRODUCT_REFERENCE",
                    "value": "apple",
                    "score": 0.5,
                    "authorized": True,
                }
            ]
        },
        {"candidates": [{}] * 52},
    ],
)
def test_malformed_references_fail_at_both_boundaries(context, reference_runs, change):
    raw = deepcopy(reference_runs[2][0])
    raw["references"][0].update(change)
    result = adapt_legacy_resolution(raw, context)
    assert isinstance(result, InterpretationFailure)
    assert result.code == "invalid_response"
    with pytest.raises(ValidationError):
        gate.Resolution.model_validate(raw)
    source = gate.Resolution.model_validate(reference_runs[2][0])
    decision = interpret_resolution(
        source.model_copy(update={"references": raw["references"]}), context
    )
    assert isinstance(decision.result, InterpretationFailure)
    assert not hasattr(decision, "resolution") and not decision.allows_fallback


@pytest.mark.parametrize("case", [0, 1, 2])
@pytest.mark.parametrize("invalid", [False, True])
def test_chat_reference_clarification_never_calls_model_or_commerce(
    identity, monkeypatch, reference_runs, case, invalid
):
    config, request_id, headers = identity
    provider = install_provider(monkeypatch)
    raw = deepcopy(reference_runs[case][0])
    source = gate.Resolution.model_validate(raw)
    if invalid:
        raw["references"][0]["state"] = "AUTHORIZED"
        source = source.model_copy(update={"references": raw["references"]})

    async def resolve(url, text, **kwargs):
        return source

    monkeypatch.setattr(gate, "resolve", resolve)
    with TestClient(
        create_app(
            config,
            transport=httpx.MockTransport(
                lambda _: pytest.fail("Reference clarification reached commerce")
            ),
        )
    ) as client:
        response = client.post(
            "/v1/chat",
            headers=headers(),
            json={"request_id": request_id, "message": "add it to cart"},
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert response.status_code == 200
    assert events[-1]["type"] == "done"
    assert [e["sequence"] for e in events] == list(range(len(events)))
    if invalid:
        assert any(e.get("code") == "unavailable" for e in events)
    else:
        assert not any(e.get("code") == "unavailable" for e in events)
        assert any(e.get("text") == source.message for e in events)
    assert not provider.requests
    assert provider.closed
    assert not hasattr(gate, "current")


@pytest.mark.parametrize("invalid", [False, True])
def test_http_parser_preserves_or_rejects_reference_metadata(
    monkeypatch, reference_runs, invalid
):
    raw = deepcopy(reference_runs[2][0])
    if invalid:
        raw["references"][0]["state"] = "AUTHORIZED"
    client_type = httpx.AsyncClient
    monkeypatch.setattr(
        gate.httpx,
        "AsyncClient",
        lambda **kwargs: client_type(
            **kwargs,
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json=raw)),
        ),
    )
    result = asyncio.run(gate.resolve("http://language", "add it to cart"))
    if invalid:
        assert isinstance(result, gate.ResolutionFailure)
        assert result.code == "invalid_response"
        assert standard_route(result) == "unavailable"
    else:
        assert result is not None
        assert result.references[0].state == "AMBIGUOUS"
        assert len(result.references[0].candidates) == 2
        assert standard_route(result) == "clarify"
