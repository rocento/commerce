"""Measure deterministic assessment only, with explicitly synthetic catalog facts."""

import json
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "commerce-assistant-platform"), str(ROOT / "commerce-assistant-platform/tests")]
from dataclasses import asdict

from app.commerce_action_engine.actions.domain_evidence.assessment import assess
from test_domain_evidence import HD, NOW, PACK, TENANT, changed_ram, sample

product, schema, facts = sample()
for _ in range(50):
    assess(PACK, HD, product, schema, facts, TENANT, NOW)
timings = []
for _ in range(1000):
    start = time.perf_counter_ns()
    result = assess(PACK, HD, product, schema, facts, TENANT, NOW)
    assert result.status == "verified"
    timings.append((time.perf_counter_ns() - start) / 1e6)
below, low_facts = changed_ram(product, facts, 4)
examples = [
    asdict(assess(PACK, HD, p, schema, f, TENANT, NOW))
    for p, f in [(product, facts), (below, low_facts), (product, ())]
]
out = ROOT / "output/enterprise-knowledge-phase3-20261010"
report = {
    "scope": "Pure deterministic assessment, synthetic laptop and seven current attestations; excludes Node parsing, HTTP, DB and model calls",
    "samples": len(timings),
    "profile": HD.id,
    "fingerprint": PACK.fingerprint,
    "p50_ms": statistics.median(timings),
    "p95_ms": sorted(timings)[949],
    "max_ms": max(timings),
}
(out / "assessment-performance.json").write_text(json.dumps(report, indent=2) + "\n")
(out / "synthetic-assessment-examples.json").write_text(
    json.dumps({"synthetic": True, "examples": examples}, indent=2) + "\n"
)
print(json.dumps(report))
