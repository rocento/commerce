"""M02-lab M04 acceptance and labeled unnecessary-question rate (English synthetic)."""

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
from evals.lab.models import load_dataset
from evals.lab.runner import run


async def main():
    dataset = load_dataset(ROOT / "commerce-assistant-platform/evals/lab/m04-meaning.json")
    labels = json.loads(
        (ROOT / "commerce-assistant-platform/evals/lab/m04-clarification-labels.json").read_text()
    )
    report = await run(
        dataset, grounded_intent=True, commerce_core=True, commerce_meaning=True
    )
    output = ROOT / "artifacts/evaluation-lab/m04-meaning"
    write_report(output, report)
    observations = {
        row.id: any(
            t.get("meaning", {}).get("meaning_clarifications", 0) for t in row.trace
        )
        for row in report.results
    }
    assert set(observations) == set(labels)
    unneeded = sum(observations[k] and not expected for k, expected in labels.items())
    missing = sum(not observations[k] and expected for k, expected in labels.items())
    eligible = sum(not expected for expected in labels.values())
    metric = {
        "scope": "labeled English synthetic M04 cases, not production/human rubric",
        "status": report.status,
        "unnecessary_questions": unneeded,
        "eligible_turns": eligible,
        "unnecessary_question_rate": unneeded / eligible,
        "missed_required_questions": missing,
        "observations": observations,
    }
    (output / "clarification.json").write_text(json.dumps(metric, indent=2) + "\n")
    print(json.dumps(metric))
    return int(report.status != "passed" or unneeded or missing)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
