"""Offline Node-to-Python interpretation observations; never dispatch commerce/models."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))


import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "commerce-assistant-platform"))
from app.commerce_action_engine.application.context import TurnContext
from app.commerce_action_engine.application.interpretation import interpret_resolution
from app.commerce_action_engine.contracts.action import ActorContext
from app.commerce_action_engine.execution.language.gate import Resolution

NODE = r"""
import {readFile} from 'node:fs/promises';
import {compile} from './src/compiler.ts';
import {resolve} from './src/engine.ts';
const input=JSON.parse(await readFile('/dev/stdin','utf8'));
const dictionary=JSON.parse(await readFile(input.dictionary,'utf8'));
const compiled=compile(dictionary);
const cases=input.cases.map(c=>{let context={};const turns=c.messages.map(message=>{
 const r=resolve(compiled,message,context);context=r.context.next;
 const {debug,latencyMs,...wire}=r;return {original_text:message,wire};
});return {...c,turns};});
console.log(JSON.stringify({dictionaryVersion:dictionary.version,generationFingerprint:dictionary.generationFingerprint,cases}));
"""


def capture(dataset: Path, dictionary: Path):
    raw = dataset.read_bytes()
    corpus = json.loads(raw)
    cases = corpus["cases"]
    if (
        corpus["language"] != "en"
        or not cases
        or len({c["id"] for c in cases}) != len(cases)
    ):
        raise ValueError("Expected unique English cases")
    if any(
        not c["messages"]
        or any(not isinstance(m, str) or not 0 < len(m) <= 4000 for m in c["messages"])
        for c in cases
    ):
        raise ValueError("Invalid messages")
    request = json.dumps({"dictionary": str(dictionary.resolve()), "cases": cases})
    result = subprocess.run(
        ["node", "--input-type=module", "-e", NODE],
        cwd=ROOT / "commerce-assistant-platform/app/commerce_language_engine",
        input=request,
        capture_output=True,
        text=True,
        check=True,
    )
    observations = json.loads(result.stdout)
    identity = "00000000-0000-0000-0000-000000000001"
    context = TurnContext(
        actor=ActorContext(
            tenant_id=identity,
            store_id=identity,
            session_id=identity,
            request_id=identity,
            channel="evaluation",
        )
    )

    def decision(payload):
        try:
            source = Resolution.model_validate(payload) if payload is not None else None
            interpreted = interpret_resolution(source, context)
            return {
                "standard": interpreted.result.model_dump(mode="json"),
                "route": interpreted.route,
                "allows_fallback": interpreted.allows_fallback,
            }
        except ValueError:
            return {
                "standard": {"code": "invalid_response"},
                "route": "unavailable",
                "allows_fallback": False,
            }

    for case in observations["cases"]:
        for turn in case["turns"]:
            turn.update(decision(turn["wire"]))
            turn.update(
                model_calls=0,
                embedding_calls=0,
                commerce_calls=0,
                dispatch="not_executed_offline",
            )
    base = {
        "status": "UNKNOWN",
        "intent": None,
        "message": "Unknown",
        "confidence": 0.0,
    }
    failures = {
        "unavailable": None,
        "malformed_status": {**base, "status": "INVALID"},
        "malformed_confidence": {**base, "confidence": "0.5"},
        "denied": {**base, "status": "DENIED", "reason": "access_denied"},
        "ambiguous": {**base, "status": "AMBIGUOUS"},
        "needs_context": {**base, "status": "NEEDS_CONTEXT"},
        "unsupported": {**base, "status": "UNSUPPORTED"},
        "unknown": base,
    }
    boundaries = {name: decision(payload) for name, payload in failures.items()}
    assert all(
        not row["allows_fallback"]
        for name, row in boundaries.items()
        if name != "unknown"
    )
    assert boundaries["unknown"]["allows_fallback"]
    sources = sorted(
        (ROOT / "commerce-assistant-platform/app/commerce_language_engine/src").rglob("*.ts")
    ) + [
        ROOT / "commerce-assistant-platform/app/commerce_action_engine" / name
        for name in [
            "application/interpretation.py",
            "execution/language/gate.py",
            "execution/language/compatibility.py",
            "execution/language/routing.py",
            "contracts/interpretation.py",
        ]
    ]
    return {
        "schema_version": 1,
        "dataset_sha256": hashlib.sha256(raw).hexdigest(),
        "dictionary_sha256": hashlib.sha256(dictionary.read_bytes()).hexdigest(),
        "source_hashes": {
            str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sources
        },
        "limitations": [
            "Observed semantics are not gold labels.",
            "Routing eligibility is measured; actual model and commerce execution are disabled.",
            "Application failure fixtures supplement real Node responses; deployment configuration is unverified.",
        ],
        **observations,
        "boundaries": boundaries,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dataset",
        type=Path,
        default=ROOT
        / "rocento-english-understanding/evidence/stage01/requests-v1.json",
    )
    parser.add_argument(
        "--dictionary",
        type=Path,
        default=ROOT / "commerce-assistant-platform/app/commerce_language_engine/data/compiled.json",
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--compare", type=Path)
    args = parser.parse_args()
    protected = [args.dataset, args.dictionary] + (
        [args.compare] if args.compare else []
    )
    if args.output.resolve() in {p.resolve() for p in protected}:
        raise ValueError("Output must not overwrite an input or baseline")
    report = capture(args.dataset, args.dictionary)
    if args.compare:
        before = json.loads(args.compare.read_text())
        if before["dataset_sha256"] != report["dataset_sha256"]:
            raise ValueError("Cannot compare different datasets")
        report["comparison"] = {
            "changed_cases": [
                b["id"]
                for a, b in zip(before["cases"], report["cases"], strict=True)
                if a != b
            ],
            "boundaries_changed": before["boundaries"] != report["boundaries"],
        }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(
        json.dumps(
            {
                "cases": len(report["cases"]),
                "turns": sum(len(c["turns"]) for c in report["cases"]),
                "boundaries": len(report["boundaries"]),
                "comparison": report.get("comparison"),
            }
        )
    )


if __name__ == "__main__":
    main()
