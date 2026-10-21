"""Run the versioned agent gold/regression suite, isolate its DB, emit honest evidence."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))


import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MANIFEST = ROOT / "commerce-assistant-platform/evals/suite.json"


def command(args, cwd, env, timeout=600):
    return subprocess.run(
        args,
        cwd=cwd,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
        check=False,
    )


def case_id(classname, name):
    # Parameter values may contain huge payloads or credential canaries. Publish a digest.
    if "[" in name and "test_gold_discovery" not in name:
        base, parameter = name.split("[", 1)
        name = base + "[" + hashlib.sha256(parameter.encode()).hexdigest()[:12] + "]"
    result = f"{classname}.{name}"
    return (
        result
        if len(result) <= 240
        else result[:220] + "-" + hashlib.sha256(result.encode()).hexdigest()[:12]
    )


def python_results(path):
    return [
        {
            "id": case_id(case.get("classname", ""), case.get("name", "")),
            "status": "failed"
            if case.find("failure") is not None or case.find("error") is not None
            else "skipped"
            if case.find("skipped") is not None
            else "passed",
            "seconds": float(case.get("time", "0")),
            "engine": "python",
        }
        for case in ET.parse(path).iter("testcase")
    ]


def rust_results(output, suite):
    return [
        {
            "id": f"{suite}.{name}",
            "status": {"ok": "passed", "FAILED": "failed", "ignored": "skipped"}[
                status
            ],
            "seconds": None,
            "engine": "rust",
        }
        for name, status in re.findall(
            r"^test (\S+) \.\.\. (ok|FAILED|ignored)\b", output, re.MULTILINE
        )
    ]


def summarize(results, dimensions):
    metrics = {}
    for dimension, patterns in dimensions.items():
        cases = [r for r in results if any(pattern in r["id"] for pattern in patterns)]
        executed = [r for r in cases if r["status"] != "skipped"]
        passed = sum(r["status"] == "passed" for r in executed)
        failure_rate = dimension.endswith("failure_rate")
        metrics[dimension] = {
            "passed": passed,
            "executed": len(executed),
            "skipped": len(cases) - len(executed),
            "value": ((len(executed) - passed) if failure_rate else passed)
            / len(executed)
            if executed
            else None,
            "unit": "scenario_failure_fraction"
            if failure_rate
            else "scenario_pass_fraction",
        }
    durations = sorted(
        r["seconds"]
        for r in results
        if r["seconds"] is not None and r["status"] != "skipped"
    )
    metrics["latency"] = {
        "unit": "python_scenario_seconds_including_harness",
        "samples": len(durations),
        "mean": sum(durations) / len(durations) if durations else None,
        "p95": durations[math.ceil(0.95 * len(durations)) - 1] if durations else None,
    }
    return metrics


def write_report(output, report):
    output.mkdir(parents=True, exist_ok=True)
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = [
        "# Commerce agent evaluation report",
        "",
        f"Result: **{report['status'].upper()}** · {report['created_at']}",
        "",
        f"Suite version: {report['suite_version']} · Fixture SHA-256: `{report['fixture_sha256']}`",
        "",
        "**Scope:** deterministic seeded fixtures and real application code; model and embedding responses are scripted. No live model quality, production latency, billing, or universal injection-resistance claim.",
        "",
        "Metrics are scenario-level assertion pass/failure fractions. Hallucination and permission rates are regression proxies, not counts of generated claims or confirmed disclosures. A failing scenario requires diagnosis. Missing coverage is unavailable, never zero.",
        "",
        "| Dimension | Passed / executed | Skipped | Value |",
        "| --- | ---: | ---: | ---: |",
    ]
    for name, metric in report["metrics"].items():
        if name == "latency":
            continue
        value = "unavailable" if metric["value"] is None else f"{metric['value']:.1%}"
        lines.append(
            f"| {name} | {metric['passed']} / {metric['executed']} | {metric['skipped']} | {value} |"
        )
    latency = report["metrics"]["latency"]
    lines += [
        "",
        f"Python scenario latency: mean {latency['mean']} s; p95 {latency['p95']} s ({latency['samples']} samples). Rust cases lack individual timing; suite wall times are below.",
        "",
        "## Execution",
        "",
    ]
    for run in report["runs"]:
        lines.append(
            f"- {run['suite']}: exit {run['exit_code']}, {run['seconds']:.2f} s, {run['cases']} cases"
        )
    lines += ["", "## Infrastructure / coverage errors", ""] + [
        f"- {error}" for error in report["errors"]
    ]
    if not report["errors"]:
        lines.append("None.")
    lines += [
        "",
        "## Per-case evidence",
        "",
        "| Scenario | Result | Seconds |",
        "| --- | --- | ---: |",
    ]
    for case in report["results"]:
        name = case["id"].replace("|", "\\|").replace("\n", " ")
        lines.append(
            f"| {name} | {case['status']} | {case['seconds'] if case['seconds'] is not None else 'n/a'} |"
        )
    lines += [
        "",
        "Expected assertions and seeds: `ai-service/evals/commerce-gold.json`, `ai-service/tests/test_gold_evals.py`, and the tests listed in `ai-service/evals/suite.json`. Backend SQLx tests migrate and seed isolated databases per case. Python DB tests create/drop separate databases. Raw subprocess output is not published because it can contain environment details.",
        "",
    ]
    (output / "report.md").write_text("\n".join(lines))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/agent-evals")
    args = parser.parse_args()
    manifest = json.loads(MANIFEST.read_text())
    report = {
        "suite_version": manifest["version"],
        "fixture_sha256": hashlib.sha256(
            (ROOT / "commerce-assistant-platform/evals/commerce-gold.json").read_bytes()
            + MANIFEST.read_bytes()
        ).hexdigest(),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "failed",
        "results": [],
        "runs": [],
        "errors": [],
        "separate_browser_acceptance": manifest.get("separate_browser_acceptance", []),
        "separate_live_acceptance": manifest.get("python_live_files", []),
    }
    env = os.environ.copy()
    container = None
    try:
        dsn = env.get("AGENT_EVAL_DATABASE_URL")
        if not dsn:
            container = "commerce-agent-eval-" + uuid.uuid4().hex[:12]
            started = command(
                [
                    "docker",
                    "run",
                    "-d",
                    "--name",
                    container,
                    "-e",
                    "POSTGRES_PASSWORD=eval-test-only",
                    "-p",
                    "127.0.0.1::5432",
                    "pgvector/pgvector:pg16",
                ],
                ROOT,
                env,
                120,
            )
            if started.returncode:
                raise RuntimeError(
                    "Disposable Docker database could not start; check Docker or set AGENT_EVAL_DATABASE_URL to an explicitly disposable pgvector admin DSN."
                )
            ready = False
            for _ in range(60):
                if (
                    command(
                        ["docker", "exec", container, "pg_isready", "-U", "postgres"],
                        ROOT,
                        env,
                        10,
                    ).returncode
                    == 0
                ):
                    ready = True
                    break
                time.sleep(0.5)
            if not ready:
                raise RuntimeError("Disposable database did not become ready.")
            port = command(["docker", "port", container, "5432"], ROOT, env, 10)
            if port.returncode or not re.fullmatch(r"127\.0\.0\.1:\d+\s*", port.stdout):
                raise RuntimeError("Could not resolve the isolated database port.")
            dsn = f"postgres://postgres:eval-test-only@127.0.0.1:{port.stdout.strip().rsplit(':', 1)[1]}/postgres"
        env.update(
            DATABASE_URL=dsn, M09_TEST_DATABASE_URL=dsn, M04_TEST_DATABASE_URL=dsn
        )
        python = ROOT / "commerce-assistant-platform/.venv/bin/python"
        executable = str(python) if python.exists() else sys.executable
        with tempfile.TemporaryDirectory(prefix="agent-evals-") as tmp:
            junit = Path(tmp) / "python.xml"
            jobs = [
                (
                    "python",
                    [
                        executable,
                        "-m",
                        "pytest",
                        "-q",
                        *manifest["python_files"],
                        *[
                            f"--ignore={path}"
                            for path in manifest.get("python_live_files", [])
                        ],
                        f"--junitxml={junit}",
                    ],
                    ROOT / "commerce-assistant-platform",
                )
            ]
            jobs += [
                (
                    suite,
                    ["cargo", "test", "-p", "api-gateway", "--test", suite, "--locked"]
                    + (
                        [
                            "--",
                            "--skip",
                            "customer_profile_opens_real_customer_journey_in_browser",
                        ]
                        if suite == "customer_journey"
                        else []
                    ),
                    ROOT / "commerce-api",
                )
                for suite in manifest["rust_suites"]
            ]
            for suite, argv, cwd in jobs:
                print(f"Running {suite} evaluations...", flush=True)
                start = time.monotonic()
                try:
                    suite_env = env.copy()
                    if suite == "python":
                        # AI service deliberately rejects inherited Commerce credentials.
                        suite_env.pop("DATABASE_URL", None)
                    run = command(argv, cwd, suite_env)
                    cases = (
                        python_results(junit)
                        if suite == "python" and junit.exists()
                        else rust_results(run.stdout, suite)
                        if suite != "python"
                        else []
                    )
                    report["results"].extend(cases)
                    report["runs"].append(
                        {
                            "suite": suite,
                            "exit_code": run.returncode,
                            "seconds": time.monotonic() - start,
                            "cases": len(cases),
                        }
                    )
                    if run.returncode or not cases:
                        report["errors"].append(
                            f"{suite} execution failed or produced no cases; rerun its manifest command for diagnostics."
                        )
                except (OSError, subprocess.TimeoutExpired, ET.ParseError, ValueError):
                    report["errors"].append(
                        f"{suite} could not execute, timed out, or returned invalid evidence."
                    )
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        report["errors"].append(
            str(error)
            if isinstance(error, RuntimeError)
            else "Evaluation infrastructure unavailable."
        )
    finally:
        if container:
            try:
                if command(["docker", "rm", "-f", container], ROOT, env, 30).returncode:
                    report["errors"].append(
                        "Disposable container cleanup failed; inspect Docker containers prefixed commerce-agent-eval-."
                    )
            except (OSError, subprocess.TimeoutExpired):
                report["errors"].append("Disposable container cleanup unavailable.")
        report["metrics"] = summarize(report["results"], manifest["dimensions"])
        if any(m.get("executed") == 0 for m in report["metrics"].values()):
            report["errors"].append(
                "One or more required dimensions have no executed cases."
            )
        if (
            report["results"]
            and not report["errors"]
            and all(r["status"] == "passed" for r in report["results"])
        ):
            report["status"] = "passed"
        write_report(args.output.resolve(), report)
    print(
        json.dumps(
            {
                "event": "assistant_eval_summary",
                "status": report["status"],
                "suite_version": report["suite_version"],
                "metrics": report["metrics"],
            }
        ),
        flush=True,
    )
    print(
        f"{report['status'].upper()}: {args.output.resolve() / 'report.md'}", flush=True
    )
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in {
        "review",
        "scope-report",
        "replay",
        "live",
        "generate-discovery",
        "thresholds",
        "compare",
    }:
        sys.path.insert(0, str(ROOT / "commerce-assistant-platform"))
        from evals.lab.cli import main as lab_main

        sys.exit(lab_main())
    sys.exit(main())
