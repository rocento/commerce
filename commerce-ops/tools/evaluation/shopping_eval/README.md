# Shopping evaluation support package

This package supports the canonical [shopping evaluation command](../shopping-evals.py).
It is actively imported by that runner and by assistant-platform regression
checks.

- `corpus.py` contains the original authored synthetic shopper corpus.
- `corpus_v2.py` extends it with independently authored conversations and
  expectations; its `held-out` split is a template partition, not an
  independently human-labeled benchmark.
- `actions.py` runs focused existing application test suites and summarizes
  their reports.
- `engine-worker.mjs` sends JSONL conversations through the real local language
  runtime without making commerce writes. `recommendation_eval/` shares this
  worker for its separate fixed 1,000-case report pipeline.

Keep expectations independent from resolver output. Store run artifacts under a
new output directory using `shopping-evals.py`; do not overwrite retained
reports while comparing a candidate.
