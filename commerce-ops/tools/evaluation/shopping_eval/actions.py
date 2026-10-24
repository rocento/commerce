"""Action-contract evaluation using real application code and isolated fake ports.

Existing integration tests own independent expected calls/results. No production
credentials, live commerce writes, or model providers are used by these suites.
"""

import hashlib
import json
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

SUITES = {
    "cart_totals": [
        "test_cart_pricing.py",
        "test_cart_response.py",
        "test_cart_total_journey.py",
    ],
    "cart_actions": ["test_cart_actions.py", "test_invalid_quantity_admission.py"],
    "order_selection": ["test_first_order_question.py", "test_order_read_routes.py"],
    "address_form": ["test_address_form.py"],
    "sales_recommendations": ["test_bestseller_periods.py"],
    "value_clarification": ["test_best_value_request.py"],
    "selected_context": ["test_shopping_selection_context.py"],
    "catalog_discovery": [
        "test_deterministic_discovery_planning.py",
        "test_discovery_workflow.py",
    ],
}


def summarize_junit(path):
    root = ET.parse(path).getroot()
    rows = []
    for case in root.iter("testcase"):
        problem = case.find("failure")
        if problem is None:
            problem = case.find("error")
        rows.append(
            {
                "case": case.attrib.get("classname", "") + "::" + case.attrib["name"],
                "status": "failed"
                if problem is not None
                else "skipped"
                if case.find("skipped") is not None
                else "passed",
                "seconds": float(case.attrib.get("time", 0)),
                "failure": problem.attrib.get("message", "")
                if problem is not None
                else None,
            }
        )
    return rows


def run(root: Path, output: Path, timeout: int):
    output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    report = {
        "mode": "action_contracts",
        "environment": "local_mocked_commerce",
        "production_verified": False,
        "suites": {},
        "limits": [
            "Passing language recognition alone never passes an action-contract test.",
            "This is a curated integration matrix, not 500,000 independently executed journeys.",
            "Real Python routing/handlers and selected real Node interpretations run against mocked commerce data.",
            "Frontend popup rendering, live gateway authorization, and production inventory need separate tests.",
            "Unlisted actions are untested, not passing. No paid model calls or production writes.",
        ],
    }
    passed = True
    for name, files in SUITES.items():
        paths = [root / "commerce-assistant-platform/tests" / file for file in files]
        xml = output / f"{name}.xml"
        xml.unlink(missing_ok=True)
        remaining = timeout - (time.monotonic() - started)
        if remaining <= 0:
            report["suites"][name] = {"status": "incomplete", "reason": "timeout"}
            passed = False
            continue
        hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
        try:
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "pytest",
                    *map(str, paths),
                    "-q",
                    f"--junitxml={xml.resolve()}",
                ],
                cwd=root,
                capture_output=True,
                text=True,
                timeout=remaining,
                check=False,
            )
            (output / f"{name}.log").write_text(result.stdout + result.stderr)
            cases = summarize_junit(xml) if xml.exists() else []
            ok = (
                result.returncode == 0
                and bool(cases)
                and all(c["status"] == "passed" for c in cases)
            )
            report["suites"][name] = {
                "status": "passed" if ok else "failed",
                "exit_code": result.returncode,
                "cases": cases,
                "test_hashes": hashes,
            }
        except subprocess.TimeoutExpired:
            ok = False
            report["suites"][name] = {
                "status": "incomplete",
                "reason": "timeout",
                "test_hashes": hashes,
            }
        passed &= ok
        print(f"Action contract {name}: {report['suites'][name]['status']}", flush=True)
    report["status"] = "passed" if passed else "failed"
    report["seconds"] = round(time.monotonic() - started, 2)
    report["counts"] = {
        status: sum(
            c["status"] == status
            for s in report["suites"].values()
            for c in s.get("cases", [])
        )
        for status in ("passed", "failed", "skipped")
    }
    (output / "action-report.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = [
        "# Backend action-contract evaluation",
        "",
        f"Result: {report['status']}. Environment: local application with mocked commerce ports.",
        "",
        "| Action family | Result | Checks |",
        "|---|---|---|",
    ]
    for name, suite in report["suites"].items():
        lines.append(f"| {name} | {suite['status']} | {len(suite.get('cases', []))} |")
    lines += ["", "## Limits", "", *[f"- {s}" for s in report["limits"]]]
    (output / "action-report.md").write_text("\n".join(lines) + "\n")
    return report
