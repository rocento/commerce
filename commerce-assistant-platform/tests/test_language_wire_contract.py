"""Real Node envelopes retain meaning across HTTP parsing and trusted routing."""

import asyncio
import json
import subprocess
import sys
from copy import deepcopy
from pathlib import Path

import httpx
import pytest
from test_enterprise_contracts import context as context  # noqa: PLC0414

from app.commerce_action_engine.application.interpretation import interpret_resolution
from app.commerce_action_engine.application.interpretation_diagnostics import (
    diagnostic_summary,
)
from app.commerce_action_engine.contracts.interpretation import (
    InterpretationFailure,
    InterpretedRequest,
)
from app.commerce_action_engine.execution.language import gate

ROOT = Path(__file__).resolve().parents[2]
ENGINE = ROOT / "commerce-assistant-platform/app/commerce_language_engine"
HTTP_CLIENT = httpx.AsyncClient
CASES = [
    "add two apples and one milk then checkout",
    "find apple",
    "pls add two product to cart",
    "show me products for camping",
    "I need an anniversary gift for my mother with a budget of $15. What would you choose?",
    "😀 add two apples then checkout",
]


@pytest.fixture(scope="module")
def envelopes():
    output = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import {loadRuntime} from './src/runtime.ts';"
                "import {resolve} from './src/engine.ts';"
                "import {resolutionEnvelope,loadResolutionProvenance} from './src/resolution-wire.ts';"
                "const runtime=await loadRuntime();"
                "const provenance=await loadResolutionProvenance(runtime.dictionary);"
                "const results=JSON.parse(process.argv[1]).map(text=>({text,"
                "response:resolutionEnvelope(resolve(runtime,text),provenance)}));"
                "const prior=resolve(runtime,'pls add two product to cart');"
                "results.push({text:'fish',response:resolutionEnvelope(resolve(runtime,'fish',prior.context.next),provenance)});"
                "console.log(JSON.stringify(results));"
            ),
            json.dumps(CASES),
        ],
        cwd=ENGINE,
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    return json.loads(output.stdout)


def receive(monkeypatch, payload, message="find apples"):
    def respond(request):
        posted = json.loads(request.content)
        assert posted["contractVersion"] == 2
        assert posted["text"] == message
        return httpx.Response(200, json=payload)

    monkeypatch.setattr(
        gate.httpx,
        "AsyncClient",
        lambda **kwargs: HTTP_CLIENT(**kwargs, transport=httpx.MockTransport(respond)),
    )
    return asyncio.run(gate.resolve("http://language", message))


def test_node_envelopes_survive_http_projection_and_trusted_routing(
    monkeypatch, context, envelopes
):
    for fixture in envelopes:
        raw = fixture["response"]["result"]
        source = receive(monkeypatch, fixture["response"], fixture["text"])
        assert isinstance(source, gate.Resolution), fixture["text"]
        decision = interpret_resolution(source, context)
        assert isinstance(decision.result, InterpretedRequest), fixture["text"]
        request = decision.result
        assert request.request_id == context.actor.request_id
        assert request.entities == raw.get("entities", {})
        assert request.confidence.band == raw.get("confidenceLevel")
        assert [a.model_dump() for a in request.actions] == [
            {"itemIndexes": [], **a} for a in raw.get("actions", [])
        ]
        assert [c.model_dump() for c in request.clauses] == raw.get("clauses", [])
        assert [r.model_dump() for r in request.relationships] == raw.get(
            "relationships", []
        )
        assert set(request.slots) == {slot["code"] for slot in raw.get("slots", [])}
        for slot in raw.get("slots", []):
            assert all(
                request.slots[slot["code"]][key] == value for key, value in slot.items()
            )
        for actual, expected in zip(
            request.ambiguities, raw.get("ambiguities", []), strict=True
        ):
            assert all(actual[key] == value for key, value in expected.items())
        assert request.provenance.wire_contract == "language-v2"
        assert (
            request.provenance.generation_fingerprint
            == gate.packaged_generation_fingerprint()
        )
        assert (
            request.provenance.runtime_version
            == fixture["response"]["provenance"]["runtimeVersion"]
        )
        assert decision.allows_fallback == (raw["status"] == "UNKNOWN")
        summary = diagnostic_summary(request, decision.route)
        assert summary["language_release"]["wire_contract"] == "language-v2"
        assert fixture["text"] not in json.dumps(summary)


def test_declared_clause_offsets_handle_non_bmp_text(monkeypatch, context, envelopes):
    fixture = next(row for row in envelopes if row["text"].startswith("😀"))
    source = receive(monkeypatch, fixture["response"], fixture["text"])
    request = interpret_resolution(source, context).result
    assert isinstance(request, InterpretedRequest)
    assert request.provenance.clause_span_encoding == "utf-16-code-units"
    assert request.provenance.evidence_span_encoding == "unicode-code-points"
    assert request.clauses
    text = (
        request.clause_source_text or request.interpretation_text or fixture["text"]
    ).encode("utf-16-le")
    for clause in request.clauses:
        assert (
            text[2 * clause.start : 2 * clause.end].decode("utf-16-le") == clause.text
        )


@pytest.mark.parametrize("version", [1, 3, "2", True, None])
def test_version_is_checked_before_result_projection(
    monkeypatch, context, envelopes, version
):
    raw = deepcopy(envelopes[0]["response"])
    raw["contractVersion"] = version
    raw["result"] = {"status": "UNKNOWN", "message": "Unknown", "confidence": 0.0}
    source = receive(monkeypatch, raw)
    decision = interpret_resolution(source, context)
    assert isinstance(decision.result, InterpretationFailure)
    assert decision.result.code == "incompatible_version"
    assert decision.result.request_id == context.actor.request_id
    assert not decision.allows_fallback and decision.route == "unavailable"


@pytest.mark.parametrize(
    "change",
    [
        "extra_execution_field",
        "unknown_item",
        "unknown_clause",
        "unknown_relationship",
        "invalid_graph_edge",
        "duplicate_slot",
        "invalid_confidence_band",
        "invalid_action_type",
        "unknown_reference",
    ],
)
def test_invalid_semantics_cannot_reach_routing(
    monkeypatch, context, envelopes, change
):
    raw = deepcopy(envelopes[2 if change == "duplicate_slot" else 0]["response"])
    result = raw["result"]
    if change == "extra_execution_field":
        result["authorized"] = True
    elif change == "unknown_item":
        result["actions"][0]["itemIndexes"] = [50]
    elif change == "unknown_clause":
        result["actions"][0]["clauseId"] = "missing"
    elif change == "unknown_relationship":
        result["relationships"][0]["to"] = "missing"
    elif change == "invalid_graph_edge":
        result["graph"]["edges"][0]["to"] = "missing"
    elif change == "duplicate_slot":
        result["slots"].append(deepcopy(result["slots"][0]))
    elif change == "invalid_confidence_band":
        result["confidenceLevel"] = "CERTAIN"
    elif change == "unknown_reference":
        result["references"] = [
            {
                "expression": "IT",
                "kind": "product",
                "resolved": True,
                "target": "item999",
            }
        ]
    else:
        result["actions"][0]["operation"] = ["CREATE_ORDER"]
    decision = interpret_resolution(receive(monkeypatch, raw), context)
    assert isinstance(decision.result, InterpretationFailure)
    assert decision.result.code == "invalid_response"
    assert not decision.allows_fallback and decision.route == "unavailable"


def test_release_skew_is_explicit_and_configuration_cannot_hide_packaged_skew(
    monkeypatch, context, envelopes
):
    raw = deepcopy(envelopes[0]["response"])
    raw["provenance"]["generationFingerprint"] = "a" * 64
    monkeypatch.setenv("AI_LANGUAGE_GENERATION_FINGERPRINT", "a" * 64)
    decision = interpret_resolution(receive(monkeypatch, raw), context)
    assert isinstance(decision.result, InterpretationFailure)
    assert decision.result.code == "incompatible_release"
    assert (
        diagnostic_summary(decision.result, decision.route)["failure_code"]
        == "incompatible_release"
    )
    assert not decision.allows_fallback


def test_legacy_reply_has_explicit_unverified_provenance(
    monkeypatch, context, envelopes
):
    payload = deepcopy(envelopes[0]["response"]["result"])
    payload["request_id"] = "forged"
    source = receive(monkeypatch, payload)
    request = interpret_resolution(source, context).result
    assert isinstance(request, InterpretedRequest)
    assert request.request_id == context.actor.request_id
    assert request.provenance.wire_contract == "legacy-v1"
    assert request.provenance.release_id is None
    assert request.provenance.generation_fingerprint is None


@pytest.mark.parametrize(
    "payload,code",
    [
        (
            {
                "schema_version": "2.0",
                "status": "UNKNOWN",
                "message": "Unknown",
                "confidence": 0.0,
            },
            "incompatible_version",
        ),
        (
            {
                "status": "UNKNOWN",
                "message": "Unknown",
                "confidence": 0.0,
                "result": {},
            },
            "invalid_response",
        ),
    ],
)
def test_legacy_projection_cannot_erase_version_or_damaged_envelope(
    monkeypatch, context, payload, code
):
    decision = interpret_resolution(receive(monkeypatch, payload), context)
    assert isinstance(decision.result, InterpretationFailure)
    assert decision.result.code == code
    assert not decision.allows_fallback


def test_generated_schema_and_node_types_match_python_source():
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "commerce-ops/scripts/contracts/generate_language_resolution_contract.py"),
            "--check",
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )


def test_http_version_rejection_retains_its_failure_code(monkeypatch, context):
    monkeypatch.setattr(
        gate.httpx,
        "AsyncClient",
        lambda **kwargs: HTTP_CLIENT(
            **kwargs,
            transport=httpx.MockTransport(
                lambda _: httpx.Response(400, json={"error": "incompatible_version"})
            ),
        ),
    )
    decision = interpret_resolution(
        asyncio.run(gate.resolve("http://language", "find apples")), context
    )
    assert isinstance(decision.result, InterpretationFailure)
    assert decision.result.code == "incompatible_version"
    assert not decision.allows_fallback


@pytest.mark.parametrize(
    "change",
    ["wrong_source", "beyond_end", "split_surrogate", "missing_canonical_source"],
)
def test_invalid_clause_source_spans_are_rejected(
    monkeypatch, context, envelopes, change
):
    fixture = next(row for row in envelopes if row["text"].startswith("😀"))
    raw = deepcopy(fixture["response"])
    result = raw["result"]
    result["clauseSourceText"] = fixture["text"]
    if change == "wrong_source":
        result["clauseSourceText"] = "another string"
    elif change == "beyond_end":
        result["clauses"][0]["end"] = 3999
    elif change == "split_surrogate":
        result["clauses"][0]["start"] = 1
    else:
        result.pop("clauseSourceText", None)
        result["interpretationText"] = "different original evidence source"
    decision = interpret_resolution(receive(monkeypatch, raw, fixture["text"]), context)
    assert isinstance(decision.result, InterpretationFailure)
    assert decision.result.code == "invalid_response"
    assert not decision.allows_fallback


def test_distinct_clause_source_preserves_original_evidence_source(
    monkeypatch, context, envelopes
):
    fixture = next(row for row in envelopes if row["text"].startswith("😀"))
    raw = deepcopy(fixture["response"])
    raw["result"]["clauseSourceText"] = fixture["text"]
    raw["result"]["interpretationText"] = (
        "Original shopper wording retained for evidence."
    )
    decision = interpret_resolution(receive(monkeypatch, raw, fixture["text"]), context)
    assert isinstance(decision.result, InterpretedRequest)
    assert decision.result.clause_source_text == fixture["text"]
    assert decision.result.interpretation_text == raw["result"]["interpretationText"]


def test_optional_runtime_pin_rejects_different_parser_with_same_dictionary(
    monkeypatch, context, envelopes
):
    raw = deepcopy(envelopes[0]["response"])
    monkeypatch.setenv("AI_LANGUAGE_RUNTIME_SHA256", "a" * 64)
    raw["provenance"]["runtimeVersion"] = "b" * 64
    decision = interpret_resolution(receive(monkeypatch, raw), context)
    assert isinstance(decision.result, InterpretationFailure)
    assert decision.result.code == "incompatible_release"
    assert not decision.allows_fallback


def test_explicit_runtime_pin_cannot_be_bypassed_with_a_legacy_reply(
    monkeypatch, context, envelopes
):
    monkeypatch.setenv(
        "AI_LANGUAGE_RUNTIME_SHA256",
        envelopes[0]["response"]["provenance"]["runtimeVersion"],
    )
    decision = interpret_resolution(
        receive(monkeypatch, envelopes[0]["response"]["result"]), context
    )
    assert isinstance(decision.result, InterpretationFailure)
    assert decision.result.code == "incompatible_release"
