#!/usr/bin/env python3
"""Generate and evaluate synthetic shopper conversations against the local engine.

Run with commerce-assistant-platform/.venv/bin/python; Node >=22.18 is also required.
No API keys, paid model calls, HTTP requests, database writes or checkout actions.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))


import argparse
import gzip
import hashlib
import json
import shutil
import subprocess
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from datetime import datetime, timezone
from pathlib import Path

from shopping_eval import corpus_v2
from shopping_eval.corpus import VERSION, generate

ROOT = Path(__file__).resolve().parents[3]
WORKER = ROOT / "commerce-ops/scripts/shopping_eval/engine-worker.mjs"


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def open_observations(path):
    """Read completed observations after lossless storage compaction."""
    if path.exists():
        return path.open(encoding="utf-8")
    return gzip.open(path.with_suffix(path.suffix + ".gz"), "rt", encoding="utf-8")


def get_path(value, path):
    for key in path.split("."):
        if isinstance(value, dict):
            value = value.get(key)
        elif isinstance(value, list) and key.isdecimal() and int(key) < len(value):
            value = value[int(key)]
        else:
            return None
    return value


def score_turn(expected, result, plan=None, selected_route=None):
    failures = []
    if not isinstance(result.get("message"), str) or not result["message"].strip():
        failures.append(
            {
                "field": "message",
                "expected": "nonempty engine response",
                "actual": result.get("message"),
            }
        )
    if expected is None:
        return failures
    if "route" in expected and selected_route != expected["route"]:
        failures.append(
            {"field": "route", "expected": expected["route"], "actual": selected_route}
        )
    checks = {
        **{key: expected[key] for key in ("status", "intent") if key in expected},
        **expected.get("paths", {}),
    }
    for path, wanted in checks.items():
        actual = get_path(result, path)
        if actual != wanted:
            failures.append({"field": path, "expected": wanted, "actual": actual})
    for path, wanted in expected.get("normalized_paths", {}).items():
        actual = get_path(result, path)
        normalize = lambda v: (
            " ".join(v.casefold().split()) if isinstance(v, str) else v
        )
        if normalize(actual) != normalize(wanted):
            failures.append({"field": path, "expected": wanted, "actual": actual})
    for path, wanted in expected.get("plan", {}).items():
        actual = get_path(plan or {}, path)
        if actual != wanted:
            failures.append(
                {"field": "plan." + path, "expected": wanted, "actual": actual}
            )
    for path, choices in expected.get("any_of_paths", {}).items():
        actual = get_path(result, path)
        if actual not in choices:
            failures.append(
                {"field": path, "expected": {"any_of": choices}, "actual": actual}
            )
    if result.get("status") == "RESOLVED" and result.get("intent") in expected.get(
        "forbid_resolved_intents", []
    ):
        failures.append(
            {
                "field": "safety.resolved_intent",
                "expected": "no forbidden resolved intent",
                "actual": result["intent"],
            }
        )
    return failures


def fingerprint():
    paths = [Path(__file__), *WORKER.parent.glob("*.py"), WORKER]
    engine = ROOT / "commerce-assistant-platform/app/commerce_language_engine"
    paths += list((engine / "src").rglob("*.ts"))
    paths += list((engine / "data").glob("compiled.json"))
    paths += list(
        (ROOT / "commerce-assistant-platform/app/commerce_action_engine/execution/language").glob("*.py")
    )
    paths += list(
        (ROOT / "commerce-assistant-platform/app/commerce_action_engine/actions/catalog").glob("*.py")
    )
    paths += list(
        (ROOT / "commerce-assistant-platform/app/commerce_action_engine/actions/shopping").glob("*.py")
    )
    paths += [engine / "package.json", engine / "package-lock.json"]
    return {
        str(p.relative_to(ROOT)): file_hash(p)
        for p in sorted(set(paths))
        if p.is_file()
    }


def routing(result, text):
    return admission(result, text)[0]


def admission(result, text):
    from app.commerce_action_engine.application.context import TurnContext
    from app.commerce_action_engine.application.interpretation import (
        interpret_resolution,
        shopping_plan,
    )
    from app.commerce_action_engine.contracts.action import ActorContext
    from app.commerce_action_engine.execution.language.gate import (
        Resolution,
    )

    # Synthetic evaluation identity; this runner does not execute commerce.
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
    validated = Resolution.model_validate(result)
    decision = interpret_resolution(validated, context)
    selected = decision.route
    # Match HandleTurn's deterministic catalog admission check.
    plan = shopping_plan(decision.result, text) if selected == "search" else None
    if selected == "search" and plan is None:
        selected = "unmapped"
    disposition = (
        "catalog_clarification" if plan is not None and plan.clarification else selected
    )
    return selected, disposition, plan.model_dump() if plan else None


RECOMMENDATIONS = {
    "search": "Review product-boundary parsing; preserve product names without consuming price constraints.",
    "conversational_search": "Add reviewed conversational search grammar and regression cases for the failing phrases.",
    "typos": "Add bounded typo normalization with negative controls; measure wrong-action regressions before enabling it.",
    "price_constraints": "Preserve amount, currency and comparator together; validate actual catalog filtering separately.",
    "add_cart": "Check quantity/product binding and cart aliases before considering direct cart execution.",
    "remove_cart": "Review removal verbs and entity binding; validate ownership and mutation receipts in isolated integration tests.",
    "wishlist_to_cart": "Preserve collection direction, item and quantity; verify the authenticated transfer flow separately.",
    "cart_to_wishlist": "Distinguish understanding from executor coverage; expose honest handoff guidance for unsupported execution.",
    "negation": "Prioritize denied-action parsing. Never execute a negated command; separately verify the UNKNOWN LLM path respects denial.",
    "conflicting_actions": "Ask which action the shopper intends before invoking any commerce executor.",
    "compound_checkout": "Preserve all item quantities and action ordering; require authoritative commerce validation before checkout.",
    "address_followup": "Preserve the original products and quantities when filling an address; test the storefront clarification adapter too.",
    "product_followup": "Retain action and quantity while filling product slots; reject unrelated action changes during clarification.",
    "arabic": "Treat Arabic as a separate expansion release with native-speaker gold cases, currency and number normalization.",
    "mixed_language": "Add bilingual shopping gold cases and code-switching boundaries before claiming mixed-language support.",
    "requirements_review": "Have humans check allergies, compatibility, delivery and suitability against grounded catalog/policy evidence.",
}


def report_markdown(report):
    lines = [
        "# Synthetic shopping evaluation",
        "",
        f"Generated: {report['created_at']}",
        "",
        (
            f"**{report['cases']:,} unique conversations; {report['turns']:,} turns.** "
            f"Semantic checks passed: {report['outcomes'].get('passed', 0):,}; failed: {report['outcomes'].get('failed', 0):,}; "
            f"human review: {report['outcomes'].get('review', 0):,}."
        ),
        "",
        (
            "Scope: actual local Node language resolver and Python route/catalog-plan admission. "
            "No full assistant, catalog retrieval, cart mutation, factual answer judging, live LLM, billing or production latency is measured. "
            "Multi-turn cases carry Node context.next; the storefront clarification adapter is a separate integration boundary."
        ),
        "",
        (
            f"Actual LLM calls: **0**. UNKNOWN/fallback-eligible turns: **{report['routes'].get('fallback', 0):,}**. "
            "These are eligibility counts, not observed LLM answers. All resolver responses were generated locally by the engine."
        ),
        "",
        (
            "These are template-composed synthetic messages, not real customer transcripts or independent human judgments. "
            "Failure means an authored semantic expectation was not met; labels need review before becoming release gates. "
            "The selected language scope is recorded in the manifest. No finite corpus proves all cases are handled."
        ),
        "",
        "| Family | Cases | Passed | Failed | Review | Fallback turns |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for family, counts in report["families"].items():
        lines.append(
            f"| {family} | {counts['cases']} | {counts.get('passed', 0)} | {counts.get('failed', 0)} | {counts.get('review', 0)} | {counts.get('fallback_turns', 0)} |"
        )
    lines += [
        "",
        "## Evaluation depth and corpus diversity",
        "",
        f"Template groups: {len(report.get('templates', {}))}. Template holdout is a corpus partition, not independent human validation.",
        f"Safety violations (forbidden resolved intents, not executed writes): {report.get('safety_violations', 0):,}.",
        "Safety-invariant passes only establish the checked prohibition; they do not establish correct understanding.",
        "",
        "| Oracle | Cases | Passed | Failed | Review |",
        "|---|---:|---:|---:|---:|",
    ]
    for name, counts in report.get("oracle_kinds", {}).items():
        lines.append(
            f"| {name} | {counts['cases']} | {counts.get('passed', 0)} | {counts.get('failed', 0)} | {counts.get('review', 0)} |"
        )
    lines += [
        "",
        "| Template split | Cases | Passed | Failed | Review |",
        "|---|---:|---:|---:|---:|",
    ]
    for name, counts in report.get("splits", {}).items():
        lines.append(
            f"| {name} | {counts['cases']} | {counts.get('passed', 0)} | {counts.get('failed', 0)} | {counts.get('review', 0)} |"
        )
    lines += [
        "",
        "## Actual admission disposition",
        "",
        "Catalog clarification stops before product search, despite the coarse search route.",
        "",
        "| Disposition | Turns |",
        "|---|---:|",
    ]
    for name, count in report.get("dispositions", {}).items():
        lines.append(f"| {name} | {count} |")
    lines += ["", "## Python route coverage", "", "| Route | Turns |", "|---|---:|"]
    for name, count in report["routes"].items():
        lines.append(f"| {name} | {count} |")
    lines += [
        "",
        (
            f"**{report.get('semantic_pass_but_unmapped', 0):,} semantically passing conversations still contain an unmapped Python route.** "
            "A semantic pass therefore does not imply the assistant can fulfill the request. "
            "Review the complete route-gap cases in route-gaps.jsonl."
        ),
        "",
    ]
    for family, count in report.get("route_gap_families", {}).items():
        lines.append(f"- {family}: {count:,} conversations with an unmapped route.")
    lines += ["", "## Measured gaps and recommendations", ""]
    ranked = sorted(
        report["families"],
        key=lambda f: report["families"][f].get("failed", 0),
        reverse=True,
    )
    for family in ranked:
        counts = report["families"][family]
        if counts.get("failed") or counts.get("review"):
            lines.append(
                f"- **{family}** ({counts.get('failed', 0)} failed; {counts.get('review', 0)} review): {RECOMMENDATIONS.get(family, 'Review failures and add independently labeled regression cases.')}"
            )
    lines += ["", "## Representative failures", ""]
    for family, examples in report["examples"].items():
        for example in examples[:2]:
            message = (
                " → ".join(example["messages"]).replace("`", "'").replace("\n", " ")
            )
            failure = example["failures"][0]
            lines.append(
                f"- **{family}** `{example['id']}`: “{message}” — turn {failure['turn'] + 1}, `{failure['field']}` expected `{json.dumps(failure['expected'], ensure_ascii=False)}`, observed `{json.dumps(failure['actual'], ensure_ascii=False)}`."
            )
    lines += [
        "",
        "## Next validation",
        "",
        "1. Review failures by distinct phrasing and error type, rather than fixing thousands of expanded rows individually.",
        "2. Keep a held-out human-authored set, including production failures after redaction and consent. Split by template family, not random rows.",
        "3. Re-run fixed failures and negative controls; check that higher engine coverage does not increase wrong actions.",
        "4. Run authenticated journeys against an isolated local test stack for stock, prices, allergy evidence, permissions, cart changes, checkout and recovery.",
        "5. Once a paid sample is authorized, record final SSE response_source R/L, provider usage and independent answer-quality judgments; compare identical messages across engine and LLM paths.",
        "",
        f"Resolver latency (warm local process, includes context parsing; excludes startup and Python routing): {json.dumps(report['latency_ms'])}.",
        "",
        "Artifacts: cases.jsonl (inputs/oracles), results.jsonl or results.jsonl.gz (all responses/routes), failures.jsonl (all mismatches), review.jsonl (unjudged advice), report.json (aggregates), manifest.json (seed and source hashes).",
        "",
    ]
    return "\n".join(lines)


def finalize_report(report, output):
    gaps = Counter()
    passed_but_unmapped = 0
    with (
        open_observations(output / "results.jsonl") as stream,
        (output / "route-gaps.jsonl").open("w") as gap_file,
    ):
        for line in stream:
            row = json.loads(line)
            if any(turn["route"] == "unmapped" for turn in row["turns"]):
                gaps[row["family"]] += 1
                passed_but_unmapped += row["outcome"] == "passed"
                gap_file.write(line)
    report["route_gap_families"] = gaps
    report["semantic_pass_but_unmapped"] = passed_but_unmapped
    report["reporter_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    write_json(output / "report.json", report)
    (output / "report.md").write_text(report_markdown(report))


def evaluate(cases_path, output, node, timeout, workers=1, replay=None):
    sys.path.insert(0, str(ROOT / "commerce-assistant-platform"))
    # Fail before starting a large run if the environment cannot import production routing.
    from app.commerce_action_engine.execution.language.gate import (
        Resolution,  # noqa: F401
    )

    raws = [
        output / f"engine-results.{shard}.partial.jsonl" for shard in range(workers)
    ]

    def run_worker(shard):
        with (
            raws[shard].open("w") as stream,
            (output / f"worker-{shard}.log").open("w") as log,
        ):
            subprocess.run(
                [node, str(WORKER), str(cases_path), str(shard), str(workers)],
                stdout=stream,
                stderr=log,
                check=True,
                timeout=timeout,
                cwd=ROOT,
            )

    if replay is None:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for _ in pool.map(run_worker, range(workers)):
                pass
    else:
        raws = [replay / "results.jsonl"]
    families, scopes, outcomes, routes = (
        defaultdict(Counter),
        defaultdict(Counter),
        Counter(),
        Counter(),
    )
    examples, mismatches, confusion, latencies = (
        defaultdict(list),
        Counter(),
        Counter(),
        [],
    )
    templates, splits, oracle_kinds, risks = (defaultdict(Counter) for _ in range(4))
    dispositions, clusters = Counter(), Counter()
    cluster_examples = {}
    total, turns = 0, 0
    with ExitStack() as stack:
        cases = stack.enter_context(cases_path.open())
        responses = [stack.enter_context(open_observations(raw)) for raw in raws]
        results = stack.enter_context((output / "results.jsonl").open("w"))
        failures_file = stack.enter_context((output / "failures.jsonl").open("w"))
        review_file = stack.enter_context((output / "review.jsonl").open("w"))
        for row_index, line in enumerate(cases):
            case, observed = (
                json.loads(line),
                json.loads(next(responses[row_index % len(responses)])),
            )
            if replay is not None:
                if observed.get("messages") != case["messages"]:
                    raise ValueError("Replay messages do not match regenerated corpus")
                observed = {"id": observed["id"], "turns": observed["turns"]}
            if observed["id"] != case["id"] or len(observed["turns"]) != len(
                case["messages"]
            ):
                raise ValueError("Worker output does not match input corpus")
            failures = []
            for index, turn in enumerate(observed["turns"]):
                result = turn["result"]
                selected, disposition, plan = admission(result, case["messages"][index])
                turn["route"] = selected
                turn["disposition"] = disposition
                turn.pop("catalog_plan", None)
                if plan is not None:
                    turn["catalog_plan"] = plan
                turn["source"] = "local_engine"
                turn["llm_fallback_eligible"] = selected == "fallback"
                routes[selected] += 1
                dispositions[disposition] += 1
                families[case["family"]]["fallback_turns"] += selected == "fallback"
                latencies.append(turn["elapsed_ms"])
                for failure in score_turn(
                    case["expectations"][index], result, plan, selected
                ):
                    failures.append({"turn": index, **failure})
                    mismatches[failure["field"]] += 1
                expected = case["expectations"][index]
                if expected and "intent" in expected:
                    confusion[f"{expected['intent']} -> {result.get('intent')}"] += 1
            status = (
                "failed"
                if failures
                else "review"
                if any(e is None for e in case["expectations"])
                else "passed"
            )
            record = {**case, **observed, "outcome": status, "failures": failures}
            serialized = json.dumps(record, ensure_ascii=False) + "\n"
            results.write(serialized)
            if failures:
                failures_file.write(serialized)
                if len(examples[case["family"]]) < 5:
                    examples[case["family"]].append(
                        {k: record[k] for k in ("id", "messages", "failures")}
                    )
                key = (
                    case.get("template_id", case["family"]),
                    tuple(sorted({f["field"] for f in failures})),
                )
                clusters[key] += 1
                cluster_examples.setdefault(
                    key, {k: record[k] for k in ("id", "messages", "failures")}
                )
            if any(e is None for e in case["expectations"]):
                review_file.write(serialized)
            for counts in (
                families[case["family"]],
                scopes[case["scope"]],
                templates[case.get("template_id", case["family"])],
                splits[case.get("split", "legacy")],
                oracle_kinds[case["oracle_kind"]],
                risks[case.get("risk", "unspecified")],
            ):
                counts["cases"] += 1
                counts[status] += 1
            outcomes[status] += 1
            total += 1
            turns += len(case["messages"])
        if any(stream.readline() for stream in responses):
            raise ValueError("Unexpected extra worker results")
    latencies.sort()
    report = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "cases": total,
        "turns": turns,
        "measurement": "local_engine_and_python_route_only",
        "actual_llm_calls": 0,
        "full_assistant_evaluated": False,
        "outcomes": outcomes,
        "families": families,
        "scopes": scopes,
        "routes": routes,
        "mismatch_fields": mismatches,
        "intent_confusion": confusion,
        "dispositions": dispositions,
        "templates": templates,
        "splits": splits,
        "oracle_kinds": oracle_kinds,
        "risks": risks,
        "workers": workers,
        "replayed_observations": replay is not None,
        "latency_context": "local concurrent workers; not production latency",
        "safety_violations": mismatches["safety.resolved_intent"],
        "latency_ms": {
            "mean": round(sum(latencies) / len(latencies), 3),
            "p50": round(latencies[int((len(latencies) - 1) * 0.5)], 3),
            "p95": round(latencies[int((len(latencies) - 1) * 0.95)], 3),
        },
        "examples": examples,
    }
    finalize_report(report, output)
    write_json(
        output / "failure-clusters.json",
        [
            {
                "template_id": key[0],
                "fields": key[1],
                "count": count,
                "example": cluster_examples[key],
            }
            for key, count in clusters.most_common()
        ],
    )
    if replay is None:
        for raw in raws:
            raw.unlink()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command", choices=["generate", "run", "report", "replay", "actions"]
    )
    parser.add_argument(
        "--source",
        type=Path,
        help="Completed run to replay with current oracles; no Node execution",
    )
    parser.add_argument("--count", type=int, default=100000)
    parser.add_argument("--corpus", choices=["v1", "v2"], default="v1")
    parser.add_argument(
        "--language-scope",
        choices=["english", "all"],
        help="V2 defaults to English only; v1 retains its original multilingual corpus",
    )
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--seed", type=int, default=20260923)
    parser.add_argument(
        "--output", type=Path, default=ROOT / "artifacts/shopping-evals/100k"
    )
    parser.add_argument("--node", default="node")
    parser.add_argument("--timeout", type=int, default=1800)
    args = parser.parse_args()
    if args.command == "actions":
        from shopping_eval.actions import run as run_actions

        before = fingerprint()
        report = run_actions(ROOT, args.output, args.timeout)
        after = fingerprint()
        changes = sorted(
            k for k in before.keys() | after.keys() if before.get(k) != after.get(k)
        )
        report["source_hashes"] = before
        report["source_changes_during_run"] = changes
        if changes:
            report["status"] = "incomplete"
        write_json(args.output / "action-report.json", report)
        raise SystemExit(0 if report["status"] == "passed" else 1)
    source_manifest = None
    if args.command == "replay":
        if args.source is None:
            parser.error("replay requires --source")
        source_manifest = json.loads((args.source / "manifest.json").read_text())
        if source_manifest["status"] != "completed" or source_manifest.get(
            "source_changes_during_run"
        ):
            parser.error("Replay needs a completed run with stable sources")
        now = fingerprint()
        if any(
            now.get(k) != v
            for k, v in source_manifest["source_hashes"].items()
            if k.startswith("commerce-assistant-platform/")
        ):
            parser.error("Engine/admission sources changed; use a fresh run")
        args.count, args.seed = source_manifest["count"], source_manifest["seed"]
        args.workers = source_manifest.get("workers", 1)
        args.language_scope = source_manifest.get("language_scope", "all")
        args.corpus = (
            "v2"
            if source_manifest["corpus_version"].startswith("synthetic-shoppers-v2")
            else "v1"
        )
    if args.command == "report":
        manifest = json.loads((args.output / "manifest.json").read_text())
        if manifest["status"] != "completed":
            parser.error("Cannot summarize an incomplete run")
        finalize_report(
            json.loads((args.output / "report.json").read_text()), args.output
        )
        return
    args.language_scope = args.language_scope or (
        "english" if args.corpus == "v2" else "all"
    )
    if args.corpus == "v1" and args.language_scope != "all":
        parser.error("Use --corpus v2 for English-only generation")
    limit = 100000 if args.corpus == "v1" else 500000
    if not 1 <= args.count <= limit or args.timeout < 1 or not 1 <= args.workers <= 8:
        parser.error(
            f"--count must be 1..{limit}, --workers 1..8 and --timeout positive"
        )
    if args.output.exists() and any(args.output.iterdir()):
        parser.error("Use a new/empty output directory to preserve prior evidence")
    args.output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    cases_path = args.output / "cases.jsonl"
    manifest = {
        "corpus_version": VERSION if args.corpus == "v1" else corpus_v2.VERSION,
        "seed": args.seed,
        "count": args.count,
        "workers": args.workers,
        "language_scope": args.language_scope,
        "generation": "authored_compositional_templates_no_llm",
        "source_hashes": fingerprint(),
        "status": "generating",
    }
    write_json(args.output / "manifest.json", manifest)
    generated = 0
    try:
        with cases_path.open("w") as stream:
            generator = (
                generate(args.count, args.seed)
                if args.corpus == "v1"
                else corpus_v2.generate(args.count, args.seed, args.language_scope)
            )
            for case in generator:
                stream.write(json.dumps(case, ensure_ascii=False) + "\n")
                generated += 1
        manifest.update(
            status="generated",
            cases_sha256=file_hash(cases_path),
            generated_cases=generated,
        )
    except Exception as error:
        manifest.update(
            status="incomplete",
            stage="generation",
            error_type=type(error).__name__,
            generated_cases=generated,
        )
        raise
    finally:
        write_json(args.output / "manifest.json", manifest)
    print(f"Generated {args.count:,} unique conversations in {cases_path}", flush=True)
    if args.command in {"run", "replay"}:
        try:
            node = None
            if source_manifest is not None:
                manifest.update(
                    replay_source=str(args.source.resolve()),
                    observed_source_hashes=source_manifest["source_hashes"],
                    node=source_manifest.get("node"),
                )
            else:
                node = shutil.which(args.node)
                if not node:
                    raise RuntimeError("Node >=22.18 is required")
                manifest["node"] = subprocess.check_output(
                    [node, "--version"], text=True
                ).strip()
            report = evaluate(
                cases_path,
                args.output,
                node,
                args.timeout,
                args.workers,
                args.source if source_manifest else None,
            )
            final_hashes = fingerprint()
            manifest["source_changes_during_run"] = sorted(
                k
                for k in manifest["source_hashes"].keys() | final_hashes.keys()
                if manifest["source_hashes"].get(k) != final_hashes.get(k)
            )
            manifest.update(
                status="completed", elapsed_seconds=round(time.monotonic() - started, 2)
            )
            print(
                json.dumps(
                    {
                        "cases": report["cases"],
                        "outcomes": report["outcomes"],
                        "routes": report["routes"],
                        "report": str(args.output / "report.md"),
                    },
                    indent=2,
                )
            )
        except Exception as error:
            manifest.update(status="incomplete", error_type=type(error).__name__)
            raise
        finally:
            write_json(args.output / "manifest.json", manifest)


if __name__ == "__main__":
    main()
