# Enterprise knowledge Phase 0 baseline

> Historical record: identities, commands and results apply to the recorded candidate only.
> For current operations, use the [language release lifecycle](../language-release-upgrade.md)
> and [shared database runbook](../shared-database-operations.md). See the [history index](README.md).

Date: 2026-10-10 (Africa/Cairo)  
Status: Phase 0 complete under owner approval with delegated AI assessment. Benchmark cases remain unexecuted.

## Scope and evidence

This phase audits the existing system and historical cases. It does not change runtime rules, production databases, or original CSV grades. No new shopping requests, order actions, or bulk live evaluation were performed.

Evidence directory: [`output/enterprise-knowledge-phase0-20261010`](../../platform/evidence/README.md#evidence-8c8273bc678d7156) (`output/enterprise-knowledge-phase0-20261010`).

- [Baseline summary](../../platform/evidence/README.md#evidence-0dd13b7ee15f02d0) (`output/enterprise-knowledge-phase0-20261010/baseline-summary.json`)
- [Release and rule inventory](../../platform/evidence/README.md#evidence-f08f761f9fad9527) (`output/enterprise-knowledge-phase0-20261010/release-inventory.json`)
- [Schema, indexes, constraints, and query plans](../../platform/evidence/README.md#evidence-758da7b15f99165c) (`output/enterprise-knowledge-phase0-20261010/production-inventory.json`)
- [Frozen source and input manifest](../../platform/evidence/README.md#evidence-18c0f98285bcfac0) (`output/enterprise-knowledge-phase0-20261010/snapshot-manifest.json`)
- [Offline language replay](../../platform/evidence/README.md#evidence-ed09ca8174becdf5) (`output/enterprise-knowledge-phase0-20261010/offline-language-replay.json`)
- [Per-case provisional failure classification](../../platform/evidence/README.md#evidence-7dcf291c556acbd7) (`output/enterprise-knowledge-phase0-20261010/case-classification.json`)
- [Local performance](../../platform/evidence/README.md#evidence-932ad00f7bd14249) (`output/enterprise-knowledge-phase0-20261010/local-performance.json`)
- [Production runtime identity and memory snapshot](../../platform/evidence/README.md#evidence-77e7e4eb0ac10cd9) (`output/enterprise-knowledge-phase0-20261010/production-runtime.jsonl`)
- [Benchmark review packet](../../platform/evidence/README.md#evidence-b84bd43678fcd273) (`output/enterprise-knowledge-phase0-20261010/benchmark-review.md`)
- [Approved benchmark revision 2](../../platform/evidence/README.md#evidence-84287ae03b7dd212) (`output/enterprise-knowledge-phase0-20261010/benchmark-approved.json`)

The manifest hashes the CSV, original case metadata, grading code, raw observations, and historical catalog files. The baseline has no new complete commerce catalog snapshot. The historical product files are evidence captured for the original evaluation; their hashes establish identity, not completeness or present-day availability.

## Verified release

All four live demos report the same ready language release and executable identity. The frozen local parser has the same executable identity.

| Item | Verified value |
| --- | --- |
| Active release | `80882336-f1a0-4cdf-bac3-1eebaccc58ea` |
| Knowledge revision | 5 |
| Dictionary version | 8 |
| Artifact fingerprint | `27f4c21a9b5d974fc66dca1460fd6805f4c358e68e89e4d95ca0c088d93d26d4` |
| Executable fingerprint | `c7f3c2f3b25adcab267acf2d2e208ee2c68424affcbde53f8465d680a36c0fad` |
| Latest language migration | `027_reviewed_evaluation.sql` |
| Concepts / canonical and alternate forms | 563 / 1,160 |
| Relationship rules | 38 |
| Sentence-rule families / phrases | 20 / 339 |
| Question-rule families / templates | 11 / 31 |
| Intents / semantic groups / entity forms | 181 / 527 / 550 |
| Registered reviewed datasets | 0 |

The local artifact and database artifact match after one documented export normalization: the local artifact includes `corpus: []`, while the database artifact omits that empty evaluation field. All other fields match exactly. Normalized authoring-table counts are recorded separately and are not treated as proof of published runtime content.

## Database and code ownership

These findings describe inspected execution paths, not just tables that happen to exist. A vocabulary or rule change has no runtime effect until the existing release workflow publishes it.

| Behavior | Current owner | Database or source evidence | Phase 1 implication |
| --- | --- | --- | --- |
| Contextual concepts and aliases | Published database knowledge | `knowledge.concepts`, `knowledge.aliases`; `src/language-knowledge.ts` | Extend these existing records |
| For/with/from and other typed relationships | Published knowledge plus bounded executor | `knowledge.rules`; `src/relationship-grammar.ts`, `src/contextual-language.ts` | Preserve scope, negation, ambiguity and source spans |
| Whole-sentence preferences, background and budget templates | Published knowledge plus slot validation | `knowledge.utterance_rules`; `src/utterance-language.ts` | Reuse templates; do not duplicate a new budget-rule store |
| Product-read and compatibility question templates | Published knowledge plus bounded slots | `knowledge.question_rules`; `src/question-language.ts` | Extend typed templates with counterexamples |
| Search action words and entity aliases | Published dictionary | `lexicon.terms`, `semantic.terms`, `semantic.groups`, `entity.terms`, `entity.aliases` | Use shared lexical records and publication workflow |
| Intent rules and evidence scoring | Published dictionary plus resolver | `intent.definitions`, `intent.rules`, `intent.rule_conditions`; `src/engine.ts` | Review active artifact behavior, not authoring rows alone |
| Search openings such as “I need” | Code in contextual parser, with overlapping dictionary words | `src/contextual-language.ts: searchHead` | Candidate for constrained database-authored patterns |
| Inline “my limit is” suffix | Code-owned rewrite | `src/contextual-language.ts: priceTail` | Separate from already database-backed whole budget sentences |
| Currency aliases and money syntax | Code | `src/price-language.ts`, `src/correction-numbers.ts`, `src/entities.ts` | Aliases are possible data candidates; numeric parsing stays validated code |
| Comparison operators | Generated source contract | `src/comparison-operators.ts`, `scripts/generate_comparison_operators.py` | Preserve Node/Python contract parity; not currently free-form DB behavior |
| Quantity, dates, ordinals, product/request boundaries | Primarily code | `src/entities.ts`, `src/order-product-language.ts`, `src/engine.ts` | Inventory individual migrations before moving patterns |
| Conditional/unsafe phrase guards and source-span checks | Code | `src/contextual-language.ts`, `src/question-language.ts`, `src/evidence-requirements.ts` | Retain hard execution boundaries; do not blindly migrate guards |
| Conversation state and rejection identity | Mixed published phrases and validated code/state | `context.sessions`; `src/context.ts`; Python shopping context | Missing identities must not be invented |
| Product suitability and compatibility | Catalog facts and Python policy checks | `app/commerce_action_engine/actions/shopping/context.py`, `evidence.py` | Activity recognition still needs evidence-based domain profiles |
| Release lifecycle and evaluation audit | Existing database workflow | `release.drafts`, `release.candidates`, `release.evaluations`, `release.channels` | Extend existing controls instead of adding another publisher |
| Human-reviewed datasets and feedback | Existing database workflow, currently no registered datasets | `evaluation.datasets`, `evaluation.cases`, `resolution.feedback_reviews` | Prepare genuine reviewed inputs before import |

Language-source paths above are relative to `ai-service/app/commerce_language_engine/`; Python paths are relative to `ai-service/`. The frozen language source is saved in the evidence directory to preserve line-independent auditability while the shared checkout evolves.

## Historical observations and current replay

The unchanged historical CSV contains 4,000 conversations and 4,675 turns. Its recorded grades are **168 good, 233 partial, and 3,599 bad**. Those grades assess historical responses using automated checks and model-reviewed patterns. They are not independent human labels.

The frozen current parser passes **1,440/4,675 turns (30.80%)** and **1,277/4,000 complete conversations (31.93%)** under `shopper-language-semantics-v3`. Passing means every applicable minimum language check passes; it does not certify retrieval, product facts, final answer quality, or live execution.

| Store | Historical cases | Current language turns passed / total |
| --- | ---: | ---: |
| Electronics | 1,001 | 391 / 1,189 |
| Grocery | 977 | 392 / 1,146 |
| Jewelry | 1,030 | 320 / 1,191 |
| Pharmacy | 992 | 337 / 1,149 |

High-volume failing checks include family routing (2,216 turns), intended-use retention (509/597 applicable turns), recipient retention (359/450), budget-cap interpretation (748/1,522), and follow-up discourse (426/500). These counts overlap and must not be added as unique failed cases.

There are 15 `no_unrequested_write` language-check failures, all `CREATE_ORDER` interpretations for electronics replacement/delivery questions, with `NEEDS_CONTEXT` status. These are routing findings, not evidence that an order was placed. Review purchase-versus-availability ambiguity and the evaluator's expected routes before implementing a fix.

## Failure classification and limits

Every case has a separate classification record linked to its original case ID, original grade/reason, and current failed semantic checks. The historical taxonomy maps observed labels to provisional symptoms:

| Provisional category | Cases with that label |
| --- | ---: |
| Response quality | 2,898 |
| Interpretation | 689 |
| Context | 175 |
| Retrieval/product match | 38 |
| Reported unsupported action | 135 |
| Operational/service error | 17 |
| No-match with unresolved cause | 352 |

Categories overlap. Unsupported-action wording does not establish whether the underlying cause was a wrong interpretation or an actually unsupported capability. No-match wording cannot prove whether products were absent, facts were missing, or retrieval was defective.

125 conversations contain an uncertainty/missing-information wording signal. This is a review lead, not a confirmed count of missing catalog evidence. Missing catalog evidence and evaluation errors remain explicit unknowns until adjudicated; the report does not fabricate root-cause counts.

Representative source review:

| Case | Observation | Baseline conclusion |
| --- | --- | --- |
| `ELECTRONICS-0001` | “online, classes, limit, is, 40” leaked into the unsupported feature request | Historical interpretation/filter defect is visible in the response |
| `ELECTRONICS-0005` | Follow-up asks for the product again after the laptop request | Historical context-loss symptom is visible |
| `ELECTRONICS-2006` | Exact MacBook request received no match; historical assessment references the saved catalog | Retrieval/product matching investigation; availability/context still needs checking |
| `ELECTRONICS-0009` | Assistant said the store action was unconnected | Reported unsupported action; internal route is not proven by the response |
| `GROCERY-0446` | Product details could not be checked | Service/integration failure signal; vocabulary alone is not a sufficient remedy |
| `ELECTRONICS-0004` | Generic no-match for a $40 laptop request | Poor guidance may be real, but absence of suitable stock can be legitimate |
| `ELECTRONICS-1104` | Conditional return-policy question treated as an executable condition | Historical interpretation defect is visible |
| `ELECTRONICS-2004` | Exact iPad search returned the iPad plus Apple TV and phone alternatives; original grade was good | Rubric checks target inclusion, not exact-search precision; flag for stricter future evaluation, preserve original grade |

The current evaluator also has coverage limits: family-route acceptance can allow a targeted clarification or unsupported result, and follow-up checks inspect language context without actual assistant recommendation history. These are minimum semantics checks. Final response usefulness and reference handling require separate action-flow and live evaluations.

## Benchmark and hold-out preparation

- All historical 4,000 cases remain development/regression material.
- A deterministic scenario-family split reserves some historical cases for future regression runs. It is explicitly **not an independent hold-out**, because the corpus was already used during development.
- The owner-approved benchmark has 8 development cases and 16 reserved cases, split by complete semantic family. The original candidate remains unchanged; approval and clarified expectations are recorded in revision 2.
- Candidate expectations were proposed from shopper needs before running any candidate through the engine. No candidate has been executed or imported into production.
- Exact normalized overlap against all 10,000 original generated prompts is zero. Semantic overlap may remain; independence is not claimed from this check alone.
- Approval and assessment are recorded separately: the project owner approved suitable cases, and Codex performed the requested realism/correctness assessment. This is not independent human case-by-case adjudication.

On 2026-10-10, after accepting the reviewer assignment, the user instructed: “all approved if u see it relastice and good answers”. Codex reviewed all 24 prompts and their proposed obligations and found them realistic and useful for an initial benchmark. The review gate is closed under this explicitly authorized method. This approval concerns expected behavior, not actual engine answers.

Revision 2 makes USD test-fixture assumptions explicit while preserving ambiguous currency in EK0-003/004. EK0-019 distinguishes unscented labeling from fragrance-free claims. EK0-023/024 require product/batch identification and avoid promising the expiry of an unallocated shipment. The unit-price calculations were independently checked. Source links and per-case rationale are recorded in the approved artifact. No shopper prompt changed.

Executable assertions and identified catalog fixtures are next-stage work; no dataset has been imported into production, and no reserved prompt has been run. Later reports must retain the distinction between owner approval, AI assessment, independent human review, and measured engine correctness.

## Performance and storage baseline

Local benchmark: Apple M4 Pro, 14 logical CPUs, Node v25.9.0, one process, sequential parser calls. After 250 warm-up first turns, 4,675 turns measured median **5.31 ms**, p95 **8.64 ms**, p99 **10.90 ms**, maximum **26.00 ms**, and approximately **199 turns/second**. Import plus compile took **80.88 ms** in this harness.

The local harness peak RSS was about **481 MiB**, including the loaded CSV, 10,000-case source metadata, and benchmark machinery. It is not the isolated engine footprint. Production uses Node v22.18.0; these local timings are not a production SLA or concurrency test.

One production Docker snapshot showed language containers at **60–73 MiB**, Python assistants at **74–75 MiB**, and shared PostgreSQL at **184 MiB**. These are point-in-time measurements, not peaks under load.

| Database | Measured bytes | Approximate MiB |
| --- | ---: | ---: |
| `commerce_language` | 202,759,191 | 193.37 |
| `assistant` | 12,418,071 | 11.84 |

The largest language relations are `migration_archive.source_rows` (about 100 MiB), `utterance.generated` (about 59.6 MiB including indexes), and `release.dictionaries` (about 18.5 MiB). This database's total size is not a measure of active knowledge richness.

Three bounded, read-only `EXPLAIN (ANALYZE, BUFFERS)` plans are retained: active-release lookup, active-pack concept lookup, and exact lexicon lookup. They are observations on the current small tables, not proof of performance at million-record scale. Do not infer missing indexes from a planner choosing a sequential scan on a tiny table.

Historical HTTP conversation latency was p50 **1,520 ms**, p95 **2,992 ms**, p99 **4,453 ms**. Conversation totals may include multiple turns and different workloads; they must not be compared directly to local parser timings.

## Prospective gates for the next phase

Freeze these gates before measuring a candidate:

1. Preserve every currently passing mandatory assertion in this frozen regression corpus. Any intended change requires a documented, independently reviewed expectation change rather than silently changing the rubric.
2. Report both per-check and whole-conversation results. Do not substitute `RESOLVED` rates for correctness.
3. Add a positive, negative, ambiguous, and context-continuation test for every migrated language-rule family.
4. The benchmark is owner-approved after AI review; do not call it independently human-adjudicated. Reserved cases become measured validation only after an evaluation with a fixed rubric, release, and fixture identity. Their results must not be used to tune the same release.
5. Before production promotion, adjudicate and address the 15 flagged order-related routes and verify actual execution admission separately. Recognition must not be reported as an executed write.
6. On the same local harness/environment, investigate p95 latency regressions above 20% and peak harness RSS regressions above 20%. These are provisional change-detection thresholds, not production capacity commitments. Rebaseline if hardware, Node, inputs, or measurement method changes.
7. Preserve published artifact/runtime identity checks, tenant isolation, and existing release gates. No new bulk live run is included in this phase.

## Reproduction

Run from the repository root. Use a new output directory for a new baseline; the snapshot command refuses to overwrite its manifest.

```sh
node scripts/knowledge-baseline/snapshot.mjs output/enterprise-knowledge-phase0-NEW
```

For the saved baseline:

```sh
node output/enterprise-knowledge-phase0-20261010/engine/scripts/evaluate-shopper-csv.ts \
  --csv output/live-shopper-eval-20261008/live-shopping-assistant-4000-english.csv \
  --cases output/live-shopper-eval-20261008/cases.json \
  --engine-root output/enterprise-knowledge-phase0-20261010/engine \
  --output output/enterprise-knowledge-phase0-20261010/offline-language-replay.json
node scripts/knowledge-baseline/analyze.mjs
node scripts/knowledge-baseline/benchmark.mjs
node --test scripts/knowledge-baseline/lib.test.mjs
node scripts/knowledge-baseline/verify.mjs
```

The SQL and runtime scripts in `scripts/knowledge-baseline/` collect read-only production metadata through the existing SSH/operator workflow. They contain no passwords. The saved published artifact and database metadata are required by `analyze.mjs`; do not replace them with a newer release and still call the output the same baseline. Use a fresh directory and snapshot for future comparisons. Timings and capture timestamps will naturally vary on rerun.
