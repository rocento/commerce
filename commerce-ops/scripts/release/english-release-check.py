"""Run local English-plan release checks and save commands, outcomes and source hashes."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))


import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PYTHON = ROOT / "commerce-assistant-platform/.venv/bin/python"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--database",
        action="store_true",
        help="Require disposable M04_TEST_DATABASE_URL and M05_TEST_LANGUAGE_URL",
    )
    args = parser.parse_args()
    if args.output.exists():
        parser.error(
            "Choose a new evidence directory; historical evidence is immutable"
        )
    if args.database and not all(
        os.getenv(key) for key in ["M04_TEST_DATABASE_URL", "M05_TEST_LANGUAGE_URL"]
    ):
        parser.error("Explicit disposable database and local Node HTTP URL required")
    args.output.mkdir(parents=True)
    service = ROOT / "commerce-assistant-platform"
    patterns = [
        "test_knowledge*.py",
        "test_product_facts.py",
        "test_answer_evidence_review.py",
        "test_feedback_review.py",
        "test_semantic*.py",
        "test_intent_examples.py",
        "test_intent_example_reviews.py",
        "test_intent_rag_chat.py",
        "test_language_fallback.py",
        "test_proposal_constraints.py",
        "test_live_interpretation.py",
        "test_requested_actions_contract.py",
        "test_reasoning_admission.py",
        "test_provider_settings.py",
        "test_assistant.py",
        "test_shopping_intent_regressions.py",
        "test_comparison*.py",
        "test_followup_boundary.py",
        "test_interpreted_followups.py",
        "test_selected_order_context.py",
        "test_shopping_selection_context.py",
        "test_completion.py",
        "test_completion_store.py",
        "test_delivery_history.py",
        "test_market_policy.py",
        "test_pilot_guides.py",
        "test_runtime.py",
    ]
    tests = sorted(
        {
            str(p.relative_to(service))
            for pattern in patterns
            for p in (service / "tests").glob(pattern)
            if p.name != "test_knowledge_store.py"
        }
    )
    checks = [
        ("python", service, [str(PYTHON), "-m", "pytest", *tests, "-q"]),
        ("architecture", ROOT, [str(PYTHON), "commerce-ops/scripts/check-ai-architecture.py"]),
        (
            "release-tests",
            ROOT,
            [
                str(PYTHON),
                "-m",
                "pytest",
                "commerce-ops/scripts/tests/test_ai_architecture.py",
                "commerce-ops/scripts/tests/test_ai_deployment.py",
                "-q",
            ],
        ),
        ("node", service / "app/commerce_language_engine", ["npm", "test"]),
        (
            "holdout",
            ROOT,
            [
                str(PYTHON),
                "commerce-ops/scripts/semantic-recovery-eval.py",
                "--output",
                str(args.output.resolve() / "holdout.json"),
            ],
        ),
        (
            "baseline",
            ROOT,
            [
                str(PYTHON),
                "commerce-ops/scripts/english-plan-baseline.py",
                "--output",
                str(args.output.resolve() / "baseline.json"),
                "--compare",
                "rocento-english-understanding/evidence/stage05/default-baseline.json",
            ],
        ),
    ]
    if args.database:
        checks.append(
            (
                "database",
                service,
                [
                    str(PYTHON),
                    "-m",
                    "pytest",
                    "tests/test_knowledge_store.py",
                    "tests/test_intent_examples_postgres.py",
                    "-q",
                ],
            )
        )
    results = []
    for name, cwd, command in checks:
        with (args.output / f"{name}.log").open("w") as log:
            try:
                result = subprocess.run(
                    command,
                    cwd=cwd,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    timeout=300,
                    check=False,
                    env={
                        **os.environ,
                        "ENGLISH_VOCABULARY_TEST_DATABASE_URL": os.environ[
                            "M04_TEST_DATABASE_URL"
                        ],
                    }
                    if args.database and name == "node"
                    else None,
                )
                code = result.returncode
                if name == "baseline" and code == 0:
                    comparison = json.loads(
                        (args.output / "baseline.json").read_text()
                    )["comparison"]
                    if comparison["changed_cases"] or comparison["boundaries_changed"]:
                        code = 1
            except subprocess.TimeoutExpired:
                code = 124
        results.append(
            {
                "name": name,
                "cwd": str(cwd.relative_to(ROOT)),
                "command": command,
                "exit_code": code,
            }
        )
        print(f"{name}: {'passed' if code == 0 else 'FAILED'}", flush=True)
    paths = sorted(
        set((service / "app").rglob("*.py"))
        | set((service / "app/commerce_language_engine/src").glob("*.ts"))
    )
    manifest = {
        "date": datetime.now(UTC).isoformat(),
        "checks": results,
        "database_checked": args.database,
        "source_sha256": {
            str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in paths
        },
        "limitations": [
            "Local synthetic/fixture evidence; no independent customer accuracy claim.",
            "No paid provider calls or production deployment.",
            "Database check uses deterministic embeddings; production retrieval quality unmeasured.",
        ],
    }
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return int(any(r["exit_code"] for r in results))


if __name__ == "__main__":
    sys.exit(main())
