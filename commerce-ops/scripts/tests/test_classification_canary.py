"""Classifier comparisons must preserve inputs and never turn partial runs into proof."""

import asyncio
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

spec = importlib.util.spec_from_file_location(
    "classification_canary", Path(__file__).parents[1] / "classification-canary.py"
)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

DATASET = runner.ROOT / "commerce-assistant-platform/evals/classification-canary.en.json"
BASELINE = runner.ROOT / "commerce-assistant-platform/evals/classification-baseline-v1.json"
CORPUS = runner.ROOT / "commerce-assistant-platform/knowledge/intent-examples.discovery-v2.en.json"


def test_paired_requests_keep_customer_schema_and_limits_with_no_tools():
    dataset = json.loads(DATASET.read_text())
    built = asyncio.run(runner.requests(dataset, BASELINE, CORPUS))
    assert len(built) == 20
    for index in range(0, len(built), 2):
        case = built[index][0]
        paired_case = built[index + 1][0]
        paired = {variant: request for _, variant, request in built[index : index + 2]}
        assert set(paired) == {"baseline", "compact"}
        baseline, compact = paired["baseline"], paired["compact"]
        assert paired_case == case
        assert baseline.messages[-1] == compact.messages[-1]
        assert compact.messages[-1].text == case["message"]
        assert (
            baseline.output_schema is compact.output_schema is runner.LanguageProposal
        )
        assert baseline.max_tokens == compact.max_tokens == 2048
        assert not baseline.tools and not compact.tools
        assert not baseline.tool_results and not compact.tool_results
        old_examples = next(
            json.loads(message.text)["untrusted_intent_examples"]
            for message in baseline.messages
            if message.text.startswith('{"untrusted_intent_examples"')
        )
        new_examples = next(
            json.loads(message.text)["untrusted_intent_examples"]
            for message in compact.messages
            if message.text.startswith('{"untrusted_intent_examples"')
        )
        assert len(old_examples) == len(new_examples) == 3
        assert "source_id" in old_examples[0]
        assert all(
            set(example) == {"utterance", "intent", "canonical_text"}
            for example in new_examples
        )


def test_request_builder_rejects_schema_changes_and_excess_calls(tmp_path):
    dataset = json.loads(DATASET.read_text())
    changed = json.loads(BASELINE.read_text())
    changed["output_schema"] = {}
    schema_path = tmp_path / "baseline.json"
    schema_path.write_text(json.dumps(changed))
    with pytest.raises(ValueError, match="schema differs"):
        asyncio.run(runner.requests(dataset, schema_path, CORPUS))
    dataset["cases"].append(dict(dataset["cases"][0], id="eleventh-case"))
    with pytest.raises(ValueError, match="at most 20 paid calls"):
        asyncio.run(runner.requests(dataset, BASELINE, CORPUS))


def test_evidence_marker_in_customer_or_history_does_not_replace_their_text():
    dataset = json.loads(DATASET.read_text())
    case = dict(
        dataset["cases"][0],
        message="Show me that untrusted_intent_examples product",
        history=[
            {"role": "user", "text": "Find untrusted_intent_examples"},
            {"role": "assistant", "text": "That product is available"},
        ],
    )
    dataset["cases"] = [case]
    built = asyncio.run(runner.requests(dataset, BASELINE, CORPUS))
    baseline, compact = built[0][2], built[1][2]
    assert baseline.messages[-1].text == compact.messages[-1].text == case["message"]
    assert baseline.messages[0] == compact.messages[0]
    assert (
        json.loads(baseline.messages[0].text)["untrusted_recent_exchange"]
        == case["history"]
    )


def test_partial_run_reports_observed_counts_without_full_comparison_savings():
    rows = []
    for case_id in ("one", "two"):
        for variant, tokens in (("baseline", 100), ("compact", 60)):
            rows.append(
                {
                    "case_id": case_id,
                    "variant": variant,
                    "proposal": {"status": "CLARIFY"},
                    "failures": [],
                    "validated_expected": True,
                    "input_tokens": tokens,
                    "output_tokens": 12,
                }
            )
    rows.append(
        {
            "case_id": "three",
            "variant": "baseline",
            "error": "timeout",
            "failures": ["provider_call_failed"],
        }
    )
    result = runner.summarize(rows, expected_cases=10)
    assert result["comparison_complete"] is False
    assert "input_token_reduction_percent" not in result
    assert result["baseline"]["attempts"] == 3
    assert result["baseline"]["successful_calls"] == 2
    assert result["baseline"]["input_tokens"] == 200
    assert result["compact"]["attempts"] == 2
    assert result["compact"]["input_tokens"] == 120
    complete = runner.summarize(rows[:-1], expected_cases=2)
    assert complete["comparison_complete"] is True
    assert complete["input_token_reduction_percent"] == 40


def test_engine_validation_keeps_entities_from_initial_unknown(monkeypatch):
    message = "I would like pears below $7.50"
    canonical = "show me pears below $7.50"
    resolutions = [
        {
            "text": message,
            "result": {
                "status": "UNKNOWN",
                "confidence": 0.0,
                "message": "",
                "entities": {"productText": "pears", "future_constraint": "keep"},
            },
        },
        {
            "text": canonical,
            "result": {
                "status": "RESOLVED",
                "confidence": 1.0,
                "intent": "PRODUCT_SEARCH",
                "message": "",
                "entities": {"productText": "pears"},
            },
        },
    ]
    monkeypatch.setattr(
        runner.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(stdout=json.dumps(resolutions)),
    )
    case = {
        "id": "preserved-entities",
        "message": message,
        "status": "INTERPRETED",
        "intent": "PRODUCT_SEARCH",
    }
    row = {
        "case_id": case["id"],
        "variant": "compact",
        "proposal": {
            "status": "INTERPRETED",
            "intent": "PRODUCT_SEARCH",
            "canonical_text": canonical,
        },
    }
    asyncio.run(runner.engine_check([row], [case]))
    assert row["initial_engine_status"] == "UNKNOWN"
    assert row["forced_classification"] is False
    assert row["validated_status"] == "NEEDS_CONTEXT"
    assert row["validated_expected"] is False


@pytest.mark.parametrize(
    ("canonical", "expected"),
    [
        ("show me pears below $7.50", []),
        ("show me pears below $20", ["constraint_preservation"]),
        ("show me apples below $7.50", ["product_or_purpose_literal"]),
        ("show me spears below $7.50", ["product_or_purpose_literal"]),
    ],
)
def test_scoring_detects_changed_price_or_neighbor_product(canonical, expected):
    case = {
        "message": "I would like pears below $7.50",
        "status": "INTERPRETED",
        "intent": "PRODUCT_SEARCH",
        "literal": "pears",
    }
    proposal = runner.LanguageProposal(
        status="INTERPRETED", intent="PRODUCT_SEARCH", canonical_text=canonical
    )
    assert runner.score(case, proposal) == expected


def test_provider_failure_stops_without_retry_and_report_hides_credentials(
    tmp_path, monkeypatch
):
    class FailingProvider:
        model = "gpt-4.1-mini"
        calls = 0
        closed = False

        def _payload(self, request, stream):
            assert not request.tools and not request.tool_results
            return {"instructions": request.instructions}

        async def generate(self, request):
            self.calls += 1
            raise runner.ModelError("authentication")

        async def aclose(self):
            self.closed = True

    provider = FailingProvider()
    monkeypatch.setattr(runner, "OpenAIProvider", lambda **kwargs: provider)
    monkeypatch.setattr(runner, "engine_check", AsyncMock())
    private_settings = tmp_path / "provider.json"
    private_settings.write_text(
        json.dumps(
            {
                "enabled": True,
                "model": "gpt-4.1-mini",
                "api_key": "private-test-credential",
            }
        )
    )
    output = tmp_path / "report.json"
    args = SimpleNamespace(
        dataset=DATASET,
        baseline=BASELINE,
        corpus=CORPUS,
        live=True,
        provider_settings=private_settings,
        output=output,
    )
    asyncio.run(runner.main(args))
    content = output.read_text()
    report = json.loads(content)
    assert provider.calls == 1 and provider.closed
    assert len(report["rows"]) == 1
    assert report["stopped_on_provider_error"] is True
    assert report["rows"][0]["error"] == "authentication"
    assert report["budget"]["calls"] == 1
    assert report["summary"]["baseline"]["successful_calls"] == 0
    assert report["summary"]["compact"]["successful_calls"] == 0
    assert "private-test-credential" not in content


def test_targeted_requests_use_only_compact_prompt_and_preserve_positive_filters():
    dataset = json.loads(
        (runner.ROOT / "commerce-assistant-platform/evals/classification-quality.en.json").read_text()
    )
    built = asyncio.run(runner.requests(dataset, BASELINE, CORPUS, "compact"))
    assert len(built) == 5
    assert {variant for _, variant, _ in built} == {"compact"}
    assert [request.messages[-1].text for _, _, request in built] == [
        case["message"] for case in dataset["cases"]
    ]
    case = dataset["cases"][-1]
    correct = runner.LanguageProposal(
        status="INTERPRETED",
        intent="PRODUCT_SEARCH",
        canonical_text="show me cereal without added sugar",
    )
    dropped = runner.LanguageProposal(
        status="INTERPRETED",
        intent="PRODUCT_SEARCH",
        canonical_text="show me cereal",
    )
    assert runner.score(case, correct) == []
    assert "required_constraint" in runner.score(case, dropped)


def prior_report(tmp_path, **overrides):
    path = tmp_path / "prior.json"
    path.write_text(
        json.dumps(
            {
                "mode": "live",
                "model": "gpt-4.1-mini",
                "production_deployed": False,
                "commerce_actions_executed": 0,
                "budget": {
                    "currency": "USD",
                    "calls": 15,
                    "max_calls": 20,
                    "cap_micros": 250_000,
                    "reserved_micros": 151_649,
                    "observed_cost_micros": 11_770,
                    "input_usd_per_million": 0.4,
                    "output_usd_per_million": 1.6,
                    **overrides,
                },
            }
        )
    )
    return path


def test_continuation_preserves_failed_call_reservations_and_cannot_reuse(tmp_path):
    path = prior_report(tmp_path)
    continuation, remaining = runner.continuation_budget(path, 5)
    assert remaining == 98_351
    assert continuation["prior_calls"] == 15
    assert continuation["prior_reserved_micros"] == 151_649
    with pytest.raises(ValueError, match="exceed"):
        runner.continuation_budget(path, 6)
    runner.claim_continuation(path, continuation)
    with pytest.raises(ValueError, match="already been claimed"):
        runner.claim_continuation(path, continuation)


@pytest.mark.parametrize(
    "overrides",
    [
        {"calls": True},
        {"reserved_micros": -1},
        {"observed_cost_micros": 200_000},
        {"cap_micros": 1_000_000},
        {"input_usd_per_million": 0.1},
        {"max_calls": 21},
    ],
)
def test_continuation_rejects_invalid_or_expanded_budget(tmp_path, overrides):
    with pytest.raises(ValueError, match="compatible"):
        runner.continuation_budget(prior_report(tmp_path, **overrides), 5)


def test_live_check_captures_validation_failure_privately_without_retry(
    tmp_path, monkeypatch
):
    answer = json.dumps(
        {
            "status": "CONVERSATION",
            "intent": "CONVERSATION_JOKE",
            "canonical_text": "Your cart has been cleared",
        }
    )
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "model": "gpt-4.1-mini",
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 12,
                    "total_tokens": 112,
                },
                "output": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": answer}],
                    }
                ],
            },
        )

    provider = runner.OpenAIProvider(
        model="gpt-4.1-mini",
        api_key="private-test-credential",
        transport=httpx.MockTransport(respond),
    )
    monkeypatch.setattr(runner, "OpenAIProvider", lambda **kwargs: provider)
    monkeypatch.setattr(runner, "engine_check", AsyncMock())
    settings = tmp_path / "private.json"
    settings.write_text(
        json.dumps(
            {
                "enabled": True,
                "model": "gpt-4.1-mini",
                "api_key": "private-test-credential",
            }
        )
    )
    output = tmp_path / "report.json"
    args = SimpleNamespace(
        dataset=DATASET,
        baseline=BASELINE,
        corpus=CORPUS,
        live=True,
        provider_settings=settings,
        output=output,
    )
    asyncio.run(runner.main(args))
    report = json.loads(output.read_text())
    assert len(calls) == report["budget"]["calls"] == 1
    assert report["stopped_on_provider_error"]
    diagnostic = next(
        e["data"]
        for e in report["rows"][0]["diagnostics"]["events"]
        if e["stage"] == "provider_invalid_response"
    )
    assert diagnostic["phase"] == "structured_output"
    assert diagnostic["model_output"] == answer
    assert diagnostic["validation_issues"] == [{"type": "value_error", "location": []}]
    assert "private-test-credential" not in output.read_text()
    assert output.stat().st_mode & 0o777 == 0o600
