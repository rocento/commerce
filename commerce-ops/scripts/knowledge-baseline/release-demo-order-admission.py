"""Adjudicate Phase 0 write-route flags without relabeling the frozen benchmark."""

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "commerce-assistant-platform"), str(ROOT / "commerce-assistant-platform/tests")]

import httpx
import pytest
from app.commerce_action_engine.application.interpretation import interpret_resolution
from app.commerce_action_engine.execution.language import gate
from app.main import create_app
from fastapi.testclient import TestClient
from test_assistant import identity
from test_enterprise_contracts import context
from test_language_fallback import install_provider


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine-root", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("Completed evidence is immutable; select a new path")
    baseline = ROOT / "output/enterprise-knowledge-phase0-20261010/offline-language-replay.json"
    rows = [row for row in json.loads(baseline.read_text())["rows"] if any(f["code"] == "no_unrequested_write" for f in row["failures"])]
    program = """
import {readFileSync} from 'node:fs';
import {compile} from './src/compiler.ts';
import {resolve} from './src/engine.ts';
import {runtimeSha256} from './src/runtime-identity.ts';
const input=JSON.parse(readFileSync(0,'utf8'));
const engine=compile(JSON.parse(readFileSync(input.candidate,'utf8')));
console.log(JSON.stringify({runtimeSha256:await runtimeSha256(),rows:input.texts.map(text=>resolve(engine,text))}));
"""
    resolved = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", program], cwd=args.engine_root, input=json.dumps({"candidate": str(args.candidate.resolve()), "texts": [row["text"] for row in rows]}).encode()))
    wires = resolved["rows"]
    results = []
    for source, wire in zip(rows, wires, strict=True):
        resolution = gate.Resolution.model_validate(wire)
        decision = interpret_resolution(resolution, context.__wrapped__())
        commerce_calls = []
        with pytest.MonkeyPatch.context() as patch:
            config, request_id, headers = identity.__wrapped__(patch)
            provider = install_provider(patch)

            async def resolve(url, text, resolution=resolution):
                return resolution

            def forbidden(request, commerce_calls=commerce_calls):
                commerce_calls.append(request.url.path)
                raise AssertionError("Unrequested action reached commerce")

            patch.setattr(gate, "resolve", resolve)
            with TestClient(create_app(config, transport=httpx.MockTransport(forbidden))) as client:
                response = client.post("/v1/chat", headers=headers(), json={"request_id": request_id, "message": source["text"]})
            events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
        execution_safe = response.status_code == 200 and events[-1]["type"] == "done" and not commerce_calls and not provider.requests and decision.route == "clarify" and not decision.allows_fallback
        results.append({"caseId": source["caseId"], "text": source["text"], "priorIntent": source["intent"], "priorStatus": source["status"],
                        "candidateIntent": wire.get("intent"), "candidateStatus": wire["status"], "route": decision.route,
                        "modelCalls": len(provider.requests), "commerceCalls": commerce_calls, "executionGuardPass": execution_safe,
                        "response": "".join(event.get("text", "") for event in events),
                        "semanticPass": wire.get("intent") in {"CHECK_DELIVERY", "DELIVERY_TIME", "DELIVERY_DATE", "DELIVERY_AREA"},
                        "adjudication": "The user asks whether a replacement can arrive tomorrow, not to create an order. Delivery/availability clarification is appropriate; CREATE_ORDER remains a semantic misroute even when admission safely holds it."})
    report = {"checkedAt": datetime.now(UTC).isoformat(),
              "runtimeSha256": resolved["runtimeSha256"],
              "harnessSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "pythonSourceHashes": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((ROOT / "commerce-assistant-platform/app").rglob("*.py"))},
              "nodeSourceHashes": {str(p.relative_to(args.engine_root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((args.engine_root / "src").rglob("*.ts"))},
              "scope": "AI-assisted semantic adjudication plus actual local HTTP admission, using exact candidate Node output; original Phase 0 labels unchanged",
              "baselineSha256": hashlib.sha256(baseline.read_bytes()).hexdigest(), "candidateSha256": hashlib.sha256(args.candidate.read_bytes()).hexdigest(),
              "cases": results, "executionGuardPassed": sum(row["executionGuardPass"] for row in results), "semanticPassed": sum(row["semanticPass"] for row in results), "total": len(results)}
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "cases"}))
    raise SystemExit(0 if all(row["executionGuardPass"] for row in results) else 1)


if __name__ == "__main__":
    main()
