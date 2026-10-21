# Enterprise knowledge expansion — batch 2

> Historical record: identities, commands and results apply to the recorded candidate only.
> For current operations, use the [language release lifecycle](../language-release-upgrade.md)
> and [shared database runbook](../shared-database-operations.md). See the [history index](README.md).

Date: 2026-10-10. Status: local candidate, baseline measurements and authoring increment completed with explicit remaining gaps. No production database changes or deployment.

## Baseline measurements completed

The isolated PostgreSQL 16 database uses the captured published revision-10 vocabulary: 3,516 concepts, 5,580 forms, fingerprint `1db6ecd8…`, and all 136,368 archived cases. It is a representative local dataset, not a production hardware/load simulation or a GB-scale capacity result.

- 12,000 lookups: three 2,000-query runs at concurrency 1 and three at concurrency 8, with 20% misses. p95: **0.39–0.65 ms**. Throughput: approximately **2,806–2,911 queries/s** at concurrency 1 and **15,619–16,024 queries/s** at concurrency 8.
- Three fresh interrupted/resumed imports: each uploaded **3,516 actual concepts in eight chunks**, paused after 500 and resumed without lost records. Chunk upload: **96.6–108.1 ms**, approximately **32,540–36,381 concepts/s**. Finalization: **3.62–3.76 seconds**.
- End-to-end import throughput, including finalization: **911–945 concepts/s**. The upload threshold passes, but the provisional 1,000 concepts/s target does **not** pass when interpreted as total import throughput. Finalization optimization remains a measured follow-up; upload speed is not presented as complete import speed.
- Database size: **24,109,583 bytes** after baseline loading, **74,359,311 bytes** after retained import fixtures. Data, indexes and total relation sizes are recorded separately. This growth includes retained snapshots and import staging; it is not newly acquired knowledge.
- A further 12,000 alternating revision-10/revision-12 lookups in the same database measured median p95 **1.13→1.19 ms**, +5.31%, within the 20% investigation threshold. These ran alongside archive workers and are recorded separately from the quiet baseline.
- Query plans were captured. The current lookup workload does not justify a new index or partition. Runtime pack limits remain unchanged.

Benchmark-only revisions 101/102 reuse actual vocabulary to measure fresh imports rather than idempotent retries. They are disposable test records, not proposed releases. The isolated active release never changed after fixture bootstrap. The earlier harness failure from a missing recognition context is retained in `baseline.log`; the corrected run is separate.

## Frozen acceptance and revision-12 candidate

Forty English cases and provisional performance thresholds were saved and hashed before implementation. Twenty-four cases are development examples and sixteen use reserved wording or boundaries. All labels are AI-authored; reserved wording is not an independent human-reviewed benchmark.

Relative to revision 11:

- **Eight new recipient-role concepts:** music teacher, dance teacher, swimming coach, tennis coach, football coach, driving instructor, fitness trainer, wedding planner.
- **Sixteen role aliases**, such as music instructor, swim coach, driving tutor and wedding coordinator.
- **Eight occasion aliases**, such as birthday gathering, graduation day, new home celebration and alumni reunion.
- **Two governed rules:** “as a present for” → recipient; “in celebration of” → occasion. Recipient alternatives require clarification.

Totals: **3,524 concepts, 5,628 forms and 94 governed rules**. The increase is eight concepts and 32 forms including their canonical names. Recognition-definition count is unchanged. Source is first-party English wording with explicit AI-assisted review and content hashes. These meanings do not infer product suitability, demographic preferences or merchant facts.

Language acceptance improves **7/40→39/40**. The frozen contradictory-budget case (“under $5 and over $100”) is still marked resolved by the Node language layer on both baseline and candidate. This expectation remains failed; it was not relabeled to claim 40/40. Python creates a price-range clarification and makes no product search, so the execution boundary remains safe. Thirty-two positive Node-to-Python admission cases and that complete budget safeguard check pass: **33/33**. Node-level budget consistency remains a release gap.

## Missing authoring capability delivered

[Operator instructions](../knowledge-authoring.md) document the new `knowledge-author.ts` tool. It adds, retires and replaces aliases on existing concepts in a new immutable draft revision. Preview is default. Expected pack hash and draft revision protect against stale edits; validators enforce provenance, collisions and scope. Exact edits, reviewer, actor, source, reason and diff are recorded in existing `release.draft_changes`.

Real PostgreSQL tests verify preview makes no changes, two concurrent writers produce one winner, stale writers are rejected, prior revisions cannot be updated, audit records persist, and the candidate imports without activation. No new tables or migration were necessary.

This increment does not implement concept merging, canonical renaming, arbitrary rule editing or rejected-row quarantine. New concepts/rules continue through existing reviewed whole-pack/draft and resumable import workflows. The remaining database-tool milestones stay open.

## Evidence and release status

Evidence: `output/enterprise-knowledge-expansion-batch2-20261010/`.

- `acceptance-lock.json`: frozen inputs and hashes.
- `baseline-results.json`, `import-end-to-end.json`, `paired-database-results.json`: lookup/import/size evidence and limitations.
- `author-database-results.json`: real draft/concurrency/import checks.
- `acceptance-results.json`, `python-admission-verified.log`: separate language/admission outcomes.
- `candidate-pack-v12.json`, `candidate.json`: local candidate artifacts.
- `archived-benchmark.json`: **136,368 passed**, zero failures and wire errors.
- Targeted Node checks: 17 passed, then all five strict authoring checks passed after adding unknown-field rejection; TypeScript passes.
- `performance-results.json`: three alternating fresh-process comparisons on the frozen runtime. Median p95 **13.11→13.15 ms** (+0.26%), compile **693.91→689.42 ms** (−0.65%), RSS **272,144→269,552 KiB** (−0.95%). All candidate regression thresholds pass.
- The disposable database was removed after saving its evidence; test rows were not copied into a developer or production database.

Publication requires a combined immutable release freeze, exact-candidate evaluation, matching Node/Python artifacts and promotion/rollback checks. The contradictory-budget Node expectation and end-to-end importer target are explicit remaining gaps. No live bulk assistant evaluation was resumed, and Arabic remains excluded.
