"""Paired classifier-only canary; synthetic data, no tools or commerce execution."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))


import argparse
import asyncio
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID, uuid4

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "commerce-assistant-platform"))
from app.commerce_action_engine.application.context import TurnContext
from app.commerce_action_engine.application.interpretation import interpret_resolution
from app.commerce_action_engine.application.language_proposals import accept_proposal
from app.commerce_action_engine.contracts.action import ActorContext
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.execution.language.proposals import (
    PROPOSABLE_INTENTS,
    permits_reinterpretation,
)
from app.commerce_contracts.intent_example import IntentEvidence, IntentExample
from app.commerce_contracts.language_proposal import LanguageProposal
from app.commerce_resolution_engine.contracts import (
    Message,
    ModelError,
    ModelResponse,
    Usage,
)
from app.commerce_resolution_engine.diagnostics import begin_debug, finish_debug
from app.commerce_resolution_engine.language import propose_language
from app.commerce_resolution_engine.providers.openai import (
    OpenAIProvider,
    strict_schema,
)
from evals.lab.budget import CappedProvider

NODE = """
import {readFileSync} from 'node:fs';
import {loadRuntime} from './app/commerce_language_engine/src/runtime.ts';
import {resolve} from './app/commerce_language_engine/src/engine.ts';
const runtime=await loadRuntime();
console.log(JSON.stringify(JSON.parse(readFileSync(0,'utf8')).map(text=>({text,result:resolve(runtime,text)}))));
"""


class Capture:
    async def generate(self, request):
        self.request = request
        return ModelResponse(
            "",
            (),
            LanguageProposal(status="CLARIFY", intent=None, canonical_text=None),
            Usage(0, 0, 0),
            "capture",
            "stop",
        )


def score(case, proposal):
    failures = []
    if proposal.status != case["status"] or proposal.intent != case["intent"]:
        failures.append("expected_status_or_intent")
    if proposal.status == "INTERPRETED":
        if not permits_reinterpretation(case["message"], proposal):
            failures.append("constraint_preservation")
        literal = case.get("literal")
        normalized = " ".join((proposal.canonical_text or "").casefold().split())
        if literal and not re.search(
            r"(?<!\w)" + re.escape(" ".join(literal.casefold().split())) + r"(?!\w)",
            normalized,
        ):
            failures.append("product_or_purpose_literal")
        if any(
            " ".join(phrase.casefold().split()) not in normalized
            for phrase in case.get("required_phrases", [])
        ):
            failures.append("required_constraint")
    return failures


async def requests(dataset, baseline_path, corpus_path, variant="paired"):
    if variant not in {"paired", "compact"}:
        raise ValueError("Choose paired or compact requests")
    baseline = json.loads(baseline_path.read_text())
    if baseline["output_schema"] != LanguageProposal.model_json_schema():
        raise ValueError(
            "Baseline schema differs; this comparison must keep the schema fixed"
        )
    rows = dataset["cases"]
    if not 1 <= len(rows) <= 10 or len({row["id"] for row in rows}) != len(rows):
        raise ValueError("Canary needs 1–10 unique cases (at most 20 paid calls)")
    examples = {
        e["id"]: IntentExample.model_validate(e)
        for e in json.loads(corpus_path.read_text())
    }
    evidence = tuple(
        IntentEvidence(
            example=examples[name],
            source_id=UUID(int=1),
            revision=1,
            chunk_id="c" * 64,
            embedding_score=0.9,
            validation_fingerprint="d" * 64,
        )
        for name in dataset["example_ids"]
    )
    full = json.dumps(
        {"untrusted_intent_examples": [e.model_dump(mode="json") for e in evidence]}
    )
    built = []
    for case in rows:
        history = tuple(SimpleNamespace(**row) for row in case.get("history", []))
        capture = Capture()
        await propose_language(
            capture,
            case["message"],
            PROPOSABLE_INTENTS,
            evidence=evidence,
            history=history,
        )
        current = capture.request
        if "untrusted_intent_examples" not in json.loads(current.messages[-2].text):
            raise ValueError(
                "Expected retrieved evidence immediately before the current request"
            )
        inputs = (*current.messages[:-2], Message("user", full), current.messages[-1])
        old = replace(current, instructions=baseline["instructions"], messages=inputs)
        variants = (
            [("baseline", old), ("compact", current)]
            if variant == "paired"
            else [("compact", current)]
        )
        if variant == "paired" and len(built) % 4 == 2:
            variants.reverse()  # Alternate pair order; latency is still only a canary observation.
        for label, request in variants:
            if request.tools or request.tool_results:
                raise ValueError("Classifier canary cannot offer tools")
            built.append((case, label, request))
    return built


def review_payloads(built):
    return [
        {
            "case_id": case["id"],
            "variant": variant,
            "payload": {
                "model": "gpt-4.1-mini",
                "instructions": request.instructions,
                "input": [
                    {"role": m.role, "content": m.text} for m in request.messages
                ],
                "max_output_tokens": request.max_tokens,
                "store": False,
                "stream": False,
                "text": {
                    "format": {
                        "type": "json_schema",
                        "name": "result",
                        "strict": True,
                        "schema": strict_schema(LanguageProposal),
                    }
                },
            },
        }
        for case, variant, request in built
    ]


async def engine_check(rows, cases):
    texts = sorted(
        {
            row["proposal"]["canonical_text"]
            for row in rows
            if row.get("proposal", {}).get("canonical_text")
        }
        | {case["message"] for case in cases}
    )
    completed = await asyncio.to_thread(
        subprocess.run,
        ["node", "--input-type=module", "-e", NODE],
        cwd=ROOT / "commerce-assistant-platform",
        input=json.dumps(texts),
        text=True,
        capture_output=True,
        check=True,
    )
    parsed = {
        row["text"]: gate.Resolution.model_validate(row["result"])
        for row in json.loads(completed.stdout)
    }
    identity = str(UUID(int=1))
    context = TurnContext(
        actor=ActorContext(
            tenant_id=identity,
            store_id=identity,
            session_id=identity,
            request_id=identity,
            channel="evaluation",
        )
    )
    by_id = {case["id"]: case for case in cases}

    async def resolve(_url, text):
        return parsed[text]

    for row in rows:
        case = by_id[row["case_id"]]
        initial = parsed[case["message"]]
        row["initial_engine_status"] = initial.status
        admitted = interpret_resolution(initial, context)
        row["forced_classification"] = not admitted.allows_fallback
        if "proposal" not in row:
            continue
        original = admitted
        if not admitted.allows_fallback:
            # This forced comparison is not a live fallback admission. Retain
            # extracted literals without importing scoped/compound authority.
            original = interpret_resolution(
                gate.Resolution(status="UNKNOWN", confidence=0.0, message=""), context
            )
            original = replace(
                original,
                result=original.result.model_copy(
                    update={"entities": initial.entities}
                ),
            )
        with patch.object(gate, "resolve", resolve):
            decision = await accept_proposal(
                "offline",
                original,
                case["message"],
                LanguageProposal.model_validate(row["proposal"]),
                context=context,
                history=tuple(SimpleNamespace(**h) for h in case.get("history", [])),
            )
        row["validated_status"] = decision.result.status
        row["validated_intent"] = getattr(decision.result, "legacy_intent", None)
        row["validated_route"] = decision.route
        row["validated_expected"] = (
            decision.result.status == case["expected_validated_status"]
            if "expected_validated_status" in case
            else decision.result.status == "NEEDS_CONTEXT"
            if case["status"] == "CLARIFY"
            else decision.result.status == "RESOLVED"
            and row["validated_intent"] == case["intent"]
        )


def summarize(rows, expected_cases):
    result = {}
    for variant in ["baseline", "compact"]:
        selected = [r for r in rows if r["variant"] == variant]
        good = [r for r in selected if "proposal" in r]
        result[variant] = {
            "attempts": len(selected),
            "successful_calls": len(good),
            "proposal_passes": sum(not r["failures"] for r in good),
            "validated_expected": sum(r.get("validated_expected", False) for r in good),
            "input_tokens": sum(r.get("input_tokens", 0) for r in good),
            "output_tokens": sum(r.get("output_tokens", 0) for r in good),
        }
    result["comparison_complete"] = (
        result["baseline"]["successful_calls"]
        == result["compact"]["successful_calls"]
        == expected_cases
    )
    if result["comparison_complete"]:
        before, after = (
            result["baseline"]["input_tokens"],
            result["compact"]["input_tokens"],
        )
        result["input_token_reduction_percent"] = (
            round(100 * (1 - after / before), 2) if before else None
        )
    return result


def continuation_budget(path, planned_calls):
    """Carry forward every prior reservation, including failed-call reservations."""
    if path is None:
        return None, 250_000
    body = path.read_bytes()
    prior = json.loads(body)
    budget = prior.get("budget", {})
    fields = (
        "calls",
        "max_calls",
        "reserved_micros",
        "observed_cost_micros",
        "cap_micros",
    )
    if (
        prior.get("mode") != "live"
        or prior.get("model") != "gpt-4.1-mini"
        or prior.get("production_deployed") is not False
        or prior.get("commerce_actions_executed") != 0
        or budget.get("currency") != "USD"
        or any(type(budget.get(field)) is not int for field in fields)
        or not 0 <= budget["calls"] <= budget["max_calls"] <= 20
        or not 0 <= budget["observed_cost_micros"] <= budget["reserved_micros"]
        or not budget["reserved_micros"] < budget["cap_micros"] <= 250_000
        or budget.get("input_usd_per_million") != 0.40
        or budget.get("output_usd_per_million") != 1.60
    ):
        raise ValueError("Prior report is not a compatible bounded live canary")
    if not 1 <= planned_calls <= budget["max_calls"] - budget["calls"]:
        raise ValueError("Planned calls exceed the remaining approved call budget")
    return {
        "prior_report_sha256": hashlib.sha256(body).hexdigest(),
        "prior_calls": budget["calls"],
        "prior_reserved_micros": budget["reserved_micros"],
        "prior_observed_cost_micros": budget["observed_cost_micros"],
        "max_calls": budget["max_calls"],
        "cap_micros": budget["cap_micros"],
    }, budget["cap_micros"] - budget["reserved_micros"]


def claim_continuation(path, continuation):
    # Exactly one continuation can use this source report in its directory.
    # Keep the claim even after a provider error; failed reservations are not refunded.
    claim = path.parent / (
        ".classification-continuation-" + continuation["prior_report_sha256"] + ".json"
    )
    try:
        descriptor = os.open(claim, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise ValueError(
            "This report's remaining call budget has already been claimed"
        ) from None
    with os.fdopen(descriptor, "w") as handle:
        handle.write(json.dumps(continuation))


def save_report(path, report):
    """Operator reports may contain model output; keep snapshots owner-readable."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.parent / f".{uuid4()}.tmp"
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            handle.write(json.dumps(report, indent=2) + "\n")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


async def main(args):
    dataset = json.loads(args.dataset.read_text())
    variant = getattr(args, "variant", "paired")
    built = await requests(dataset, args.baseline, args.corpus, variant)
    prior_report = getattr(args, "prior_report", None)
    continuation, cap_micros = continuation_budget(prior_report, len(built))
    payloads = review_payloads(built)
    report = {
        "provenance": dataset["provenance"],
        "mode": "live" if args.live else "dry-run",
        "request_variant": variant,
        "rows": [],
        "hashes": {
            p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in [
                args.dataset,
                args.baseline,
                args.corpus,
                ROOT / "commerce-assistant-platform/app/commerce_resolution_engine/language.py",
                ROOT / "commerce-assistant-platform/app/commerce_resolution_engine/providers/openai.py",
                ROOT
                / "commerce-assistant-platform/app/commerce_action_engine/execution/language/proposals.py",
                Path(__file__).resolve(),
            ]
        },
        "limitations": [
            "Authored synthetic checks, including prompt/training controls; not independent customer accuracy.",
            "Fixed approved evidence; retrieval recall and deployed service behavior are not tested.",
            "Classifier forced for comparison; production skips the model for already recognized requests.",
            "Reported input tokens include cached input; billed cache details are not exposed by Usage.",
            "One sample per variant; latency and output variability are not a statistical benchmark.",
        ],
        "production_deployed": False,
        "commerce_actions_executed": 0,
        "budget_plan": {
            "planned_calls": len(built),
            "run_cap_micros": cap_micros,
            "continuation": continuation,
        },
    }
    provider = None
    if args.live:
        stored = json.loads(args.provider_settings.read_text())
        if not stored.get("enabled") or not stored.get("api_key"):
            raise ValueError("Selected provider is not configured and enabled")
        if continuation:
            claim_continuation(prior_report, continuation)
        provider = OpenAIProvider(
            model=stored["model"], api_key=stored["api_key"], timeout=15
        )
        budget = CappedProvider(provider, max_calls=len(built), cap_micros=cap_micros)
        report["model"] = provider.model
    try:
        for index, (case, variant, request) in enumerate(built):
            row = {
                "case_id": case["id"],
                "variant": variant,
                "known_training": case.get("known_training", False),
                "request_hash": hashlib.sha256(
                    json.dumps(
                        payloads[index]["payload"], ensure_ascii=False, sort_keys=True
                    ).encode()
                ).hexdigest(),
                "instruction_characters": len(request.instructions),
                "message_characters": sum(len(m.text) for m in request.messages),
            }
            if args.live:
                start = time.perf_counter()
                capture = begin_debug(
                    str(UUID(int=index + 1)), case["message"], enabled=True
                )
                try:
                    response = await budget.generate(request)
                    if (
                        response.tool_calls
                        or response.finish_reason != "stop"
                        or not isinstance(response.structured, LanguageProposal)
                    ):
                        raise ModelError("invalid_response")
                    proposal = response.structured
                    row.update(
                        proposal=proposal.model_dump(mode="json"),
                        failures=score(case, proposal),
                        input_tokens=response.usage.input_tokens,
                        output_tokens=response.usage.output_tokens,
                        model=response.model,
                    )
                except ModelError as error:
                    row.update(error=error.code, failures=["provider_call_failed"])
                finally:
                    diagnostic = finish_debug(capture)
                    if diagnostic:
                        row["diagnostics"] = diagnostic
                row["latency_ms"] = round((time.perf_counter() - start) * 1000)
            report["rows"].append(row)
            save_report(args.output, report)
            print(
                json.dumps(
                    {
                        "progress": f"{index + 1}/{len(built)}",
                        "case": case["id"],
                        "variant": variant,
                        "error": row.get("error"),
                        "failures": row.get("failures"),
                    }
                ),
                flush=True,
            )
            if row.get("error"):
                report["stopped_on_provider_error"] = True
                break  # Never spend the remaining call budget after a failed connection.
        if args.live:
            report["budget"] = budget.summary()
            report["budget"]["pricing_verified"] = "2026-10-03"
            if continuation:
                report["authorization_budget"] = {
                    **continuation,
                    "calls": continuation["prior_calls"] + budget.calls,
                    "reserved_micros": continuation["prior_reserved_micros"]
                    + budget.reserved_micros,
                    "observed_cost_micros": continuation["prior_observed_cost_micros"]
                    + budget.spent_micros,
                }
            try:
                await engine_check(report["rows"], dataset["cases"])
            except (subprocess.SubprocessError, ValueError, OSError):
                report["engine_check_error"] = (
                    "Offline language-engine validation unavailable"
                )
            report["summary"] = summarize(report["rows"], len(dataset["cases"]))
            if variant == "compact":
                report["summary"]["targeted_check_complete"] = report["summary"][
                    "compact"
                ]["successful_calls"] == len(dataset["cases"])
    finally:
        if provider:
            await provider.aclose()
        save_report(args.output, report)
    print(
        json.dumps(report.get("summary", {"requests_prepared": len(built)}), indent=2)
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dataset",
        type=Path,
        default=ROOT / "commerce-assistant-platform/evals/classification-canary.en.json",
    )
    parser.add_argument(
        "--baseline",
        type=Path,
        default=ROOT / "commerce-assistant-platform/evals/classification-baseline-v1.json",
    )
    parser.add_argument(
        "--corpus",
        type=Path,
        default=ROOT / "commerce-assistant-platform/knowledge/intent-examples.discovery-v2.en.json",
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--provider-settings", type=Path)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--variant", choices=("paired", "compact"), default="paired")
    parser.add_argument(
        "--prior-report",
        type=Path,
        help="Deduct prior calls and all reservations; one continuation per source report",
    )
    args = parser.parse_args()
    if args.live and not args.provider_settings:
        parser.error("--live requires an explicit private --provider-settings file")
    asyncio.run(main(args))
