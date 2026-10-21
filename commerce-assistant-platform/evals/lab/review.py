"""Human rubric and failure intake. Never auto-promote model outputs into gold."""

from evals.lab.runner import digest


def review_queue(report):
    selected = {}
    for row in report.results:
        if row.status != "passed" or row.journey not in selected:
            selected[row.id if row.status != "passed" else row.journey] = row
    return {
        "version": "1",
        "dataset_sha256": report.dataset_sha256,
        "runtime_sha256": report.runtime_sha256,
        "status": "pending_human_review",
        "judge": {
            "enabled": False,
            "provider": None,
            "model": None,
            "rubric_version": "1",
            "repetitions": 0,
            "variance": None,
            "calibration": "No human labels yet; automated judging is disabled.",
        },
        "rubric": {
            "helpfulness": "0: no usable next step; 1: partly usable; 2: completes the stated goal or gives a necessary actionable clarification.",
            "tradeoffs": "0: misleading/hidden constraint trade-off; 1: incomplete; 2: explains budget, fit, missing facts and alternatives when relevant.",
            "over_questioning": "0: unnecessary/repeated questions; 1: partly redundant; 2: asks only for information required for a safe useful next step.",
            "trust": "0: unsupported facts/promises or hidden action; 1: incomplete uncertainty/sources; 2: grounded, scoped, explicit uncertainty and customer control.",
        },
        "promotion_rule": "A reviewer must verify the scoped observation, independently write expected assertions, add a regression case, and review the dataset diff. Never copy an answer to gold solely because the model produced it.",
        "items": [
            {
                "case_id": r.id,
                "status": r.status,
                "failure_layers": [f.layer for f in r.failures],
                "assertions": [f.assertion for f in r.failures],
                "trace_sha256": digest(r.trace),
                "reviewer": None,
                "reviewed_at": None,
                "scores": None,
                "evidence": None,
                "resolution": None,
            }
            for r in selected.values()
        ],
    }
