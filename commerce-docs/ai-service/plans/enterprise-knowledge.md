# Enterprise shopping knowledge plan

This plan owns remaining English knowledge, authoring and evaluation work across grocery, electronics, jewelry and pharmacy. Release results belong in [AI release history](../history/README.md); operational commands belong in the [language release lifecycle](../language-release-upgrade.md).

| Field | Value |
| --- | --- |
| Owner | AI service maintainers |
| Status | Active; bounded revision-12 release complete, broader coverage and tooling remain open |
| Reviewed | 2026-10-14 against source and recorded reports; production was not contacted |
| Last recorded publication | [Revision 12, 2026-10-11](../history/enterprise-knowledge-revision12-publication.md) |
| Next review | After the next bounded expansion, deployment, or change to acceptance criteria |
| Full prior plan | [Snapshot retained on 2026-10-14](../history/enterprise-knowledge-plan-2026-10-14.md) |

## Recorded baseline and lifecycle

The latest publication report records **3,524 concepts, 5,628 forms, 94 governed rules and 1,273 recognition definitions**. Its UUIDs, runtime hashes, backup locations and rollback guards live in that report. Reinspect the actual active release before making another candidate; a documentation review does not verify current production state.

| Work | Implementation | Local verification | Deployment | Production acceptance |
| --- | --- | --- | --- | --- |
| Revision-12 vocabulary, alias authoring, adjacent-budget clarification and catalog identity fixes | Complete for the recorded release | 136,372 archive cases, 40 vocabulary cases and 33 Python admission cases pass; limitations and broader-suite reconciliation retained in the publication report | Published to all four demos on 2026-10-11 | 12/12 bounded guest turns and all-demo readiness/contracts passed on that date |
| Import finalization optimization | Complete for that runtime | 1,023–1,028 concepts/s including finalization; final importer hashes match measured code | Included in revision-12 runtime | Production capacity remains unqualified |
| Domain evidence and conditional product profiles | Initial flagged implementation complete | Synthetic profiles, HTTP flow and disposable-database checks recorded in [Phase 3](../history/enterprise-knowledge-phase3.md) | Domain evidence remains disabled in the recorded release | Independent profile review, exact-model attestations and real-catalog acceptance remain open |
| Capture-v2 tracing producer | Separate local implementation | Functional checks pass in the [tracing records](../../rengine/history/README.md) | Producer canaries rolled back; compatible readers retained | Blocked on the unchanged live latency gate; see [tracing rollout](../../rengine/tracing-rollout.md) |

The former “next milestone” to repair contradictory budgets and investigate import finalization is closed by revision 12. The initial four catalog-name findings also have bounded passing evidence. Broader catalog bindings, unknown sibling names and answer quality remain expansion work, rather than reasons to repeat the completed fixes.

## Next bounded expansion

Use the existing [knowledge authoring](../knowledge-authoring.md) and [vocabulary import](../enterprise-knowledge-vocabulary-expansion.md) capabilities. Inventory gaps before choosing new schemas or endpoints.

1. **Freeze scope and acceptance.** Inspect the active immutable release, existing tables, draft commands and import checkpoints. Select a reviewable vocabulary/rule family and concrete authoring or recovery gap. Freeze positive, negative, ambiguous and multi-turn expectations plus latency/memory/import budgets before implementation.
2. **Extend useful English coverage.** Add sourced concepts, forms and contextual rules with language, scope, ambiguity, provenance, license and review state. Include unfamiliar product/model siblings and conflicting attributes; tenant catalog identities and product facts must stay tenant scoped.
3. **Complete missing authoring and recovery tools.** Extend concept/rule editing, deprecation and replacement beyond the implemented alias editor. Add only missing conflict checks, rejected-row explanations, source reconciliation, retry controls and audit visibility. Preserve immutable drafts, stale-input guards and existing resumable committed progress.
4. **Verify the exact candidate.** Replay the current immutable corpus, preserving original reports and explicit benchmark revisions. Test Node-to-Python meaning preservation separately from catalog and final-answer correctness. Rehearse interruption/recovery, concurrent operators, tenant isolation, migrations, promotion and rollback.
5. **Record lifecycle independently.** Write a dated result with source/runtime/artifact identity, accepted/rejected/ambiguous/duplicate counts, evidence location and remaining gaps. Mark implementation, local validation, deployment and production acceptance separately. Publication requires the applicable release gates below.

Acceptance for this increment: a measurable coverage or operator-workflow gain, no unexplained regressions, traceable reviewed changes, unchanged isolation/immutability boundaries, and a reproducible result on the exact frozen candidate. A larger record count is not an acceptance result.

## Remaining work after the next increment

| Priority | Remaining deliverable | Acceptance |
| --- | --- | --- |
| Useful vocabulary and rule scale | Progress toward 10,000–25,000 concepts and 100,000–250,000 reviewed forms through successive releases | Report useful coverage and independently reserved wording separately from bulk counts; preserve legitimate ambiguity |
| Measured database scale | Representative lookups, interrupted imports, compilation, selective loading and operator explanation queries | Measure data/index/retained-release size and runtime memory separately; add indexes or partitioning only for measured needs |
| Product evidence | Independently reviewed conditional profiles, current exact-model attestations and tenant field mappings | Ground real-catalog answers in fresh evidence, preserve budgets and identity, and return unknown for absent/conflicting facts before enabling domain evidence |
| Larger evaluation | Family-disjoint datasets from 100,000 toward million-scenario scale | Independent expected outcomes, versioned rubric/catalog snapshot, separate interpretation/retrieval/grounding/answer metrics, calibrated supplementary judges and reproducible offline execution |
| Operations | Explicit load objectives, bounded resource use, recovery and review of observed failures | Representative hardware/load qualification, matching Node/Python/data identities and tested all-store recovery |

Keep large source and evaluation collections outside request-time packs. The current 32 MiB runtime-pack bound is not permission to load GB-scale data into every request. Historical capacity estimates and broader design proposals remain in the [prior plan](../history/enterprise-knowledge-plan-2026-10-14.md#storage-and-capacity-assumptions); qualify them with measured useful records before adopting them.

## Release gates and boundaries

Apply the [release lifecycle](../language-release-upgrade.md), [shared database operations](../shared-database-operations.md), and [database quality and evaluation guide](../database-quality-upgrade.md) to every new release:

- Validate schema, references, rules, contracts, source provenance and applicable evidence freshness.
- Pass the mandatory regression and reserved batch gates, reporting changes and failure categories explicitly. Preserve historical labels and reports; justified corrections require a versioned benchmark.
- Verify budgets, identity, unknown-evidence behavior and tenant isolation. Node interpretation, Python admission, catalog correctness and useful final answers are separate outcomes.
- Meet the budgets agreed before measurement; investigate regressions without changing the threshold to make a candidate pass.
- Rehearse migration, exact-candidate promotion, matching-runtime rollback and backup restoration. Shared language publication targets all stores.
- Complete a bounded authorized live sample and record the acceptance limits. Synthetic regression success does not establish general customer accuracy or production capacity.

Preserve the shared `assistant` and `commerce_language` databases, runtime role restrictions and immutable releases. Node owns interpretation; Python owns validated execution. The mutable checkout contains separate tracing work: use a fresh validated freeze for a future deployment and preserve the blocked producer distinction.

Arabic and the stopped original 4,000-case bulk live run remain outside this plan's current increment. Preserve the original CSV and grades; new bulk live evaluations require their existing explicit authorization. For grocery and pharmacy, category names alone never establish allergen safety, medical suitability or compatibility.
