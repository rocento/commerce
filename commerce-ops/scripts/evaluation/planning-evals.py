"""Verify M05 preserves frozen English answers, proposals and call counts."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))


import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "commerce-assistant-platform"))
from evals.lab.cli import write_report
from evals.lab.models import EvaluationScope, load_dataset
from evals.lab.runner import run


async def main():
    dataset = load_dataset(ROOT / "commerce-assistant-platform/evals/lab/commerce-v1.json")
    scope = EvaluationScope.model_validate_json(
        (ROOT / "commerce-assistant-platform/evals/lab/m02-english-scope.json").read_bytes()
    )
    baseline = await run(
        dataset,
        scope=scope,
        grounded_intent=True,
        commerce_core=True,
        commerce_meaning=True,
    )
    candidate = await run(
        dataset,
        scope=scope,
        grounded_intent=True,
        commerce_core=True,
        commerce_meaning=True,
        commerce_planning=True,
    )
    output = ROOT / "artifacts/evaluation-lab/m05-parity"
    write_report(output / "baseline", baseline)
    write_report(output / "candidate", candidate)
    differences = []
    plans = 0
    for before, after in zip(baseline.results, candidate.results, strict=True):
        if (
            before.id != after.id
            or before.status != after.status
            or before.provider_calls != after.provider_calls
            or len(before.trace) != len(after.trace)
        ):
            differences.append(before.id)
        for left, right in zip(before.trace, after.trace, strict=True):
            plans += bool(right.get("planning"))
            for key in [
                "answer",
                "error",
                "draft",
                "product_ids",
                "planner_methods",
                "extracted",
                "provider_models",
            ]:
                if left.get(key) != right.get(key):
                    differences.append(before.id + ":" + key)
    result = {
        "status": "passed"
        if baseline.status == candidate.status == "passed" and not differences
        else "failed",
        "cases": len(candidate.results),
        "planned_turns": plans,
        "differences": differences,
        "scope": "English frozen model/retrieval replay; not live quality",
    }
    (output / "parity.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
    return int(result["status"] != "passed")


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
