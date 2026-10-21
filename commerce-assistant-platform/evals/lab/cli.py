"""Additive subcommands for scripts/agent-evals.py; legacy regression command remains."""

import argparse
import asyncio
import json
import os
from pathlib import Path

from app.commerce_resolution_engine.providers.openai import OpenAIProvider
from evals.lab.budget import CappedProvider
from evals.lab.dynamic_fixtures import generate, historical_demo_snapshots
from evals.lab.models import (
    EvaluationScope,
    Report,
    RetrievalObservations,
    Snapshot,
    load_dataset,
)
from evals.lab.review import review_queue
from evals.lab.runner import project_scope, run
from evals.lab.scoring import compare, thresholds_after_baseline

ROOT = Path(__file__).parents[3]
DEFAULT_DATASET = ROOT / "commerce-assistant-platform/evals/lab/commerce-v1.json"


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def write_report(directory, report):
    write_json(directory / "report.json", report.model_dump(mode="json"))
    lines = [
        f"# Commerce evaluation: {report.mode} — {report.status}",
        "",
        f"Dataset `{report.dataset_revision}` / `{report.dataset_sha256}`.",
        f"Runtime `{report.runtime_sha256}`. Model `{report.model}`.",
        f"Scope `{report.scope_id}`; runtime features: {', '.join(report.runtime_features) or 'compatibility mode'}.",
        (report.scope_reason or "All dataset languages included."),
        f"Explicitly deferred cases: {len(report.excluded_cases)}. Their IDs/languages remain in the JSON report; they are not counted as passes.",
        "",
        "Replay uses recorded local language results when supplied, otherwise scripted extraction, and frozen retrieval observations. It does not measure provider understanding or search recall. Live canaries measure actual extraction against that same frozen snapshot; backend SQLx and browser suites supply transaction/UI evidence.",
        "",
        "| Segment | Passed / executed / total | 95% Wilson interval | Quarantined |",
        "|---|---:|---|---:|",
    ]
    for key, metric in report.segments.items():
        bounds = metric["wilson_95"]
        interval = (
            "unavailable" if bounds is None else f"{bounds[0]:.3f}–{bounds[1]:.3f}"
        )
        lines.append(
            f"| {key} | {metric['passed']} / {metric['executed']} / {metric['total']} | {interval} | {metric['quarantined']} |"
        )
    lines += ["", "## Failures and safe traces", ""]
    for row in report.results:
        if row.status != "passed":
            lines.append(
                f"- **{row.id}** ({row.status}): "
                + ", ".join(f"{f.layer}:{f.assertion}" for f in row.failures)
            )
    lines += [
        "",
        "The JSON report contains per-turn synthetic answers, extracted fields, proposal drafts, tool names and failure layers. No credentials or customer records are included.",
        "",
        "Live store configuration: "
        + ", ".join(f"{k}={v}" for k, v in report.live_stores.items())
        + ".",
        "",
    ]
    (directory / "report.md").write_text("\n".join(lines))


async def execute(args):
    dataset = load_dataset(args.dataset)
    provider = None
    try:
        if args.command == "live":
            key = (
                Path(args.key_file).read_text().strip()
                if args.key_file
                else os.environ.get("OPENAI_API_KEY", "")
            )
            provider = OpenAIProvider(model=args.model, api_key=key, timeout=30)
        capped = (
            CappedProvider(provider, args.max_calls, args.cap_micros)
            if provider
            else None
        )
        observations = (
            RetrievalObservations.model_validate_json(args.observations.read_bytes())
            if args.observations
            else None
        )
        scope = (
            EvaluationScope.model_validate_json(args.scope.read_bytes())
            if args.scope
            else None
        )
        report = await run(
            dataset,
            capped,
            observations,
            scope=scope,
            grounded_intent=args.grounded_intent,
            commerce_core=args.commerce_core,
            commerce_meaning=args.commerce_meaning,
            commerce_planning=args.commerce_planning,
        )
        write_report(args.output, report)
        print(
            json.dumps(
                {
                    "status": report.status,
                    "cases": len(report.results),
                    "mode": report.mode,
                    "budget": report.budget,
                }
            )
        )
        return 0 if report.status == "passed" else 1
    finally:
        if provider:
            await provider.aclose()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="command", required=True)
    for name in ("replay", "live"):
        sub = subs.add_parser(name)
        sub.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
        sub.add_argument(
            "--scope",
            type=Path,
            help="Explicit versioned acceptance scope; cannot silently change paired comparisons",
        )
        sub.add_argument(
            "--grounded-intent",
            action="store_true",
            help="Enable the opt-in production English query guard",
        )
        sub.add_argument(
            "--commerce-planning",
            action="store_true",
            help="Use M05 bounded declarative playbooks",
        )
        sub.add_argument(
            "--commerce-meaning",
            action="store_true",
            help="Enable M04 deterministic meaning and policy",
        )
        sub.add_argument(
            "--commerce-core",
            action="store_true",
            help="Route through the M03 core compatibility facade",
        )
        sub.add_argument(
            "--observations",
            type=Path,
            help="Versioned, scoped candidate retrieval observations for paired search comparisons",
        )
        sub.add_argument(
            "--output", type=Path, default=ROOT / f"artifacts/evaluation-lab/{name}"
        )
        if name == "live":
            sub.add_argument("--model", default="gpt-4.1-mini-2025-04-14")
            sub.add_argument("--key-file")
            sub.add_argument("--max-calls", type=int, default=6)
            sub.add_argument("--cap-micros", type=int, default=250000)
    sub = subs.add_parser("scope-report")
    sub.add_argument("--report", type=Path, required=True)
    sub.add_argument("--scope", type=Path, required=True)
    sub.add_argument("--output", type=Path, required=True)
    sub = subs.add_parser("generate-discovery")
    sub.add_argument("--snapshots", type=Path)
    sub.add_argument("--historical-before", type=Path)
    sub.add_argument("--applied-manifest", type=Path)
    sub.add_argument("--source-revision", required=True)
    sub.add_argument(
        "--observed-at",
        help="Required UTC observation timestamp for historical captures",
    )
    sub.add_argument("--output", type=Path, required=True)
    sub = subs.add_parser("thresholds")
    sub.add_argument("--baseline", type=Path, required=True)
    sub.add_argument("--output", type=Path, required=True)
    sub = subs.add_parser("review")
    sub.add_argument("--report", type=Path, required=True)
    sub.add_argument("--output", type=Path, required=True)
    sub = subs.add_parser("compare")
    sub.add_argument("--baseline", type=Path, required=True)
    sub.add_argument("--candidate", type=Path, required=True)
    sub.add_argument("--thresholds", type=Path)
    sub.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.command in {"replay", "live"}:
        return asyncio.run(execute(args))
    if args.command == "scope-report":
        write_report(
            args.output,
            project_scope(
                Report.model_validate_json(args.report.read_bytes()),
                EvaluationScope.model_validate_json(args.scope.read_bytes()),
            ),
        )
        return 0
    if args.command == "generate-discovery":
        if args.snapshots:
            if args.historical_before or args.applied_manifest:
                parser.error(
                    "Choose validated snapshots or the explicit historical capture inputs"
                )
            snapshots = [
                Snapshot.model_validate(s)
                for s in json.loads(args.snapshots.read_text())
            ]
        else:
            if (
                not args.historical_before
                or not args.applied_manifest
                or not args.observed_at
            ):
                parser.error(
                    "Historical generation requires before, applied manifest and observation timestamp"
                )
            snapshots = historical_demo_snapshots(
                json.loads(args.historical_before.read_text()),
                json.loads(args.applied_manifest.read_text()),
                args.source_revision,
                args.observed_at,
            )
        dataset = generate(snapshots, args.source_revision)
        write_json(args.output, dataset.model_dump(mode="json"))
        print(
            json.dumps(
                {
                    "status": "generated_not_executed",
                    "cases": len(dataset.cases),
                    "stores": sorted({s.store for s in snapshots}),
                    "scope": "frozen factual constraint fixtures; no live retrieval or subjective quality claim",
                }
            )
        )
        return 0
    if args.command == "review":
        write_json(
            args.output,
            review_queue(Report.model_validate_json(args.report.read_bytes())),
        )
        return 0
    baseline = Report.model_validate_json(args.baseline.read_bytes())
    if args.command == "thresholds":
        write_json(args.output, thresholds_after_baseline(baseline))
        return 0
    candidate = Report.model_validate_json(args.candidate.read_bytes())
    result = compare(
        baseline,
        candidate,
        json.loads(args.thresholds.read_text()) if args.thresholds else None,
    )
    write_json(args.output, result)
    print(
        json.dumps(
            {
                "status": result["status"],
                "regressions": result["paired_case_regressions"],
                "safety": result["safety_failures"],
                "candidate_failures": result["candidate_failures"],
            }
        )
    )
    return 0 if result["status"] == "passed" else 1
