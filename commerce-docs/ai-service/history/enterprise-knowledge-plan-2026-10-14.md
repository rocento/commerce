# Enterprise shopping knowledge implementation plan

> Historical snapshot retained on 2026-10-14. This preserves the full planning and implementation narrative before consolidation, including superseded milestones and candidate states. Use the [current enterprise knowledge plan](../plans/enterprise-knowledge.md) for remaining work and the [history index](README.md) for release-specific records.

The latest recorded publication is [knowledge revision 12, verified on 2026-10-11](../history/enterprise-knowledge-revision12-publication.md). Earlier phase and release sections record progress at that time; their release IDs and blockers are historical. Remaining unchecked items describe planned work. Verify the live release before deployment.

Date: 2026-10-11  
Status: **Revision 12 engine and knowledge data are published and verified across grocery, electronics, jewelry and pharmacy.** Active release `eeeac359-a115-4df7-a9a7-e5ba310b8815`, runtime `1cccd00086e69da3f7f3071c436a785888381b2356651dd827f17abe161aa306`, fingerprint `79f0b56cba6e73824e4cbfb5bb184fac00a9d06ac25f6e2c946c0290d0248740`. Production relational data confirms **3,524 concepts, 5,628 forms and 94 governed rules**, with 1,273 recognition definitions unchanged. All four demos passed readiness/contracts and **12/12 live shopping checks**. Broader authoring, vocabulary and useful-scale milestones remain open; domain evidence remains disabled.

The independent tracing producer failed its latency gate and remains excluded; deployed gateway/rengine readers were preserved. Rollback baseline is release `489107a5-7555-4fc6-b623-549e4ad9ba64`; both database backups were fully restored on the same host and exact four-tenant promotion/rollback was rehearsed. See [publication and recovery details](../history/enterprise-knowledge-revision12-publication.md). Final evidence: `output/enterprise-knowledge-v12-production-20261011/`.

Reading this plan: the active work order below supersedes the earlier phase order. Dated implementation sections preserve historical results, including statements that a candidate was local or unpublished at that time. Unchecked release gates are a reusable checklist for each future release, not evidence that the current published release skipped its checks.

Historical release repair: the user authorized repair of the 2,253 archive failures, including justified benchmark corrections. Parser repairs and immutable knowledge revision 10 now pass all 136,368 corrected archived cases with the unchanged exact rubric. All-four-demo catalog checks and isolated promotion/rollback pass. An additional end-to-end check found Python demoting a mandatory typed exclusion into a preference. The two-file workflow fix now passes 54 adversarial tests, type checking on 255 modules, successor-image verification and repeated all-demo/HTTP checks. Final verification passed: 4,776 Python tests (one optional provider skip), 783 Node tests, all 136,368 archived cases, all-demo checks, image integrity and rollback evidence. The measured parser slowdown has been investigated and retained explicitly. See [the final repair report](../history/enterprise-knowledge-release-repair.md). Prior failed reports remain preserved. See [the release preparation report](../history/enterprise-knowledge-release-preparation.md) for the superseded candidate and the repair checklist below for current progress.

## Objective

Build a database-driven shopping knowledge system that understands varied human requests, combines reusable rules with verified product evidence, and supports millions of evaluated scenarios. Measure success through correct interpretation, grounded recommendations, useful clarification, and reliable operation—not database size or generated example counts.

Initial scope is English across electronics, grocery, jewelry, and pharmacy. Arabic is outside this phase. Begin domain-reasoning work with electronics, then extend the validated approach to the other demos.

Phase 0 baseline collection is complete. Its historical evidence is preserved; subsequent publication is recorded below.

## Existing foundation and constraints

- Extend the existing `knowledge`, `lexicon`, `semantic`, `entity`, and `intent` schemas instead of creating duplicate dictionaries.
- Preserve the shared `assistant` and `commerce_language` production databases and tenant isolation. Do not restore the retired per-demo AI databases.
- Keep Node responsible for language interpretation and Python responsible for validated shopping workflows and execution admission.
- Preserve immutable knowledge releases, artifact fingerprints, and runtime release checks.
- At implementation start, inventory the actual active database release, migrations, and compiled artifact. Current documentation already describes revision 5; the earlier revision-4 discussion is historical and must not be used as the new baseline without checking.
- The original 4,000-case live evaluation remains stopped. Preserve its original CSV and grades. Any new evaluation produces separately versioned results; new bulk live runs require explicit authorization.
- Local fixture success, language interpretation success, and live recommendation quality are different outcomes and must be reported separately.

Related documentation:

- [Language and capabilities](../language-and-capabilities.md)
- [Architecture](../architecture.md)
- [Database quality upgrade](../database-quality-upgrade.md)
- [Language release upgrade](../language-release-upgrade.md)
- [Shared database operations](../shared-database-operations.md)

## Knowledge architecture

| Layer | Contents | Example | Required boundary |
| --- | --- | --- | --- |
| Vocabulary | Concepts, synonyms, spelling variants, abbreviations, units | “editing videos” → `video_editing` | Similar words do not automatically have identical meanings |
| Language rules | Relationships, negation, comparison, quantities, budgets | “for my daughter” → recipient | Apply only when context and scope support the interpretation |
| Conversation rules | Corrections, references, rejections, changing constraints | “Something cheaper” preserves product and purpose | Resolve references from actual conversation state |
| Domain knowledge | Activities, capabilities, compatibility, conditional requirements | Editing requirements depend on software and workload | Every factual requirement needs a source and applicability conditions |
| Product evidence | Merchant specifications, manufacturer facts, verification dates | Actual RAM and supported software for one model | Facts remain scoped to the correct tenant, product, model, and version |
| Response policies | Recommend, clarify, disclose uncertainty, report no match | Ask for workload when suitability is unknown | Never turn missing evidence into a suitability claim |

Shared language knowledge is reusable across tenants. Merchant policies, product evidence, stock, and prices remain tenant-scoped. Prices and availability come from current commerce reads rather than static language packs.

## Current priority — Extend rules, vocabulary and database capabilities

Reprioritized by the user on 2026-10-10. Continue English coverage across electronics, grocery, jewelry and pharmacy. The next implementation work follows A–E below. Existing authoring, resumable import and immutable release capabilities are the starting point; inspect and extend them instead of rebuilding them.

### A. Inventory the published database and freeze expansion acceptance

- [x] Inventory the current tables, constraints, indexes, authoring commands, import checkpoints, compilation paths and explanation support. Map each proposed capability to an existing implementation or a verified gap; record concrete table names and migrations in the implementation report.
- [x] Separate shared language concepts/rules from tenant catalog names, model identifiers, attribute mappings and product facts. Record existing ownership and access boundaries before adding data.
- [x] Build a coverage matrix by demo and language family: known terms, unsupported meanings, ambiguous aliases, rule conflicts and observed failures. Use the four exact-name findings as initial regression seeds, then add new shopper wording independent of engine capabilities.
- [x] Freeze initial batch expectations and local baseline budgets: batch 2 freezes 40 cases before implementation; representative actual-vocabulary PostgreSQL lookups, repeated resumable imports, database/index sizes and prior compilation/parser measurements are recorded. Repeat acceptance freezing and measurement for each later batch.

Progress (2026-10-10): fresh production schema/size/index inventory and ownership/coverage mapping complete. Thirty acceptance cases and investigation thresholds are frozen; the batch-2 follow-up completes the representative local lookup/import baseline; production capacity and GB-scale qualification remain separate future gates. See [batch 1 implementation](../history/enterprise-knowledge-expansion-batch1.md).

Deliverable: database capability inventory, prioritized coverage gaps, source/license manifest, acceptance cases and measured baseline. Recheck current deployed identities before any later publication.

### B. Extend vocabulary and contextual rules together

| Coverage family | Vocabulary to add or refine | Rule/context behavior to validate |
| --- | --- | --- |
| Product identity | Categories, exact names, brand aliases, model numbers, versions and merchant variant labels | Preserve model and variant identity; distinguish literal product names from attribute requests |
| People and occasions | Individuals, recipient groups, relationships, audiences and occasions | Separate recipient, audience and intended use; preserve multiple recipients and clarify alternatives |
| Attributes and measurements | Colors, materials, dimensions, sizes, quantities, packaging, units and currencies | Scope values to supported fields; preserve exclusions, ranges and unit distinctions |
| Places and origin | Countries, regions, demonyms and origin wording | Distinguish origin, location and destination; geography alone does not establish delivery availability |
| Activities and devices | Workloads, hobbies, device families, connectors and compatibility language | Extract intended use and explicit compatibility requests without inventing suitability or compatibility facts |
| Composition and dialogue | Phrases using for/with/without/from/to/under/over, corrections, references and exclusions | Resolve meaning from context, preserve clause scope, retain unrelated constraints and ask focused questions when needed |

- [ ] Add sourced canonical concepts, synonyms, abbreviations, spelling variants and scoped aliases in reviewable batches. Track language, domain, provenance, license, ambiguity and lifecycle state for each entry where applicable.
- [ ] Extend declarative rule records with typed slots, applicable context, exclusions, precedence and conflict handling where inventory shows gaps. Every new family needs positive, negative, ambiguous and multi-turn examples.
- [ ] Address literal-name and model handling using tenant catalog bindings and contextual interpretation. Do not encode the four observed product names as global one-off exceptions or discard explicit shopper constraints merely to return a result.
- [ ] Validate first against Red Grapes, iPhone model specificity, Silver color/material ambiguity and the missed Estée Lauder item, then against unfamiliar sibling names and conflicting explicit attributes. Some fixes may require bounded parser/retrieval support as well as database records; measure each layer separately.
- [ ] Advance toward 10,000–25,000 useful concepts and 100,000–250,000 reviewed forms through successive releases. Report accepted, rejected, ambiguous and duplicate records separately; do not fill targets with redundant entries.

First local batch (2026-10-10): candidate revision 11 adds 16 work/study forms and three governed purpose markers, reaching 5,596 forms and 92 governed rules with 3,516 concepts unchanged. Language acceptance improves 3/22→22/22. Initial Python admission was 11/19; the follow-up repairs below reach 19/19 and validate the initial catalog-name cases. The exact 136,368-case replay also passes with zero failures. The initial diagnostic p95 rose 21.97%; the documented follow-up optimization resolves that regression on repeated paired measurements. This is an unpublished candidate; broad B milestones remain unchecked.

Deliverable per batch: versioned data and rule changes, provenance, coverage gains, counterexamples, conflict report and release-ready artifacts. A larger record count alone is not acceptance.

### C. Extend database authoring, import and retrieval capabilities

- [ ] Add only missing relational structures and constraints for concept/alias scope, rule dependencies, review decisions and tenant catalog bindings. Reuse existing schemas and immutable release storage; preserve runtime roles and tenant isolation.
- [ ] Extend existing authoring tools with validated search/filter, diff, edit, deprecate and replacement workflows where missing. Prevent published-row edits; author changes in drafts and require a new immutable release.
- [ ] Extend duplicate and conflict checks to alias collisions, incompatible meanings, overlapping rules, precedence cycles and unresolved references. Preserve legitimate ambiguity instead of forcing every spelling to one meaning.
- [ ] Build on the existing resumable importer: add missing job visibility, rejected-row reasons, retry controls, source-level reconciliation and audit history. Test interrupted uploads, duplicate batches, cancellation and concurrent operators without losing committed progress.
- [ ] Support reproducible incremental compilation and appropriately scoped knowledge loading as volume warrants it. Keep large source/evaluation collections outside request-time packs; preserve matching fingerprints across Node and Python.
- [ ] Benchmark representative lookup, import and compilation workloads; add indexes or partitioning only where measurements show a need. Do not simply remove the current 32 MiB runtime-pack bound to pursue GB-scale storage.
- [ ] Extend operator explanation queries to connect matched text spans with rule IDs, concept/alias IDs, selected scope, conflicts, release version and source/review provenance. Keep traces free of credentials and unrelated tenant data.

First operator increment (2026-10-10): implemented read-only paginated knowledge search, applicable-rule provenance, pack diffs and upload-job progress using existing tables. Type checking and 34 targeted tests pass; candidate import interruption/resume/finalization was rehearsed in a disposable database with unchanged active baseline. No new production schema or data was applied. Broader authoring/import capabilities remain open.

Deliverable: reviewed migrations for identified gaps, authoring/import commands and DBeaver queries, recovery tests, least-privilege checks, performance measurements and operator documentation. New tables and endpoints remain implementation decisions pending inventory.

### D. Validate and publish each bounded expansion

- [ ] Replay the 136,368-case regression gate and the historical English cases with original reports preserved; add the new reserved batch and report failures by demo and rule family.
- [ ] Test Node-to-Python meaning preservation and live-catalog answer quality separately, including product/model identity, budget, exclusion, ambiguity and no-match behavior. Do not treat a completed HTTP response as a correct answer.
- [ ] Verify migrations, interrupted imports, tenant isolation, compiled identities, promotion and rollback on the exact candidate. Investigate latency/memory regressions before rollout.
- [ ] Update this MD plan after each completed step with exact record counts, evidence paths, remaining gaps and whether the change is local, staged or published. Apply the existing release gates to every new release.

### E. Demonstrate useful scale, then resume the broader plan

- [ ] Measure data, indexes, retained releases and runtime memory separately after each expansion. Keep the first expansion pack's approximately 3.9 MB measurement as historical evidence; it is not the size of the whole current production database.
- [ ] Validate larger database-backed collections and selective loading with representative sourced data. Progress toward GB-scale persisted knowledge only when useful records and measured workloads justify it; keep runtime packs bounded.
- [ ] Revisit Phase 3 product attestations and activate domain evidence only after its evidence gates pass. Build Phase 4 million-scenario evaluation after independent labels and smaller evaluations are reliable. Pull Phase 5 database/performance work forward when needed by this expansion.

Next implementation milestone after batch 2: resolve the remaining Node budget-consistency gap and investigate import finalization, then extend reviewed vocabulary and concept/rule authoring plus import rejection/recovery tooling. A’s local baseline and the first bounded B+C increments are complete; broader B/C milestones stay open. Publish only after D passes. This reprioritization updates the plan; it does not itself change production data or activate domain evidence.

## Phase 0 — Establish the baseline

Deliverables:

- [x] Inventory current schema, active release, artifact fingerprint, vocabulary, and rules. Verified revision 5 and matching runtime identities across four demos; migration 027 is applied.
- [x] Identify database-managed behavior versus remaining code-owned language patterns. Ownership inventory records published rules, generated contracts, parser patterns, and execution boundaries.
- [x] Review the existing 4,000 cases offline, preserving original observations. Replayed 4,675 turns with a frozen engine and rubric; original CSV hash and grades remain unchanged.
- [x] Classify failures: interpretation, context, retrieval, missing catalog evidence, response quality, unsupported action, or evaluation error. All cases have provisional symptom classifications; unproven root causes, missing-evidence counts, and evaluation errors are explicitly left for adjudication.
- [x] Create a reviewed benchmark with owner approval and reserve a family-disjoint, unexecuted held-out set. On 2026-10-10 the user approved all suitable cases conditional on Codex checking realism and expected behavior. All 24 passed that review, with clarified expectations for three cases. This fulfills the review gate using the user's authorized method; independent human case-by-case adjudication is not claimed.
- [x] Measure current latency, memory, database size, and representative query plans. Local parser baseline, live memory snapshot, database sizes, and three read-only query plans are saved.

Progress recorded 2026-10-10: **Phase 0 complete under owner approval with delegated AI assessment**. Approved benchmark revision 2 contains 8 development cases and 16 reserved cases; all remain unexecuted. The original proposal is retained. The reserved set is separated by family within this benchmark and has no exact overlap with the original 10,000 prompts; independent authorship, semantic novelty, and passing engine answers are not certified. Historical cases remain exposed regression data.

Approval evidence, review notes, and sources: [approved benchmark review](../../platform/evidence/README.md#evidence-b84bd43678fcd273) (`output/enterprise-knowledge-phase0-20261010/benchmark-review.md`). Machine-readable approved expectations: [benchmark revision 2](../../platform/evidence/README.md#evidence-84287ae03b7dd212) (`output/enterprise-knowledge-phase0-20261010/benchmark-approved.json`). The user's instruction permits this delegated review; the original plan's independent human-adjudication standard must not be implied by the completion label.

Results and reproduction: [Phase 0 baseline report](../history/enterprise-knowledge-phase0.md). Current minimum-language baseline: 1,277/4,000 complete conversations and 1,440/4,675 turns pass. These are separate from historical live-response grades and do not establish current recommendation quality.

Acceptance: a reproducible baseline report links every score to its cases, rubric, engine release, and catalog snapshot. No claim that all historical failures are language-rule defects.

## Phase 1 — Govern and validate database-authored rules

Implementation checklist (revision 6; completed 2026-10-10):

- [x] Inspect existing knowledge tables, immutable packs, draft/evaluation/promotion workflow, and code-owned patterns. Extend this workflow; retain the Phase 0 baseline and reserved benchmark.
- [x] Add bounded rule governance records: provenance, applicability, runtime requirements, review state, examples, and counterexamples, tied to immutable pack/release content. Migration `028_rule_governance.sql` adds budget templates, review records, reference checks, immutable triggers, and an operator reporting view.
- [x] Validate references, complexity, duplicate/overlapping rules, examples, review state, and version changes before publication. Draft rules remain testable; publication requires content-bound review. Review provenance distinguishes AI-assisted review from human review.
- [x] Move inline budget/limit phrasing into database-authored templates, preserving numeric parsing and safety boundaries in code; expose rule/span evidence through `govern-knowledge.ts explain` without changing the public action contract.
- [x] Verify unit/contract tests and disposable-database import, immutability, promotion, and rollback behavior. Final full suite: **688 passed, zero failures or skips**. Focused governance suite: 9 passed; disposable PostgreSQL release/import suite: 20 passed. Both application and database activation gates reject draft rules.
- [x] Replay the exposed 4,000-case regression set, compare performance with the frozen baseline, and document results and rollout commands. **Zero regressed checks and zero changed entity rows**; coverage remains 1,277/4,000 conversations and 1,440/4,675 turns. p95 latency +0.10%, peak harness RSS +1.44%. The 16 reserved benchmark cases remain unexecuted.

Implementation is local. Candidate preparation and validation do not mean the changes are deployed or the historical failures are solved.

Candidate revision 6 has 68 governed rules, 30 inline-budget templates, 69 positive matching examples, and 140 counterexamples. Two previously unreachable prefix-modifier rules are omitted because all their targets require explicit context. One overlapping question pair (price/material) declares the existing reject-on-disagreement behavior. These are matching fixtures with AI-assisted review, not independent human labels or verified shopping answers.

Local database migrations and inactive staging are complete. Active revision 5 remains unchanged; production has not been updated. The exact archived-corpus release gate and the 15 Phase 0 order-route flags must still be addressed before production promotion. See [Phase 1 implementation, DBeaver queries, evidence and rollout instructions](../history/enterprise-knowledge-phase1.md).

Extend existing rule storage where suitable. Introduce new tables only after the schema inventory establishes a genuine gap. Proposed logical records include rule applicability, examples, counterexamples, provenance, and review decisions; final table names are implementation decisions.

Each rule must declare:

- Stable identifier, version, language, and domain.
- Pattern, typed slots, applicable context, exclusions, and scope.
- Output meaning, precedence, and conflict handling.
- Positive examples and counterexamples.
- Source, author, reviewer, status, and change reason.
- Runtime compatibility requirements and release membership.

Use a constrained declarative format. Do not store arbitrary executable code. Bound pattern complexity and execution cost. Detect duplicate rules, invalid references, ambiguous precedence, and conflicting outputs before publication.

Move suitable remaining patterns from code into validated records incrementally. Recheck the current implementation before choosing which patterns remain to migrate. Keep the executor, numeric parsing primitives, contract validation, and safety boundaries in code.

Example proposed rule:

```text
Pattern: [my|our] [budget|limit] [is|of] MONEY
Output: maximum_price = MONEY
Counterexample: “That is not my budget.”
Scope: the relevant product request only
```

Acceptance: migrated behavior preserves existing contract outputs; negative and ambiguous cases are tested; every interpretation can report the source rule and matched span.

## Phase 2 — Expand English vocabulary and composition

Implementation checklist (started 2026-10-10):

- [x] Inspect revision 6, existing composition/quantity/price support, and Node-to-Python admission. Preserve frozen baselines and the 16 reserved Phase 0 cases.
- [x] Lock Phase 2 validation expectations before implementation; separate authoring examples from final validation. 28 English conversations are hash-locked in `output/enterprise-knowledge-phase2-20261010/validation-reserved.json`; expectations are AI-authored before implementation, not independent human labels. They were evaluated after the candidate was frozen; the original report is preserved.
- [x] Add reviewed, scoped English concepts and aliases across the four demo domains: revision 7 contains 856 concepts and 1,784 canonical/alias forms. All 311 added or amended concepts carry hash-bound AI review provenance and explicit scope; catalog facts remain separate.
- [x] Extend preposition/negation composition, multiple recipients/uses, and ambiguous-input handling: 17 relationship rules plus 2 budget rules bring the governed total to 87. Authoring tests cover positive matches, exclusions, contradictions, unknown suffixes and mixed requests.
- [x] Verify budget ranges, quantity/unit wording, and follow-up constraint preservation: Node authoring checks and real Node-to-Python admission tests pass; range updates retain minimum/currency/recipient, and material updates retain exclusions. Packaging/dimension annotations remain descriptive and do not certify merchant units or measurements.
- [x] Run Node/Python and disposable-database tests, historical regression, final validation and performance comparison: 696 Node and 183 Python tests pass; the original 4,000 conversations have zero regressions and zero gains. Reserved Phase 2 validation improves from 6/28 to 25/28 with zero regressions. The three remaining mismatches are retained, not relabeled. Parser p95 is +4.21% and peak RSS +1.36% against Phase 1.
- [x] Stage an inactive local revision and verify its records: revision 7, release `74071845-b9a6-491a-88bc-f9ee4fc73ef2`, migration `029_english_composition.sql`. The active local release remains revision 5. Publish the evidence and remaining limits in [the Phase 2 report](../history/enterprise-knowledge-phase2.md); production was not contacted or changed.

Validation repairs and remaining gates:

Repair run (completed 2026-10-10): inactive revision 8 fixes all three findings. Revision 7 and its 25/28 report are preserved; the original 28 cases are now regression cases. A fresh set of 24 English conversations was hash-locked before implementation in `output/enterprise-knowledge-phase2-fixes-20261010/validation-reserved.json`. It is AI-authored and shares grammar families, not independent human validation. See [the repair report](../history/enterprise-knowledge-phase2-repairs.md).

- [x] Freeze fresh expectations and review the three failure contracts before editing code.
- [x] Implement and verify each repair across Node and Python: 7 Node repair tests and 5 Python integration tests pass, including all original 28 expectations. Python rejects forged ownership and makes zero catalog/model calls for the new clarification outcomes.
- [x] Run full checks against frozen revision 8: 703 Node tests and 205 Python tests pass; original-case regression is 28/28, fresh reserved validation is 24/24. The 4,000-conversation replay has zero regressions and zero gains. Local parser p95 is −4.71% and peak RSS +0.05% relative to revision 7, within the investigation limits.
- [x] Store and verify inactive local candidate `23da8cc6-a272-405c-bc5d-40ec02a24600`, revision 8, with migration `030_person_composition_policy.sql`. Exact rule policies and concept metadata match the frozen candidate. The active local release remains revision 5; production was not contacted or changed.

- [x] Fix collective recipient/audience meaning (P2-VAL-008): explicit possessives make family/household/team recipient groups; unowned groups retain their audience role. A reviewed DB rule and matching Python source check enforce the distinction.
- [x] Clarify recipient alternatives (P2-VAL-020): `or` between recipients produces a focused recipient question, preserving the product, budget and source phrase without choosing a person.
- [x] Align explicit compatibility with the locked expectation (P2-VAL-024): `compatible with`, `that works with` and `to use with` now require clarification while retaining device evidence. General `for <device>` searches retain their existing downstream evidence checks. No compatibility fact is invented.
- [ ] Grow independently reviewed coverage toward the vocabulary/scenario milestones below and perform the catalog/answer-quality promotion checks. Use a new revision and fresh reserved set for subsequent fixes; preserve this frozen report.

The three validation findings are closed locally, with original labels preserved and fresh wording tested. This does not make all Phase 2 coverage targets or production acceptance complete. Current evidence and reproducible verification: `output/enterprise-knowledge-phase2-fixes-20261010/verification.json` and `scripts/knowledge-baseline/verify-phase2-repairs.mjs`. The initial revision-7 evidence remains in `output/enterprise-knowledge-phase2-20261010/`.

The numerical vocabulary/scenario targets below are capacity milestones. This implementation will report useful reviewed coverage separately from bulk counts and will not pad the dictionary to meet a size target.

Add useful vocabulary from reviewed sources and observed gaps, including product categories, activities, people and recipients, occasions, colors, materials, dimensions, units, places, device names, and compatibility terminology.

Keep distinct concepts separate: a country name is not automatically shipping availability; a device name is not its connector specification; a recipient term does not imply preferences.

Expand composable rules for:

- Prepositions with multiple meanings: for, with, without, from, to, under, over.
- Negation and exclusions: “not for gaming,” “anything except red.”
- Multiple intended uses and recipients.
- Budget ranges, currency, quantity, and unit expressions.
- Multi-turn corrections, rejected results, and retained constraints.
- Ambiguity that requires a focused clarification.

Initial planning target: 10,000–25,000 concepts and 100,000–250,000 vocabulary forms, with 100,000 evaluation scenarios. These are capacity and coverage milestones, not quotas to fill with redundant data.

### Vocabulary expansion and resumable imports — started 2026-10-10

The earlier Phase 2 implementation completed rule support and validation repairs, **not the vocabulary scale milestone**. Starting inventory: 856 concepts and 1,784 canonical/alternate forms in inactive revision 8. This work continues Phase 2; Phase 4's large evaluation dataset remains separate.

- [x] Inspect the current importer and identify the missing restart checkpoint: the existing whole-pack transaction is atomic but cannot resume an interrupted upload.
- [x] Capture a licensed English source, source hashes, extraction policy and explicit exclusions; keep ambiguous meanings and product evidence separate. Princeton WordNet 3.1 archive and noun-file hashes are locked; its license accompanies the derived pack, including the database/bundle source field. Only selected shopping noun branches are admitted; ambiguous noun spellings, existing surfaces and out-of-scope branches are excluded.
- [x] Add bounded, checksum-verified database batch staging with durable checkpoints, duplicate/conflict checks, resume, inspection and cancellation. Migration `031_knowledge_bulk_imports.sql` and `bulk-language-knowledge.ts` reuse inactive release finalization. Ten PostgreSQL/transport checks pass, including recovery after candidate commit and runtime-role exclusion. Current limits are 500 records/1 MiB per chunk and 32 MiB/100,000 concepts per runtime pack; this is not yet a GB-scale runtime pack implementation.
- [x] Expand useful vocabulary from the source and reviewed shopper wording, preserving the existing concepts/rules and recording provenance and actual counts. Candidate revision 9 contains 3,516 concepts and 5,580 forms; 88 governed rules are unchanged. Review is AI-assisted policy/sample review for imported nouns and first-party wording review, not independent per-entry human adjudication. Full Phase 2 coverage targets remain open.
- [x] Verify interrupted/repeated imports, corruption handling, unchanged activation, language regressions and measured resource use; stage the candidate locally. Full Node suite: 750 passed, zero skips; final targeted suite: 47 passed; real Node/Python boundary: 13 passed. The local upload paused after 500 concepts and resumed all 15 chunks, with exact stored counts/hashes and idempotent finalization. Existing revision 5 stayed active. Frozen 4,000-case replay: zero regressions and zero gains; original live grades remain unchanged. Sequential local p95 increased 2.70%, with peak RSS increased 0.42% against a fresh revision-8 comparison.
- [x] Publish the reproduction commands, database tables, measured storage and remaining coverage gaps in [the first expansion report](../enterprise-knowledge-vocabulary-expansion.md). The pack is 3,890,219 bytes, not GB scale. Typed relation extraction in 22 AI-authored development examples improved from 3 to 20 passes; two legacy `catalogPurpose` paths remain visible. This is not an independent quality benchmark or a claim of completing the full Phase 2 scale milestone.

Acceptance: gains on held-out scenarios without regressions in existing covered behavior; all new aliases are scoped and traceable; every rule family has counterexamples.

## Release preparation — vocabulary revision 9 (2026-10-10)

Scope: prepare the English vocabulary release across electronics, grocery, jewelry and pharmacy. Production activation is a separate publication step. Prior frozen reports and original CSV grades remain unchanged.

- [x] Fix the architecture boundary without weakening its checker: deterministic routing stays pure and application entry points preserve opt-in diagnostics. Targeted suite: 118 Python tests pass.
- [x] Reconcile the public contract guard with the already generated tracking contract: preserve the v1 snapshot, allow only explicit reviewed additions and the operator-report event bound 32→96, and reject unrelated changes. Enterprise/tracking suite: 45 tests pass. Updated frontend/Python validators already agree; strict older report clients need the updated client.
- [x] Fix the two typed-context gaps using database concept scope (`explicit_relationship_only`), preserving legacy merchant purposes and gifts. Macro photography and hand sewing now emit typed intended use. Targeted validation: 76 Node tests and 15 Python boundary tests pass.
- [x] Freeze the candidate language runtime and run the complete archived-corpus evaluation. Runtime `91d58fcd…` is stable; all 136,368 cases were checked. The exact gate **fails on 2,253 expectations**, with zero wire failures. The unchanged original corpus and failed report are preserved; promotion remains blocked. Full Node suite: 754 passed, zero failures/skips. Both publishable images build successfully.
- [x] Validate bounded shopping answers using real catalog data from every demo: 16/16 cases pass against 15 read-only live catalog responses, including strict budgets, exact prices, recipients, follow-ups and compatibility uncertainty. This found and fixed unrelated lexical fallback products (bread for sewing supplies). Model calls and production mutations: zero. Historical replay: 4,000 conversations, zero regressions/gains; all 22 vocabulary examples pass.
- [x] Stage production-based candidate `c4eba5dd-f7bc-407c-90d8-956280fe20d6` in a disposable database, preserving the production base and exact archive. Migration, all four tenant identities, RLS, restricted-table access and rejection of inactive-candidate startup pass. Preserve private production database dumps, exact images and configuration in `/var/backups/rocento/enterprise-knowledge-prepublish-20261010.Y4C2AzBz` with checksums. Main local and production active releases remain unchanged.
- [x] Obtain a passing exact archived-corpus evaluation before rehearsing candidate promotion and rollback. Completed for the revision-10 successor below; the failed revision-9 candidate remains ineligible and its reports are preserved.
- [x] Save the frozen build inputs, identity-checked candidate/rollback bundles, complete failure diagnostics, all-demo answer evidence, measured limits and publication/rollback sequence in [the release preparation report](../history/enterprise-knowledge-release-preparation.md). Final Python suite: 4,722 passed with real PostgreSQL/HTTP fixtures; one optional paid-provider test is unconfigured. Both production-version images build and pass non-root/read-only checks.
- [x] Independently compare every archived-corpus failure with the exact captured production runtime: all 2,253 have identical recorded behavior; no new archived-expectation regression was found. The diagnostic keeps questionable fixtures separate from real parser defects, with 1,419 cases still requiring semantic adjudication. Failed-evaluation promotion was proven rejected in a disposable database.
- [x] Resolve the pre-existing archive failures with reviewed runtime fixes and explicitly versioned, justified fixture corrections; rerun the exact gate without weakening it. Completed for the revision-10 successor below, including semantic delivery clarification for all 15 replacement-arrival questions.

New evidence: `output/enterprise-knowledge-release-prep-20261010/`. Revision-9 expansion evidence remains a historical record; a new runtime requires new evaluation. **Do not publish this candidate yet:** the named checks and vocabulary gaps are fixed, but the exact archive gate fails. All four production demos were checked again and remain healthy on unchanged revision 5. Rollback assets are prepared; successful candidate promotion/rollback remains pending a passing gate.

### Exact release repair — completed for the frozen candidate 2026-10-10

- [x] Classify the 2,253 failures and retain every original case and historical report. Benchmark revision 4 preserves all 136,368 original cases in order, with per-case patches and semantic rationales. It corrects missing authoring-domain context, incomplete-action expectations, nonliteral requests, literal product casing and documented read-route contracts. Every original entity assertion is retained except two explicitly justified literal-case corrections; discount discovery gains an explicit ranking assertion. Review is AI-assisted, not independent human labeling.
- [x] Repair courtesy/negation, bounded request wrappers, dictionary-owned action/object reads, collection selection and context references. New regression tests cover ambiguous and negative siblings as well as the previously failed wording. Final frozen-runtime Node suite: 783 passed, zero failures or skips; the exact corpus gate also passes.
- [x] Repair the 15 historical replacement-arrival questions. Immutable pack revision 10 adds one governed delivery-question rule (89 governed rules total), migration 032 and bounded date/purpose slots. All 15 now clarify delivery/availability with zero model or commerce calls in actual local HTTP admission. Four focused tests verify extra-clause rejection, source spans, context retention and runtime governance. All 3,516 concepts and licensed vocabulary provenance are preserved.
- [x] Freeze final runtime `9f58fcc4…` and benchmark revision 4: all 136,368 cases pass with zero wire failures under the unchanged exact release rubric. Original 4,000-conversation replay: 43 improved turns, zero regressed turns/checks; 1,309 complete conversations and 1,483/4,675 turns pass the minimum-language rubric. Original CSV and grades are unchanged.
- [x] Preserve verified typed requirements through Python meaning extraction and alternatives, fixing the discovered material-exclusion demotion. Both exclusions now reject excluded, unknown and inferred-only products; missing/ambiguous fields clarify. All 54 schema/evidence/workflow checks, 255-module type checking, the corrected image, 16 fresh all-demo checks and 15 delivery HTTP checks pass. Original development fixtures remain intact with two separately versioned expectations.
- [x] Complete validation: 783 Node tests; 4,776 Python tests with real PostgreSQL/HTTP fixtures and one optional unconfigured provider skip; 163 deployment tests plus 777 subtests; 9 shared-DB checks plus 4 subtests; 16 fresh all-demo cases and 15 delivery HTTP checks. Both exact images pass non-root/read-only checks, including all Python runtime source hashes. Paired parser p95 8.806→10.577 ms (+20.11%); profiling identifies repeated frame scans/normalization, fulfilling the investigation requirement while retaining the slowdown as an explicit tradeoff.
- [x] Rehearse candidate `694122fc-b5dc-4cf0-b2c6-b5fecd7b75f9` promotion, all four tenant startups, old-runtime rollback, stale-candidate rejection and tenant isolation in a disposable database. Restore both saved production database dumps in a separate container on the production host: 67 tables and 304 constraints verified, isolated resources removed. Production data and active release were unchanged; no dump payload was exported.
- [x] Publish the [final repair evidence](../history/enterprise-knowledge-release-repair.md) and [publication/rollback runbook](../history/enterprise-knowledge-release-publication.md). The final verifier passes, binding 35 evidence files and 80 preserved historical files. This preparation did not activate a release. The separately authorized activation in the other chat must use matching combined images/data and recheck the active baseline; this frozen report does not certify its present production state.

Coordination: the separate database-recognition migration has passed 790 tests and all 136,368 reviewed archive cases; see [its guide](../database-recognition-rules.md). The user subsequently requested activation in that chat. Its runtime/artifact identities differ from this frozen repair, so publication must coordinate matching Node/Python/data and recheck the current active release.

Coordination schema check (2026-10-10, 17:42 UTC): production already satisfies the reviewed Python overlay’s assistant schema requirements. No new `assistant` migrations are needed with `domain_evidence` disabled on all four demos; preserve flags and policies, and skip the setup helper that would apply unused migration 011. The [recorded decision](../../platform/evidence/README.md#evidence-231c55d4753a7f08) (`output/enterprise-knowledge-release-repair-20261010/final/assistant-migration-decision.json`) was shared with the activation chat. Language migrations and candidate evaluation remain separate requirements.

Evidence directory: `output/enterprise-knowledge-release-repair-20261010/`. The benchmark is synthetic regression evidence; its passing result does not imply that every possible shopper request or missing catalog fact is solved.

### Coordinated production publication — 2026-10-10

- [x] Fix the promotion/bootstrap recognition-context bug and verify cold-process publication and rollback; 792 Node tests and all 136,368 exact archived cases pass.
- [x] Publish combined release `0cd45170-7a58-423c-8109-03b677edffec`, runtime `6b29b7cc…`, matching Node/Python dictionary `1db6ecd8…`, knowledge revision 10 and 1,273 database recognition definitions across all four demos. Preserve assistant schema and flags; retain rollback assets.
- [x] Independently verify all eight healthy containers, 254 Python source hashes per store, matching images, all four public storefronts/catalogs, eight completed shopper streams, and 15 products against fresh catalog reads.
- [ ] Resolve the separately observed exact-product-name quality limitations: Red Grapes clarification, iPhone model overmatching, Silver ambiguity and the missed Estée Lauder catalog item. Eight public answers were rated four good, one partial and three bad; all four limitations reproduce on the retained baseline in paired Node and Python comparisons, with no observed regression. Track implementation under current priority B; this historical checklist references the same work, not a separate batch.

See the [production verification report](../history/enterprise-knowledge-production-verification.md). Publication is complete; this does not mark every historical shopper case or every answer-quality issue solved.

## Phase 3 — Connect intended use to verified evidence

Implementation checklist (started 2026-10-10):

- [x] Inspect language releases, shopping admission, catalog facts and existing knowledge storage. Existing `assistant.knowledge_sources` / `knowledge_chunks` contain tenant RAG documents and embeddings; they do not model conditional requirements, immutable profile releases or exact-model product attestations. Keep these responsibilities separate and use the existing `assistant` database.
- [x] Freeze electronics validation expectations and capture primary-source review notes outside the runtime artifact. 26 scenarios were hash-locked before implementation. Four initial profiles cover Shotcut SD/HD/4K on Windows 11 with CPU processing, and Zoom basic video classes on Windows 11 with included audio/camera. These are AI-reviewed primary-source profiles and synthetic validation facts, not independent human or live-catalog validation.
- [x] Add bounded, source-linked domain profiles and tenant-scoped product evidence with review/expiry/conflict handling. Migration `011_domain_evidence.sql` supports immutable releases, exact-product attestations, revocations and tenant bindings. A disposable PostgreSQL test verifies import, isolation, activation/rollback and revocation. Inactive local staging uses a dedicated assistant database; no product facts are invented or imported from fixtures.
- [x] Integrate focused profile clarification and deterministic verified/unmet/unknown assessments with current catalog reads, preserving tenant, product, currency and budget constraints. The `domain_evidence` feature flag injects the DB reader into both initial requests and server-owned continuations. A real HTTP/SSE round trip verifies profile issuance, browser-choice tampering rejection, budget preservation, evidence citations and stale-choice rejection with zero model calls.
- [x] Verify source integrity, database isolation/immutability, real shopping-flow integration, regressions and failure behavior. Final targeted suite: 335 passed; real PostgreSQL integration: 1 passed; deployment checks: 43 passed; mypy: 255 modules passed. Publish evidence and limits in [the Phase 3 implementation report](../history/enterprise-knowledge-phase3.md). The tracking-contract snapshot and routing diagnostics checks were subsequently fixed during release preparation; the exact archived-corpus gate subsequently passed for the frozen revision-10 repair; independent product attestations and domain activation remain open.
- [ ] Independently review the profiles and add current, exact-model product attestations and reviewed tenant field mappings. The sampled local demo laptops lack the needed evidence; no fixture facts were staged. Verify real catalog answers before production promotion, then expand beyond the first four software/workload profiles.

Introduce domain profiles that connect activities to conditional product requirements. Store their sources, applicability conditions, review dates, conflicts, and expiry or recheck policies. Keep source documents outside the runtime pack and reference them by stable identifiers.

For “laptop for video editing under $75,” the intended flow is:

1. Extract laptop, video editing, and maximum price.
2. Determine whether software, workload, or other clarification is necessary.
3. Retrieve an applicable, sourced requirement profile.
4. Search the tenant's current catalog within explicit customer constraints.
5. Compare required evidence with actual product facts.
6. Classify suitability as verified, unmet, or unknown.
7. Explain the outcome and ask a useful question when needed.

Do not invent a universal video-editing specification. Do not silently relax the budget. Do not describe a product as unsuitable merely because its specifications are missing.

For grocery and pharmacy, do not infer allergen safety, medical suitability, or compatibility from broad category names. Define domain-specific evidence and escalation boundaries before adding those recommendations.

Acceptance: product recommendations cite internal evidence identifiers; missing and conflicting facts produce explicit unknown states; budget and tenant constraints remain enforced.

## Phase 4 — Build million-scenario evaluation

Grow from 100,000 to 1 million, then 5–10 million scenarios only after the preceding stage is useful and reproducible.

Sources:

- Human-authored shopper situations, independent of current engine capabilities.
- Anonymized real failure patterns with appropriate retention and access controls.
- Reviewed paraphrases, spelling variation, and incomplete requests.
- Combinations of product, purpose, budget, recipient, exclusions, and context.
- Multi-turn corrections and explicit rejection of prior results.
- Missing facts, unavailable products, contradictory evidence, and impossible constraints.
- Tenant isolation, stale releases, and unavailable dependencies.

Evaluation rules:

- Split by scenario family and conversation, not random near-duplicate sentences.
- Keep rule-authoring examples separate from held-out evaluation.
- Obtain expected results independently; never use the engine's own output as the correctness oracle.
- Use deterministic assertions for budgets, identities, evidence, and state changes.
- Use a documented human-reviewed rubric for response usefulness. Any automated judge is supplementary and must be calibrated against human judgments.
- Track product interpretation, context preservation, retrieval, evidence grounding, and final response quality separately.
- Include metamorphic checks: lowering a budget cannot admit a more expensive product; negation cannot create a positive requirement; rejection must not remove an unrelated product.
- Keep bulk synthetic execution offline against controlled fixtures or catalog snapshots. Use a separately authorized, bounded live sample to validate real integrations.

Acceptance: each run records dataset version, release fingerprint, catalog snapshot, rubric, per-domain results, failure reasons, and uncertainty where sampling is used. Millions of generated tests are not a claim of millions of verified real-world situations.

## Phase 5 — Runtime scale and production operation

- Compile approved rules into immutable, versioned packs selected by language and domain.
- Keep large evidence collections and evaluation traces outside request-time memory.
- Retrieve only relevant knowledge; use bounded caches keyed by release and tenant where applicable.
- Benchmark before introducing partitioning or additional search infrastructure.
- Use appropriate PostgreSQL indexes for exact lookup, text retrieval, and candidate similarity. Similarity retrieval does not establish semantic equivalence.
- Publish atomically; verify fingerprints and runtime compatibility on every demo.
- Preserve the all-store deployment requirement for shared language releases.
- Stage and canary changes before broad publication; retain tested rollback artifacts and database recovery procedures.
- Monitor unsupported requests, clarification frequency, incorrect matches, latency, memory, evidence age, and tenant isolation.
- Route newly observed failures into review. Do not automatically activate rules derived from customer messages.

Acceptance: agreed load and latency objectives pass on representative hardware; bounded resource use and recovery are demonstrated; every answer has an explainable rule/evidence trace.

PostgreSQL references: [GIN indexes](https://www.postgresql.org/docs/current/gin.html), [trigram similarity](https://www.postgresql.org/docs/current/pgtrgm.html), and [partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html). These are implementation options, not substitutes for workload measurements.

## Storage and capacity assumptions

The following are illustrative raw-data estimates, not measured requirements or accuracy targets. Validate them by importing a representative sample and measuring data, indexes, and runtime memory separately.

| Collection | Illustrative volume | Average record size | Approximate raw size |
| --- | --- | --- | --- |
| Vocabulary and concepts | 1 million records | 0.5–2 KB | 0.5–2 GB |
| Rules, relationships, requirements, provenance | 500,000 records | 1–4 KB | 0.5–2 GB |
| Product facts and evidence | 5 million records | 0.5–2 KB | 2.5–10 GB |
| Evaluation inputs and expected outcomes | 10 million cases | 2–5 KB | 20–50 GB |

Initial planning envelope: **10–50 GB for the indexed knowledge database** and **50–200 GB for evaluation artifacts**, subject to measured record sizes and retention. The relationship/requirement record count does not mean 500,000 independently authored language rules.

Detailed response traces may exceed these estimates. Source documents, media, retained releases, write-ahead logs, maintenance headroom, replicas, and backups need separate budgets. Store large evaluation artifacts in object storage; retain searchable metadata and summaries in PostgreSQL.

Later vocabulary planning target: 50,000–100,000 concepts and 500,000–1 million forms, only where evidence shows useful coverage. Do not add duplicate or weakly sourced knowledge to reach a size target.

## Release gates

Before any knowledge release:

- [ ] Schema, references, patterns, and artifact contracts validate.
- [ ] New rule families have positive, negative, ambiguous, and contextual tests.
- [ ] All mandatory regression tests pass; any behavioral change is explicitly reviewed.
- [ ] Held-out results are reported by domain and failure category.
- [ ] Budget, identity, evidence, and tenant-isolation checks have no failures in the release suite.
- [ ] Runtime latency and memory meet the objectives established from the baseline.
- [ ] Domain sources and evidence freshness meet the applicable policy.
- [ ] Rollback and release compatibility are verified.
- [ ] Staging and the authorized live verification sample pass.
- [ ] Release manifest records changes, provenance, limitations, and evaluation evidence.

Zero failures in a finite release suite do not guarantee zero production failures. Set numerical quality and performance thresholds during Phase 0, before evaluating candidates; do not adjust them afterward to make a release pass.

## Historical first implementation milestone

The original starting sequence is retained for context. The current next milestone is defined in priorities A–D above. Original sequence:

1. Confirm the latest code, database release, and ongoing work in the shared project.
2. Produce the schema and code-pattern inventory.
3. Review and classify the existing 4,000 cases offline.
4. Define the independent benchmark, quality rubric, and performance baseline.
5. Implement one vertical slice: laptop intended use, budget interpretation, sourced suitability conditions, missing-evidence clarification, and rule traces.
6. Validate the slice locally with positive and counterexample cases.
7. Expand vocabulary and domain coverage only after the slice meets its gates.

Deliverables for this milestone: baseline report, reviewed schema proposal, rule format specification, source manifest, benchmark manifest, one working vertical slice, and a verification report. No production deployment or new bulk live evaluation is implied by completion of this planning document.

## Expansion repair follow-up — 2026-10-10 (local repairs verified)

- [x] Repair the eight Python admission failures: contiguous request envelopes now carry typed relationship spans in original customer-message coordinates. The unchanged revision-11 admission checks pass **19/19**, including all eight courteous requests; budgets and unverified suitability safeguards remain enforced. Evidence: `output/enterprise-knowledge-expansion-fixes-20261010/python-admission.log`. See [repair results](../history/enterprise-knowledge-expansion-fixes.md).
- [x] Finish latency investigation: six alternating fresh-process runs per variant show median p95 17.31→13.68 ms (−20.97% versus the unfixed candidate, −2.66% versus published baseline). Compilation +3.43% and RSS +1.32% versus baseline remain below investigation thresholds. Action phrases are normalized once per parse and sorted once per frame. All 136,368 archived cases pass with zero wire failures. Original batch-1 measurements remain preserved; these are local measurements, not a production SLA.
- [x] Implement and validate the initial catalog-name improvements: local Node/Python against bounded real catalog reads returns the requested item across all four demos. Twenty-seven adversarial fixture checks pass, covering sibling names, duplicate names, model suffixes, verified numeric-unit suffixes, budgets, exclusions and both meaning modes. Red Grapes is actually named **Red Grapes 500g** in production; its suffix is accepted only with matching merchant weight/unit evidence. No product names or unit vocabulary were added as global exceptions. Broader catalog binding authoring remains open.
- [x] Complete scoped regression/type checks: Node 750 passed (12 skipped), 136,368 archive cases passed, Python 257 modules type-check, and the five broad-suite findings are reconciled by 77 passing affected-suite checks (216 combined admission/catalog/shopping checks also pass). Evidence is for the isolated candidate snapshot; concurrent fruit-search and tracing edits require a new combined release freeze before publication. Production release and vocabulary remain unchanged.


## Expansion batch 2 — 2026-10-10 (local implementation and measurements complete)

- [x] Complete local database baseline: 12,000 lookups at concurrency 1/8, three interrupted/resumed 3,516-concept imports using all 136,368 archived cases, query plans and data/index/retained-release sizes. Lookup p95 is 0.39–0.65 ms; chunk upload is 32,540–36,381 concepts/s, with finalization separately measured at 3.62–3.76 seconds. The isolated active release stayed unchanged. These are local measurements, not production capacity guarantees. Evidence: `output/enterprise-knowledge-expansion-batch2-20261010/baseline-results.json`.
- [x] Freeze 40 English acceptance cases and budgets before implementation, including reserved wording, ambiguity, write boundaries and conflicting budgets. These are AI-authored checks, not independent human labels.
- [x] Implement the bounded revision-12 recipient/occasion batch: 3,524 concepts, 5,628 forms and 94 governed rules (+8 concepts, +32 forms, +2 rules). Language acceptance improves 7/40→39/40; all 32 positive Python admission checks pass. The remaining contradictory-budget expectation fails on the Node baseline too, but the full Python check correctly clarifies with no product search. This gap remains explicit.
- [x] Implement draft-only alias add/retire/replace tooling, stale-hash/revision guards and audit provenance on existing release tables. Real database tests pass: preview writes nothing, concurrent writers produce one winner, old revisions remain immutable, candidate imports do not activate. See [operator instructions](../knowledge-authoring.md). Other concept/rule editing tools remain open.
- [x] Complete regression and candidate performance checks: all 136,368 archived cases pass with zero wire failures; TypeScript and targeted authoring/governance checks pass. Parser p95 is 13.11→13.15 ms (+0.26%); compilation −0.65%, RSS −0.95%, within thresholds. Paired database lookup p95 rises 5.31%, also within threshold. Language acceptance remains explicitly 39/40; total import throughput remains below the provisional end-to-end target. All changes remain local.

Follow-up limits: total import throughput including finalization is 911–945 concepts/s, below a 1,000 concepts/s end-to-end interpretation of the provisional target. The faster chunk-upload rate excludes finalization. Optimize/qualify this path before claiming the target; do not treat local load measurements as production capacity. See [batch 2 report](../history/enterprise-knowledge-expansion-batch2.md).

## Revision-12 publication — 2026-10-11 (complete)

The user authorized blocker repairs, validation, rollback rehearsal and production publication. Coordination with “Improve rengine tracing” was explicitly authorized and completed.

- [x] Fix contradictory adjacent price bounds, preserving quoted product titles and asking for clarification before search. Forward currency and exclusive price bounds during product-name identity probes.
- [x] Optimize question-rule overlap analysis and release hash reuse without weakening validation. The measured importer passes the 1,000 concepts/s end-to-end floor; unchanged importer-path hashes are recorded for the final successor.
- [x] Isolate the knowledge release from the tracing producer that failed latency. Preserve the deployed readers and all four newer production corpus cases. The shared checkout still contains unpublished tracing work; future deployment must use a new validated freeze rather than blindly deploying that checkout.
- [x] Validate the exact production-based runtime: **136,372 archive cases**, **758 Node tests** (12 skipped), **40 vocabulary cases**, **33 Python admission cases**, TypeScript and **256 Python modules**. Python broad run: 4,780 passed, 31 skipped, 17 missing-fixture setup errors; restored fixtures and **39/39 affected-suite checks** reconcile every error. Original logs remain preserved.
- [x] Validate all demos with **20/20 captured real-catalog replays** and four exact-name checks. Final paired parser p95 **15.46→12.11 ms (−21.64%)**; compilation −12.79%, memory −3.74%.
- [x] Capture fresh database dumps, configuration, source and baseline images. Fully restore both databases in a networkless container on the same host; verify rows, constraints, indexes and baseline hashes; remove restore resources.
- [x] Rehearse exact candidate promotion and rollback for all four tenant roles, including session isolation, inactive/stale rejection and mismatched-evidence rejection.
- [x] Build hash-verified immutable images and pass an isolated Node/Python canary before promotion.
- [x] Publish release `eeeac359-a115-4df7-a9a7-e5ba310b8815`, revision **12**, and matching runtime/images. All four demos report identical release/runtime/fingerprint; production relational data confirms **3,524 concepts / 5,628 forms / 94 governed rules**.
- [x] Verify **12/12 real production guest turns**: exact product-name results, recipient interpretation with budget, and conflicting-price clarification on every demo. No commerce writes, model fallback or tracking-setting changes. All eight assistant consumers are healthy; gateway/rengine reader images are preserved.
- [x] Save guarded rollback instructions and scripts; automatic rollback was armed during cutover and was not needed. Rollback refuses if a subsequent release or producer image has replaced this baseline. Customer database writes are not overwritten by routine rollback.

Final evidence and limitations: [publication report](../history/enterprise-knowledge-revision12-publication.md), `output/enterprise-knowledge-v12-production-20261011/`. Earlier combined-candidate reports remain preserved in `output/enterprise-knowledge-publish-batch2-20261010/`; that tracing producer was not published. Local latency/import numbers are not production capacity guarantees. Arabic and the stopped bulk 4,000-case live test remain outside this release.
