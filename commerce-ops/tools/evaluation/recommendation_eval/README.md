# Fixed recommendation evaluation pipeline

This folder owns the reproducible 1,000-request English recommendation
assessment recorded under `commerce-docs/platform/qa/recommendations-1000/`.
It is a retained, fixed-corpus evaluation pipeline rather than a general-purpose
commerce operation.

## Pipeline

1. `generate.py` creates the synthetic authored corpus at `cases.jsonl`.
2. `run.py --label LABEL` evaluates the frozen corpus through the language
   engine and writes `LABEL-raw.jsonl` and `LABEL-results.json`.
3. `runtime.py` checks the saved candidate against the in-process assistant API
   with a fixture catalog, then writes `runtime-results.json`.
4. `report.py` combines the baseline, candidate, runtime, and any saved live
   request results into `summary.json` and `report.html`.

The runner shares `shopping_eval/engine-worker.mjs`; its corpus and scoring
expectations remain specific to recommendation phrasing, filters, follow-ups,
and evidence guards. The two evaluation packages share runtime plumbing but do
not share evaluation corpora or report outputs.

`generate.py`, `runtime.py`, and `report.py` write into the retained QA
artifact directory. Preserve the existing corpus and reports when reproducing
a past result; use a separately versioned output location for a new evaluation.
The candidate runner itself uses the local language engine, and the runtime
stage uses an in-process test client with a fixture catalog.
