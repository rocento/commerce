"""Offline held-out recovery evaluation; no embeddings, generation or commerce."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))


import argparse
import asyncio
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "commerce-assistant-platform"))
from app.commerce_action_engine.application.context import TurnContext
from app.commerce_action_engine.application.interpretation import interpret_resolution
from app.commerce_action_engine.application.semantic_recovery import recover_read
from app.commerce_action_engine.contracts.action import ActorContext
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.execution.language.semantic_recovery import (
    read_candidates,
)
from app.commerce_contracts.intent_example import IntentEvidence, IntentExample

NODE = """
import {readFileSync} from 'node:fs';
import {loadRuntime} from './app/commerce_language_engine/src/runtime.ts';
import {resolve} from './app/commerce_language_engine/src/engine.ts';
const runtime=await loadRuntime();
console.log(JSON.stringify(JSON.parse(readFileSync(0,'utf8')).map(text=>{
 const start=performance.now();const result=resolve(runtime,text);
 return {text,result,latency_ms:performance.now()-start};
})));
"""


async def evaluate(dataset, training):
    corpus = json.loads(dataset.read_text())
    cases = corpus["cases"]
    if not cases or len({c["id"] for c in cases}) != len(cases):
        raise ValueError("Cases must have unique IDs")
    examples = [
        IntentExample.model_validate(e) for e in json.loads(training.read_text())
    ]
    if {c["message"] for c in cases} & {e.utterance for e in examples}:
        raise ValueError("Holdout overlaps training utterances")
    evidence = tuple(
        IntentEvidence(
            example=e,
            source_id=UUID(int=1),
            revision=1,
            chunk_id="a" * 64,
            validation_fingerprint="b" * 64,
            embedding_score=1.0,
        )
        for e in examples
    )
    candidates = {c["id"]: read_candidates(c["message"], evidence) for c in cases}
    texts = sorted(
        {c["message"] for c in cases}
        | {p.canonical_text for ps in candidates.values() for p in ps}
    )
    raw = await asyncio.to_thread(
        subprocess.run,
        ["node", "--input-type=module", "-e", NODE],
        cwd=ROOT / "commerce-assistant-platform",
        input=json.dumps(texts),
        text=True,
        capture_output=True,
        check=True,
    )
    parsed = {r["text"]: r for r in json.loads(raw.stdout)}
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
    rows = []
    for case in cases:
        message = case["message"]
        original = interpret_resolution(
            gate.Resolution.model_validate(parsed[message]["result"]), context
        )
        calls = []

        async def resolve(_url, text, calls=calls):
            calls.append(text)
            return gate.Resolution.model_validate(parsed[text]["result"])

        start = time.perf_counter()
        with patch.object(gate, "resolve", resolve):
            decision = await recover_read(
                "offline", original, message, evidence, context=context, timeout=3
            )
        elapsed = (time.perf_counter() - start) * 1000
        actual = [p.canonical_text for p in candidates[case["id"]]]
        expected = (
            [] if case["expected_canonical"] is None else [case["expected_canonical"]]
        )
        recovered = original.allows_fallback and decision.result.status == "RESOLVED"
        failures = []
        if actual != expected:
            failures.append("candidate differs from gold label")
        if recovered and (
            expected == [] or decision.route not in {"search", "recommend"}
        ):
            failures.append("incorrect recovery")
        if not original.allows_fallback and decision is not original:
            failures.append("non-UNKNOWN changed")
        if expected and original.allows_fallback and not recovered:
            failures.append("supported UNKNOWN did not recover")
        if recovered and expected:
            gold = interpret_resolution(
                gate.Resolution.model_validate(parsed[expected[0]]["result"]), context
            )
            if decision.result.entities != gold.result.entities:
                failures.append("recovered entities differ from gold canonical request")
        if len(calls) > 1:
            failures.append("multiple candidate validations")
        rows.append(
            {
                **case,
                "actual_candidates": actual,
                "initial_status": original.result.status,
                "final_status": decision.result.status,
                "route": decision.route,
                "recovered": recovered,
                "standard": decision.result.model_dump(mode="json"),
                "validation_calls": len(calls),
                "offline_latency_ms": round(
                    elapsed
                    + parsed[message]["latency_ms"]
                    + sum(parsed[t]["latency_ms"] for t in calls),
                    3,
                ),
                "failures": failures,
            }
        )
    latencies = sorted(r["offline_latency_ms"] for r in rows)
    return {
        "provenance": corpus["provenance"],
        "limitations": [
            "Fixed training evidence injected; retrieval recall and tenant publication are not evaluated.",
            "No HTTP, embedding, generation or commerce calls; latency excludes network and Node startup.",
            "Synthetic holdout in known phrase families is not independent customer accuracy.",
        ],
        "hashes": {
            str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in [
                dataset,
                training,
                Path(__file__),
                ROOT / "commerce-assistant-platform/app/commerce_language_engine/data/compiled.json",
            ]
        },
        "metrics": {
            "cases": len(rows),
            "failed_cases": sum(bool(r["failures"]) for r in rows),
            "eligible_unknown": sum(r["initial_status"] == "UNKNOWN" for r in rows),
            "recovered": sum(r["recovered"] for r in rows),
            "incorrect_recoveries": sum(
                r["recovered"] and r["expected_canonical"] is None for r in rows
            ),
            "clarified": sum(r["final_status"] == "NEEDS_CONTEXT" for r in rows),
            "unchanged_unknown": sum(
                r["initial_status"] == r["final_status"] == "UNKNOWN" for r in rows
            ),
            "offline_latency_p50_ms": latencies[len(rows) // 2],
            "offline_latency_p95_ms": latencies[
                min(len(rows) - 1, int(len(rows) * 0.95))
            ],
        },
        "cases": rows,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dataset",
        type=Path,
        default=ROOT
        / "rocento-english-understanding/evidence/stage05-evaluation/holdout-v1.json",
    )
    parser.add_argument(
        "--training",
        type=Path,
        default=ROOT / "commerce-assistant-platform/knowledge/intent-examples.recovery-v1.en.json",
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.resolve() in {
        args.dataset.resolve(),
        args.training.resolve(),
        Path(__file__).resolve(),
    }:
        parser.error("Output must not overwrite inputs")
    report = asyncio.run(evaluate(args.dataset, args.training))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report["metrics"], indent=2))
    return int(report["metrics"]["failed_cases"] > 0)


if __name__ == "__main__":
    raise SystemExit(main())
