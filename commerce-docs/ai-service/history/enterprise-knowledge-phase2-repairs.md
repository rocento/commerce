# Phase 2 — validation repairs

> Historical record: identities, commands and results apply to the recorded candidate only.
> For current operations, use the [language release lifecycle](../language-release-upgrade.md)
> and [shared database runbook](../shared-database-operations.md). See the [history index](README.md).

Date: 2026-10-10. **All three validation findings are fixed and verified locally in inactive knowledge revision 8.** The [main plan](enterprise-knowledge-plan-2026-10-14.md) records each completed step. Revision 7 and [its original report](enterprise-knowledge-phase2.md) remain unchanged as historical evidence.

## Completed repairs

| Finding | Revised behavior | Verification |
| --- | --- | --- |
| P2-VAL-008: collective recipient | “for my family” identifies a recipient group. Explicit possessives also apply to household and team; “for families” remains an audience description. | Original case passes; pronoun, alias, conjunction and Python catalog-admission checks pass. No demographic field or preference is inferred. |
| P2-VAL-020: recipient alternatives | “for my mother or my father” returns `NEEDS_CONTEXT` and asks which recipient to focus on. Product, budget and exact source phrase remain available. | Original case and fresh alternatives pass. No recipient is chosen silently and no search, write or model call is made for this clarification. |
| P2-VAL-024: explicit compatibility | “compatible with my iPhone 15” returns `NEEDS_CONTEXT`, retaining `named_device_compatibility` evidence and asking for the specification needed to verify a match. | Original case passes without relabeling its expectation. Node-to-Python checks confirm no catalog/model call or compatibility assertion. |

The compatibility policy also covers `that works with` and `to use with`. An incomplete device family asks for the exact model; an already named model is retained. Negative device requirements still ask which device is actually intended. General `for <device>` searches keep their existing downstream evidence checks.

Possessive ownership can carry through a conjunction within the same preposition, as in “for our household and team.” Repeating a preposition starts a new scope: “for my family and for teams” retains recipient then audience. Python independently checks these source conditions and rejects forged ownership or an inapplicable concept.

## Database-backed changes

The vocabulary remains **856 concepts and 1,784 canonical/alias forms**. No new spellings were required. Three existing concepts—family, household and team—now have reviewed `collectiveRecipient` metadata, with updated content hashes.

There are **88 governed rules**:

- New rule `for.possessive_collective`, version 1, selects a recipient meaning only when the published concept permits it and the source proves possession.
- `for.recipient` and `for.audience`, version 2, require clarification for recipient alternatives.
- `compatible.with.device`, `device.that_works_with` and `device.to_use_with`, version 2, explicitly require clarification before compatibility can be treated as resolved.

The six added/changed records use `knowledge-composition-v3` governance. Their reviews are AI-assisted, not independent human adjudication. Existing untouched rules and review versions remain intact.

Migration `030_person_composition_policy.sql` adds `target_possessive` and `clarify_alternatives` to `knowledge.rules`, constrains those fields to valid person relationships, and permits reviewed v3 releases in the activation guard. Earlier migrations were not modified. The importer persists the policies; disposable-database tests verify exact records, activation and rollback.

## Results

| Check | Result |
| --- | --- |
| Original 28 Phase 2 conversations / 31 turns | **28/28**, up from 25/28; 3 fixes, 0 regressions |
| Fresh 24 conversations / 25 turns | **24/24**, versus 5/24 for frozen revision 7; 19 improvements, 0 regressions |
| Full Node suite including disposable PostgreSQL and HTTP tests | **703 passed, 0 failed, 0 skipped** |
| Python shopping/catalog/evidence checks including actual Node output | **205 passed** |
| TypeScript typecheck | Passed |
| Historical replay: 4,000 conversations / 4,675 turns | **0 regressions, 0 gains, 0 changed entity rows** |
| Sequential local parser p95 | **8.591 ms**, −4.71% relative to revision 7 |
| Peak process RSS | **495.05 MiB**, +0.05% relative to revision 7 |
| Frozen source/artifact and local database consistency | Verified |

The original 28 cases are now regression tests because their failures were observed. Their original expectation file and revision-7 result were not edited. The fresh 24 expectations were hash-locked before implementation and evaluated once after freezing revision 8. They are AI-authored, share grammar families with the repairs, and do not constitute independent human or family-disjoint validation. The 16 Phase 0 reserved cases remain unexecuted.

Historical replay stays at 1,277 fully passing conversations and 1,440 passing turns under the frozen language rubric. The original CSV and live answer grades are unchanged. Passing these repairs does not establish that the original 3,599 bad answers are fixed. Performance numbers are local sequential parser samples; the small timing difference is not a production speed or capacity guarantee.

## Local release and evidence

Candidate: **`23da8cc6-a272-405c-bc5d-40ec02a24600`**, knowledge revision **8**, **inactive**.

The active local release remains revision 5, `4d29d56d-5e4c-45bd-96b8-83ba9b7177b2`. Earlier candidates remain available. A backup taken before migration 030 is saved at `/private/tmp/commerce-phase2-fixes-before.dump`. Production was not contacted, deployed or activated, and the active packaged `data/compiled.json` was not replaced.

| Identity | SHA-256 |
| --- | --- |
| Candidate fingerprint | `2becd28f4228b8e62a996b6efd0363b5a4e73816e3cf7f672c0dd095eac7dfe4` |
| Knowledge pack | `ec4e6840bf51a7204a17da4f42fae95bc8ce9f9086be1acd2bcebb64e7f5ec3b` |
| Node runtime | `0a597440448f36dec7d829b34c2aeb3e7ddfa08efb1b13c261eee20097e88c55` |
| Fresh expectation file | `914d2e199372681fbf99c72e8d16594109548a247880c36dec545f9f7d36b90f` |

Evidence is in `output/enterprise-knowledge-phase2-fixes-20261010/`:

- `verification.json`: all checks, artifact hashes, `threeFindingsClosed: true`, and `productionReady: false`.
- `original-regression.json` and `reserved-validation.json`: exact expectations, observations and comparisons.
- `snapshot-manifest.json`, `candidate.json` and `local-state.json`: frozen runtime/Python sources, release identity and database verification.
- `rule-changes.json` and `vocabulary-changes.json`: exact before/after review records and concept metadata.
- `node-tests.log`, `python-tests.log`, `offline-language-replay.json` and `local-performance.json`: test and measurement evidence.

Reproduce the integrity checks with `node scripts/knowledge-baseline/verify-phase2-repairs.mjs`. Build the separate candidate source with the engine's `scripts/prepare-phase2-repairs.ts`; it preserves revision 7. The new pack is `ai-service/app/commerce_language_engine/data/knowledge/shopping-en-phase2-v2.json`.

In DBeaver, inspect the local `commerce_language` database:

```sql
SELECT r.code, r.marker, r.relation, r.target_metadata,
       r.target_possessive, r.clarify_alternatives, r.requires_clarification
FROM knowledge.rules r
JOIN knowledge.packs p ON p.sha256 = r.pack_sha256
WHERE p.code = 'shopping-english-v1' AND p.revision = 8
ORDER BY r.code;
```

The three requested findings are closed. Independent review, broader vocabulary/scenario milestones, live catalog/answer-quality evaluation and the existing Phase 0 promotion gates remain separate work; this repair does not authorize automatic production promotion.
