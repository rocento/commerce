"""Exact candidate Node/Python shopping replay against bounded live catalog reads.

This is authored release validation, not a held-out benchmark. SSH only invokes
the restricted read bridge. Captured tool responses can be replayed with zero
network access. No production assistant chat, memory, or commerce mutation runs.
"""

import argparse
import asyncio
import hashlib
import json
import shlex
import subprocess
import sys
from datetime import UTC, datetime
from decimal import Decimal
from functools import partial
from pathlib import Path
from uuid import UUID, uuid4

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "commerce-assistant-platform"))

import httpx
from app.commerce_action_engine.actions.shopping import context as context_module
from app.commerce_action_engine.application.catalog import registry
from app.commerce_action_engine.application.context import TurnContext
from app.commerce_action_engine.application.interpretation import (
    interpret_resolution,
    reasoning_fallback_message,
)
from app.commerce_action_engine.application.shopping import shopping_answer
from app.commerce_action_engine.contracts.action import ActorContext
from app.commerce_action_engine.execution.agents import (
    AgentCatalog,
    Principal,
    default_agents,
)
from app.commerce_action_engine.execution.language.gate import Resolution
from app.commerce_resolution_engine.runtime import AgentRuntime

CASES = [
    ("grocery", "rice_budget", ["Find rice under $50"], {"budget": "50", "requireProducts": True}),
    ("grocery", "family_recipient", ["Find milk for my family under $20"], {"budget": "20", "relation": ["recipient", "family"]}),
    ("grocery", "hand_sewing", ["Find supplies for hand sewing"], {"relation": ["intended_use", "hand sewing"], "noProducts": True}),
    ("electronics", "low_budget_classes", ["I need a laptop for online classes and my limit is $40."], {"budget": "40"}),
    ("electronics", "classes_options", ["I need a laptop for online classes and my limit is $10000."], {"budget": "10000", "requireProducts": True}),
    ("electronics", "macro_photography", ["Find a camera for macro photography under $500"], {"budget": "500", "relation": ["intended_use", "macro photography"]}),
    ("electronics", "expanded_recipient", ["Find microphone for my lab partner for recording audiobooks and my budget is $75"], {"budget": "75", "relation": ["recipient", "lab partner"]}),
    ("electronics", "budget_followup", ["I need a laptop for online classes and my limit is $10000.", "Actually my budget is $40 now."], {"budget": "40", "relation": ["intended_use", "online classes"]}),
    ("electronics", "device_evidence", ["I need a charger for an iPhone 13. How do I avoid buying the wrong one?"], {"clarification": "cannot confirm", "noProducts": True}),
    ("jewelry", "ring_budget", ["Find ring under $500"], {"budget": "500", "requireProducts": True}),
    ("jewelry", "expanded_recipient", ["Find ring for my stepmum under $500"], {"budget": "500", "relation": ["recipient", "stepmother"]}),
    ("jewelry", "recipient_followup", ["Find necklace for my mother under $500", "Actually my budget is $40 now."], {"budget": "40", "relation": ["recipient", "mother"]}),
    # The captured sunscreen search only returns a merchant-classified moisturizer.
    # Rejecting that unrelated candidate is correct; never require a fabricated match.
    ("pharmacy", "sunscreen_budget", ["Find sunscreen under $50"], {"budget": "50", "noProducts": True}),
    ("pharmacy", "moisturizer_budget", ["Find moisturizer under $50"], {"budget": "50", "requireProducts": True}),
    ("pharmacy", "recipient", ["Find sunscreen for my mother under $50"], {"budget": "50", "relation": ["recipient", "mother"]}),
    ("pharmacy", "no_suitability_inference", ["Find thermometer for camping under $50"], {"budget": "50", "purpose": "camping", "noProducts": True}),
]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def key(request):
    return json.dumps(request, sort_keys=True, separators=(",", ":"))


class Capture:
    def __init__(self, path, live):
        self.path = path
        path.touch(exist_ok=True)
        self.rows = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        self.cache = {key(row["request"]): row for row in self.rows}
        self.process = None
        if live:
            program = (ROOT / "commerce-ops/scripts/knowledge-baseline/release-demo-read-bridge.py").read_text()
            self.process = subprocess.Popen([
                "ssh", "-i", str(ROOT / "commerce-ops/deploy/aws-deploy/rocento.pem"), "-o", "StrictHostKeyChecking=yes",
                "-o", "ConnectTimeout=20", "ubuntu@3.78.102.161", "sudo python3 -u -c " + shlex.quote(program),
            ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

    def read(self, store, body):
        request = {"store": store, **body}
        identity = key(request)
        if identity not in self.cache:
            if self.process is None:
                raise ValueError("Missing captured request; replay cannot invent catalog responses")
            self.process.stdin.write(json.dumps(request) + "\n")
            self.process.stdin.flush()
            row = json.loads(self.process.stdout.readline())
            if "error" in row:
                raise ValueError("Catalog capture failed: " + json.dumps(row))
            self.rows.append(row)
            self.cache[identity] = row
            with self.path.open("a") as stream:
                stream.write(json.dumps(row) + "\n")
        return self.cache[identity]

    def close(self):
        if self.process:
            self.process.stdin.close()
            if self.process.wait(timeout=15) != 0:
                raise ValueError("Read bridge did not exit successfully")


class NoModel:
    calls = 0

    async def generate(self, request):
        self.calls += 1
        raise AssertionError("Candidate requested an unplanned model fallback")


async def answer_case(store, text, wire, capture):
    schema = capture.read(store, {"name": "get_catalog_schema", "arguments": {}})
    tenant = UUID(schema["tenant"])
    principal = Principal(tenant=tenant, persona="shopper")
    actor = ActorContext(tenant_id=str(tenant), store_id=str(tenant), session_id=str(uuid4()), request_id=str(uuid4()), channel="evaluation")
    interpreted = interpret_resolution(Resolution.model_validate(wire), TurnContext(actor=actor)).result
    # Match search_context.resume_current_search: continuation evidence addresses
    # the engine's verified composite source, not the short follow-up message.
    effective_text = wire.get("interpretationText") if wire.get("searchUpdate") else text
    requests = []

    def handler(request):
        assert request.url.path == "/v1/assistant-tools/shopper"
        body = json.loads(request.content)
        assert body["name"] in {"get_catalog_schema", "search_products", "get_product"}
        row = capture.read(store, body)
        assert row["tenant"] == str(tenant)
        requests.append(row)
        return httpx.Response(row["httpStatus"], json=row["response"])

    provider = NoModel()
    agent = default_agents(tenant).load(tenant, "shopper")
    async with httpx.AsyncClient(base_url="http://assistant-tools:8081", transport=httpx.MockTransport(handler)) as client:
        runtime = AgentRuntime(
            AgentCatalog((agent,)), {"default": provider}, registry(client, "captured-read-only", principal, {}),
            shopping=True, commerce_meaning=True, commerce_planning=True,
            shopping_handler=partial(shopping_answer, interpretation=interpreted),
        )
        events = [event async for event in runtime.stream(
            agent_id="shopper", principal=principal, message=effective_text,
            fallback_message=reasoning_fallback_message(interpreted),
        )]
    answer = events[-1].answer
    cards = [p.model_dump(mode="json") for block in answer.blocks for p in (block.products or ())]
    return {"text": answer.text, "products": cards, "model": answer.model,
            "modelCalls": provider.calls, "toolCalls": [row["request"] for row in requests],
            "catalogProductIds": sorted({p["id"] for row in requests for p in row["response"]["products"]}),
            "catalogPrices": {p["id"]: [p["price"], p["currency"]] for row in requests for p in row["response"]["products"]}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine-root", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--capture", action="store_true")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    report_path = args.output / "demo-validation.json"
    if report_path.exists():
        raise ValueError("Use a new report directory; completed evidence is immutable")
    context_module._COMPILED_KNOWLEDGE = args.candidate.resolve()
    program = """
import {readFileSync} from 'node:fs';
import {compile} from './src/compiler.ts';
import {resolve} from './src/engine.ts';
const input=JSON.parse(readFileSync(0,'utf8'));
const engine=compile(JSON.parse(readFileSync(input.candidate,'utf8')));
const rows=input.cases.map(c=>{let context={}; return c.map(text=>{const result=resolve(engine,text,context); context=result.context?.next??{}; return {text,result};});});
console.log(JSON.stringify(rows));
"""
    wires = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", program], cwd=args.engine_root, input=json.dumps({"candidate": str(args.candidate.resolve()), "cases": [row[2] for row in CASES]}).encode()))
    capture = Capture(args.output / "catalog-reads.jsonl", args.capture)
    results = []
    try:
        for (store, name, texts, expected), turns in zip(CASES, wires, strict=True):
            row = {"id": store + ":" + name, "store": store, "expected": expected, "turns": turns, "checks": {}, "pass": False}
            try:
                turn = turns[-1]
                wire = turn["result"]
                answer = asyncio.run(answer_case(store, turn["text"], wire, capture))
                row["answer"] = answer
                checks = row["checks"]
                checks["resolved"] = wire["status"] == "RESOLVED"
                checks["noModelFallback"] = answer["modelCalls"] == 0
                checks["onlyCurrentStoreProducts"] = all(p["id"] in answer["catalogProductIds"] for p in answer["products"])
                checks["exactCatalogPrices"] = all([p["price"], p["currency"]] == answer["catalogPrices"][p["id"]] for p in answer["products"])
                if "budget" in expected:
                    checks["budgetPreserved"] = str(wire["entities"].get("price", {}).get("value")) == expected["budget"]
                    exclusive = wire["entities"].get("price", {}).get("operator") == "<"
                    checks["budgetRespected"] = all(
                        (Decimal(p["price"]) < Decimal(expected["budget"]) if exclusive else Decimal(p["price"]) <= Decimal(expected["budget"]))
                        and p["currency"] == "USD" for p in answer["products"]
                    )
                if "relation" in expected:
                    checks["typedRelation"] = expected["relation"] in [[r["relation"], r["value"]] for r in wire["entities"].get("shoppingContext", {}).get("relations", [])]
                if "purpose" in expected:
                    checks["legacyPurposePreserved"] = wire["entities"].get("catalogPurpose") == expected["purpose"]
                if len(texts) > 1:
                    checks["followupExecutesBoundedSearch"] = any(call["name"] == "search_products" and call["arguments"].get("max_price") == expected["budget"] for call in answer["toolCalls"])
                if expected.get("requireProducts"):
                    checks["productsReturned"] = bool(answer["products"])
                if expected.get("noProducts"):
                    checks["noUnverifiedProducts"] = not answer["products"]
                if "clarification" in expected:
                    checks["evidenceClarification"] = expected["clarification"] in answer["text"].lower()
                row["pass"] = all(checks.values())
            except Exception as error:  # noqa: BLE001 - preserve every failed case in the evaluation report.
                row["error"] = {"kind": type(error).__name__, "message": str(error)[:1000]}
            results.append(row)
            print(json.dumps({"case": row["id"], "pass": row["pass"], "error": row.get("error"), "checks": row["checks"]}), flush=True)
    finally:
        capture.close()
    source_paths = sorted((ROOT / "commerce-assistant-platform/app").rglob("*.py"))
    report = {"checkedAt": datetime.now(UTC).isoformat(), "scope": "Authored candidate Node-to-Python replay of live read-only catalog tools; not a production deployment or held-out benchmark",
              "candidateSha256": sha(args.candidate), "candidateFingerprint": json.loads(args.candidate.read_text())["generationFingerprint"],
              "nodeSourceHashes": {str(p.relative_to(args.engine_root)): sha(p) for p in sorted((args.engine_root / "src").rglob("*.ts"))},
              "pythonSourceHashes": {str(p.relative_to(ROOT)): sha(p) for p in source_paths},
              "catalogReadsSha256": sha(capture.path), "distinctCatalogReads": len(capture.rows), "domainEvidenceEnabled": False,
              "harnessSha256": sha(Path(__file__)), "modelProvider": "disabled: fail on every attempted model call",
              "totalCases": len(results), "passed": sum(row["pass"] for row in results), "failed": sum(not row["pass"] for row in results),
              "stores": sorted({row["store"] for row in results}), "cases": results}
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    raise SystemExit(0 if report["failed"] == 0 else 1)


if __name__ == "__main__":
    main()
