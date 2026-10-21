# Enterprise knowledge — Phase 2 local implementation

> Historical record: identities, commands and results apply to the recorded candidate only.
> For current operations, use the [language release lifecycle](../language-release-upgrade.md)
> and [shared database runbook](../shared-database-operations.md). See the [history index](README.md).

Date: 2026-10-10. Status: the first curated Phase 2 release is implemented, tested and stored as **inactive local revision 7**. Three reserved-validation mismatches and the larger coverage milestones remain open. Production is not ready for promotion on this evidence alone.

This report accompanies [the main plan](enterprise-knowledge-plan-2026-10-14.md). Evidence is saved in `output/enterprise-knowledge-phase2-20261010/`. Every completed implementation step is checked in the main plan.

## Vocabulary and rules delivered

| Kind | Revision 6 | Revision 7 | Added concepts |
| --- | ---: | ---: | ---: |
| Activities | 86 | 147 | 61 |
| Colors | 101 | 101 | 0 |
| Countries | 257 | 257 | 0 |
| People/recipients | 69 | 81 | 12 |
| Occasions | 32 | 45 | 13 |
| Devices | 18 | 22 | 4 |
| Materials | 0 | 45 | 45 |
| Product terminology | 0 | 118 | 118 |
| Packaging/measurement units | 0 | 32 | 32 |
| Dimensions | 0 | 8 | 8 |
| **Total** | **563** | **856** | **293** |

Canonical names plus aliases increased from **1,160 to 1,784**: 624 additional forms. These represent 1,775 distinct normalized spellings; explicitly reviewed spellings shared across kinds account for the difference. In addition to 293 new concepts, 18 existing concepts gained aliases or reviewed ambiguity metadata.

All 311 added/amended concepts carry explicit usage and domain scope, source, author, reviewer, review method, and hashes covering forms and metadata. These are **AI-assisted reviews**, not independent human linguistic validation. The importer rejects missing or stale reviews. Existing older concepts retain their original metadata.

Examples include bookkeeping, invoicing, transcription, bird photography, batch cooking, hand washing, afternoon tea, body care, titanium, nickel, cotton, stainless steel, mentor, godmother, ampoules, sachets, tins, millimeters, length and diameter. Product terminology comes from existing published CATEGORY aliases across electronics, grocery, jewelry and pharmacy. Country and color coverage was retained rather than padded with duplicates.

The pack contains **87 governed rules**, up from 68:

- Material relationships: `made of`, `made from`, `with` — 3 rules.
- Explicit color/material exclusions: `without`, `except`, `except for`, `excluding`, `but not`, `with no` — 12 rules.
- Device wording with `with` requires clarification — 1 rule.
- Intended use introduced by `to do` — 1 rule.
- Inline `between … and …` / `from … to …` budget ranges — 1 rule with 5 templates.
- Spending-limit / maximum-budget wording — 1 rule with 3 templates.

The complete pack has 53 relationship rules, 20 utterance rules, 11 question rules and 3 budget rules. Its reviews contain **88 positive examples and 190 counterexamples**. Existing rule definitions and review versions remain intact; new composition rules require `knowledge-composition-v2`.

Exact inventories: `vocabulary-changes.json` and `rule-changes.json` in the evidence directory. Source inputs are `ai-service/app/commerce_language_engine/data/knowledge/phase2-vocabulary.json` and the reproducible builder `scripts/prepare-phase2-knowledge.ts` within that engine.

## Runtime behavior

The parser preserves each relationship's exact source span, concept, rule and polarity. Conjoined recipients/uses can inherit a preposition; explicit exclusions can inherit exclusion polarity. Unknown words, conflicting requirements, ambiguous color/material spellings, double negatives and mixed clauses covered by the new composition path request clarification.

Budget ranges reject reversed endpoints and incompatible currencies. Follow-up changes preserve recipients, exclusions, currency and the unaffected bound. Changing an intended use or material replaces only the proven old relationship. Dependencies that cannot be safely rewritten require restatement.

Python independently verifies source words against the same published concepts and rules. A declared negative rule cannot become a positive filter. Material and color constraints require an unambiguous live, filterable catalog field and value; multiple negative values remain separate exclusions. Missing evidence triggers clarification. A material name does not establish allergy safety, composition, medical suitability or compatibility.

Product, packaging and dimension vocabulary supplies descriptive annotations. It does not establish SKU availability, convert measurement units, establish dosage, or certify a product's dimensions. Device names do not provide connector specifications. New full model names keep the named-device evidence requirement.

## Verification

| Check | Result |
| --- | --- |
| Node suite, including disposable PostgreSQL and local HTTP tests | **696 passed, 0 failed, 0 skipped** |
| Python shopping/catalog/context checks, including real Node output admission | **183 passed** |
| TypeScript typecheck | Passed |
| Database v2 storage, activation and rollback | Passed in disposable databases |
| Local candidate vs. frozen artifact and relational records | Exact match; inactive |
| Original historical replay | 4,000 conversations / 4,675 turns; **0 regressions, 0 gains** |
| Reserved Phase 2 validation | **25/28**, versus **6/28** for revision 6; 19 improvements, 0 regressions |
| Local parser p95 | **9.015 ms**, +4.21% from Phase 1 |
| Peak process RSS | **494.80 MiB**, +1.36% from Phase 1 |

The historical replay remains at 1,277 fully passing conversations and 1,440 passing turns under the frozen language rubric. No historical entity rows changed. This release adds useful new composition coverage; it does **not** demonstrate improvement to the previously reported 3,599 bad live answers. Their original CSV grades remain unchanged.

The 28 Phase 2 conversations contain 31 turns. Their expectations were hash-locked before implementation, and evaluated once after freezing the candidate. They were authored by the implementing AI, share underlying grammar with authoring examples, and are **not independently reviewed or family-disjoint human hold-outs**. The raw 25/28 result has not been relabeled or tuned away. The 16 Phase 0 reserved cases remain unexecuted.

Performance is a sequential local parser comparison using the same harness and environment. It is not production response latency, a concurrency test, or a capacity guarantee. The pack is approximately 0.70 MiB; the reported process RSS includes the whole parser/runtime, not just this knowledge pack. Both performance changes are inside the plan's 20% investigation threshold.

## Remaining validation findings

| Case | Observed mismatch | Required follow-up |
| --- | --- | --- |
| P2-VAL-008 | “for my family” uses the existing `audience` role; the locked expectation requested `recipient`. Intended use, product and price are retained. | Adjudicate collective recipient vs. audience semantics, particularly possessive groups, before changing the role contract. |
| P2-VAL-020 | “for my mother or my father” remains a literal product query and reports `RESOLVED`. No write is produced, but the expected focused clarification is missing. | Add explicit handling for recipient alternatives and verify it on a fresh reserved set. |
| P2-VAL-024 | The language result is `RESOLVED` with a `named_device_compatibility` evidence requirement; the expectation required language-level `NEEDS_CONTEXT`. No write or verified compatibility claim is emitted. | Reconcile the benchmark with the boundary between language extraction and action-service evidence handling; retain the original failed label until adjudicated. |

These cases remain open in the plan. A subsequent revision must keep this report immutable, turn known failures into regression cases, and use fresh reserved expectations for any new generalization claim. Full shopper-answer evaluation against live tenant catalogs remains a separate promotion gate. The Phase 0 write-intent findings also remain subject to their existing adjudication gate.

The planning milestones of 10,000–25,000 concepts, 100,000–250,000 forms and 100,000 scenarios have **not** been reached. This is a curated initial release, not a gigabyte-scale knowledge base or evidence of million-case coverage.

## Database and release identity

Migration: `029_english_composition.sql`. It adds material relations, exclusion/clarification policy columns, range budgets and the `knowledge.lexical_reviews` view. Previously applied migrations were not edited. A local pre-migration backup is saved at `/private/tmp/commerce-phase2-before.dump`.

Local candidate: `74071845-b9a6-491a-88bc-f9ee4fc73ef2` — revision **7**, inactive.

Local active release remains `4d29d56d-5e4c-45bd-96b8-83ba9b7177b2` — revision **5**. Revision 6's earlier candidate is also preserved. No production connection or deployment was performed in Phase 2.

| Identity | SHA-256 |
| --- | --- |
| Candidate fingerprint | `67941e9b522e1052b6f35dbccf8539910a3240d24daa9d7ee4f036aaf60411fe` |
| Knowledge pack | `5494fbab43bd8d9d6a1347c12d95497dbebabe95a6f250eb22e295691ca1e162` |
| Node runtime | `a9996925a28270fe912f1f9a3cdd8abbdf39d70feefc1f748fc5236ce17eafd4` |
| Reserved expectation file | `29e1b713e3b6ff8413f313c0589a52ae5d6018dc17e896de504041488504fbf0` |

The snapshot additionally hashes the three changed Python boundary files. `verification.json` links the evidence files by hash and explicitly records `productionReady: false` and `reservedFullyPassed: false`.

To inspect revision 7 in DBeaver, use the local `commerce_language` database:

```sql
SELECT DISTINCT concept_code, kind, canonical, review, domains, usage
FROM knowledge.lexical_reviews
WHERE pack_code = 'shopping-english-v1' AND revision = 7
ORDER BY kind, concept_code;

SELECT family, rule_code, required_runtime, review_method, applicability
FROM knowledge.rule_reviews
WHERE pack_code = 'shopping-english-v1' AND pack_revision = 7
ORDER BY family, rule_code;
```

Underlying tables are `knowledge.packs`, `knowledge.concepts`, `knowledge.aliases`, `knowledge.rules`, `knowledge.budget_rules`, `knowledge.rule_governance`, and `release.dictionaries`. The two review objects above are views.

The active packaged `data/compiled.json` was not replaced. Deploying source code alone does not activate this candidate; a reviewed promotion must use the matching Node/Python runtime, evaluated frozen release and existing release controls.
