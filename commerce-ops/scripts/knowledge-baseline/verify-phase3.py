"""Freeze/check Phase 3 runtime evidence without rewriting historical test results."""

import argparse
import hashlib
import json
import shutil
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "output/enterprise-knowledge-phase3-20261010"
sys.path.insert(0, str(ROOT / "commerce-assistant-platform"))
from app.commerce_action_engine.actions.domain_evidence.contracts import DomainPack


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path: Path):
    return json.loads(path.read_text())


def suite(name: str):
    root = ET.parse(OUT / name).getroot()
    return {
        key: sum(int(s.get(key, "0")) for s in root.findall("testsuite"))
        for key in ("tests", "failures", "errors", "skipped")
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--freeze", action="store_true")
    args = parser.parse_args()
    pack_path = ROOT / "commerce-assistant-platform/data/domain-evidence/electronics-v1.json"
    pack = DomainPack.model_validate_json(pack_path.read_text())
    assert pack == DomainPack.model_validate_json((OUT / "candidate.json").read_text())
    assert (
        sha(OUT / "validation-expectations.json")
        == "ab99f9a475ceff2fd9de0cf8666aae20d365dfb766378f104dd7a5f42d8c4e97"
    )
    assert len(read(OUT / "validation-expectations.json")["cases"]) == 26
    for source in pack.sources:
        assert sha(OUT / source.document_ref) == source.document_sha256
    stage = read(OUT / "local-stage.json")
    assert (
        stage["fingerprint"] == pack.fingerprint
        and stage["active_bindings"] == stage["product_facts"] == 0
    )
    assert (
        stage["profiles"] == 4
        and stage["sources"] == 2
        and stage["production_touched"] is False
    )
    final, db = suite("release-tests.xml"), suite("database-tests.xml")
    assert final == {"tests": 335, "failures": 0, "errors": 0, "skipped": 0}
    assert db == {"tests": 1, "failures": 0, "errors": 0, "skipped": 0}
    assert (
        "Success: no issues found in 255 source files"
        in (OUT / "typecheck.log").read_text()
    )
    assert "All checks passed!" in (OUT / "lint.log").read_text()
    deployments = (OUT / "deployment-tests.log").read_text()
    assert "Ran 43 tests" in deployments and "\nOK" in deployments
    assert "no missing targets" in (OUT / "documentation.log").read_text()
    perf = read(OUT / "assessment-performance.json")
    assert perf["fingerprint"] == pack.fingerprint and perf["samples"] == 1000
    assert perf["p95_ms"] < 10  # investigation threshold, not a production latency SLA
    prior = ROOT / "output/enterprise-knowledge-phase2-fixes-20261010"
    for path, expected in read(prior / "verification.json")["artifacts"].items():
        assert sha(prior / path) == expected, f"Historical report changed: {path}"
    csv = (
        ROOT
        / "output/live-shopper-eval-20261008/live-shopping-assistant-4000-english.csv"
    )
    assert (
        sha(csv) == "a83ab349e909328b967c29eadee5064db1e090a7aab926c637f5e6fdeb7b2c9e"
    )
    assert (
        read(
            ROOT / "output/enterprise-knowledge-phase0-20261010/benchmark-approved.json"
        )["executed"]
        is False
    )
    manifest_path = OUT / "snapshot-manifest.json"
    if args.freeze:
        assert not manifest_path.exists(), (
            "Snapshot exists; preserve it and create a new run for further changes"
        )
        files = [
            *(ROOT / "commerce-assistant-platform/app").rglob("*.py"),
            *(ROOT / "commerce-assistant-platform/tests").glob("*.py"),
            *(ROOT / "commerce-assistant-platform/migrations").glob("*.sql"),
            *(ROOT / "commerce-ops/scripts/knowledge-baseline").glob("*phase3*.py"),
            pack_path,
        ]
        files += [
            ROOT / p
            for p in [
                "commerce-ops/scripts/domain-evidence.py",
                "commerce-ops/scripts/evaluation/domain-evidence.py",
                "commerce-ops/scripts/conversations-setup.py",
                "commerce-ops/scripts/local/conversations-setup.py",
                "commerce-ops/deploy/assistant/shared-tenants.sql",
                "commerce-ops/deploy/assistant/init-store.sh",
                "commerce-assistant-platform/docs/capabilities.json",
                "commerce-api/rocento-api/openapi.json",
                "commerce-assistant-platform/tests/fixtures/enterprise_contracts/public-assistant-v1.json",
                "commerce-assistant-platform/app/commerce_language_engine/data/knowledge/shopping-en-phase2-v2.json",
            ]
        ]
        hashes = {}
        for path in sorted(set(files)):
            relative = path.relative_to(ROOT)
            destination = OUT / "snapshot" / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, destination)
            hashes[str(relative)] = sha(path)
        manifest_path.write_text(json.dumps({"files": hashes}, indent=2) + "\n")
    hashes = read(manifest_path)["files"]
    for path, expected in hashes.items():
        assert sha(ROOT / path) == expected, f"Current source changed: {path}"
        assert sha(OUT / "snapshot" / path) == expected, (
            f"Frozen source changed: {path}"
        )
    full = suite("python-tests.xml")
    full_failures = {
        (c.get("classname"), c.get("name"))
        for c in ET.parse(OUT / "python-tests.xml").iter("testcase")
        if c.find("failure") is not None
    }
    retested = {
        (c.get("classname"), c.get("name"))
        for c in ET.parse(OUT / "release-tests.xml").iter("testcase")
        if c.find("failure") is None and c.find("skipped") is None
    }
    remaining = sorted(full_failures - retested)
    assert (
        len(remaining) == 1
        and remaining[0][1]
        == "test_public_contracts_preserve_v1_with_optional_shopping_clarification_fields"
    )
    artifacts = [
        p for p in OUT.iterdir() if p.is_file() and p.name != "verification.json"
    ]
    report = {
        "phase3ChecksPassed": True,
        "repositoryChecksPassed": False,
        "productionReady": False,
        "domainFingerprint": pack.fingerprint,
        "domainRevision": pack.revision,
        "languageRevision": 8,
        "runtimeSnapshotSha256": sha(manifest_path),
        "targetedTests": final,
        "databaseTests": db,
        "deploymentTestsPassed": 43,
        "typecheckedModules": 255,
        "lockedScenarios": 26,
        "fullRunBeforeRepairs": full,
        "fullRunFailuresClosedByRetest": len(full_failures & retested),
        "remainingRepositoryTestFailures": remaining,
        "remainingArchitectureFinding": "existing execution/language/routing.py diagnostics import",
        "activeDomainBindings": 0,
        "productAttestationsStaged": 0,
        "historicalCsvAndPhase2ReportsPreserved": True,
        "phase0ReservedExecuted": False,
        "productionTouched": False,
        "artifacts": {p.name: sha(p) for p in sorted(artifacts)},
    }
    (OUT / "verification.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "artifacts"}, indent=2))


if __name__ == "__main__":
    main()
