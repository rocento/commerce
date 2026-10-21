# Knowledge expansion batch 1 — implementation checkpoint

> Historical record: identities, commands and results apply to the recorded candidate only.
> For current operations, use the [language release lifecycle](../language-release-upgrade.md)
> and [shared database runbook](../shared-database-operations.md). See the [history index](README.md).

Started 2026-10-10. **Local candidate and operator tooling only; not published.** This begins the reprioritized rules, vocabulary and database-capability work. Production remains knowledge revision 10 / recognition revision 1.

## Database inventory and ownership

Fresh read-only production metadata confirms release `0cd45170-7a58-423c-8109-03b677edffec` and fingerprint `1db6ecd8…`. At capture, `commerce_language` occupied 216,235,031 bytes and `assistant` 13,130,775 bytes. These are whole-database measurements, including existing data and indexes, not vocabulary-pack sizes. Captured schema, columns, indexes, constraints, sizes and query plans are preserved in [inventory evidence](../../platform/evidence/README.md#evidence-0fa32f5c766ad6c4) (`output/enterprise-knowledge-expansion-batch1-20261010/production-inventory.txt`).

| Existing records/capability | Current implementation | Decision for this batch |
| --- | --- | --- |
| Versioned vocabulary | `knowledge.packs`, `knowledge.concepts`, `knowledge.aliases`, `lexicon.terms`; migration 017 and subsequent composition migrations | Extend existing immutable packs; no duplicate dictionary tables |
| Context and response rules | `knowledge.rules`, `knowledge.utterance_rules`, `knowledge.question_rules`, `knowledge.budget_rules` | Add reviewed relationship records using the current executor |
| Review and provenance | `knowledge.rule_governance`, `knowledge.rule_reviews`; migration 028 | Preserve content-bound AI/human review distinction and source attribution |
| Database recognition definitions | `release.recognition_rules`; migration 033 | Retain the published 1,273 definitions unchanged in this batch |
| Authoring and releases | `release.drafts`, `release.draft_revisions`, `release.draft_changes`, `release.candidates`, `release.evaluations`, `release.channels`; migration 022 | Reuse draft/evaluate/promote/rollback; no direct published-row edits |
| Resumable uploads | `knowledge.bulk_imports`, `knowledge.bulk_chunks`, `knowledge.bulk_concepts`; migration 031 | Reuse checksum checkpoints, cancellation and immutable finalization; add operator visibility |
| Scoped lookup indexes | Existing concept pack/kind index, alias lexical index and composite primary keys | No new index justified by this small batch; measure before adding one |
| Explanations | `govern-knowledge.ts explain`, `knowledge-explanation.ts` | Existing matched-span explanation is separate from the new catalog search; cold dictionary-context requirements need attention in further tooling work |
| Exact names and product facts | Tenant catalog schemas/search/product APIs; Python catalog grounding | Keep names/models/attributes tenant-scoped; do not insert global exceptions for the four demo failures |

Shared language records express wording and relationships. They do not assert merchant availability, shipping eligibility, model specifications or medical suitability. Tenant product evidence remains separate; domain evidence is still disabled in production.

## Frozen acceptance and first candidate

Thirty English expectations were frozen before authoring: 18 development and 12 reserved cases. They cover four known product-name failures and four additional identity/modifier scenarios, work/study aliases, purpose composition and negative/write boundaries. The labels are AI-authored, share vocabulary families with authoring, and are not independent human evaluation. [Acceptance manifest and lock](../../platform/evidence/README.md#evidence-eccc95d41073da65) (`output/enterprise-knowledge-expansion-batch1-20261010/acceptance-lock.json`) preserve all cases, including unresolved ones.

Local candidate revision 11 contains **3,516 concepts, 5,596 forms and 92 governed rules**: 16 added aliases on eight existing concepts and three new relationship rules. The unchanged concept count is deliberate: synonyms extend existing meanings.

| Existing concept | Added forms |
| --- | --- |
| Online classes | joining remote classes; attending virtual lessons |
| Note taking | taking lecture notes; making study notes |
| Spreadsheets | working on spreadsheets; editing spreadsheets |
| Video calls | joining video meetings; attending video meetings |
| Essay writing | writing school essays; drafting essays |
| Office work | everyday office work; daily office tasks |
| Presentations | preparing presentations; showing presentations |
| Research writing | writing academic papers; drafting research papers |

New purpose markers are **to help with**, **for practicing**, and **for practising**. They use existing typed activity slots and governance, preserve budgets and do not certify product suitability. Per-concept lexical review hashes and per-rule review records accompany the data. The inherited source/license text is unchanged.

## New database operator capability

`scripts/knowledge-catalog.ts` provides:

- Paginated concept/alias search, kind filtering and applicable rule/source/review information.
- Immutable-pack diffs reporting added, removed and changed concepts/rules, including governance changes and form counts.
- Read-only release inspection from PostgreSQL and upload-job visibility: expected/completed concepts and chunks, uploaded bytes, status, timestamps and candidate release.

Database reads use a repeatable-read, read-only transaction, bounded result limits, parameterized identifiers and a statement timeout. The operator transaction always rolls back on exit. No migration is necessary for these views; the existing records already contain the required information. Rejected-row persistence, draft edit/deprecation workflows, broader conflict reports and incremental compilation remain open capabilities.

Example commands from the language-engine directory:

```sh
node scripts/knowledge-catalog.ts search --dictionary ../../../output/db-driven-language-20261010/activation/candidate.json --query 'online classes' --kind activity --limit 5
node scripts/knowledge-catalog.ts diff --dictionary ../../../output/db-driven-language-20261010/activation/candidate.json --pack ../../../output/enterprise-knowledge-expansion-batch1-20261010/candidate-pack-v11.json
# With an explicitly configured operator DATABASE_URL:
node scripts/knowledge-catalog.ts imports --limit 10
node scripts/knowledge-catalog.ts search --release-id 0cd45170-7a58-423c-8109-03b677edffec --query 'video calls'
```

## Validation and remaining work

TypeScript checking and all 34 targeted operator/import/governance tests pass with real PostgreSQL fixtures. The candidate-specific disposable-database rehearsal paused at 500 concepts, resumed all 3,516 concepts across eight chunks, finalized an inactive candidate, repeated finalization safely, and verified that the active baseline stayed unchanged. Its measured upload time is a small local fixture result, not a production throughput commitment. Initial harness attempts and corrections are retained.

The language subset passes **22/22**, versus **3/22** with the published pack. The eight identity cases remain unimplemented and are explicitly excluded from this language-only score. Python boundary checks pass **11/19**; eight reserved “Please find…” cases fail because cleaned interpretation text and original-message evidence offsets differ. Expectations are unchanged; these failures block publication. The four historical exact-name limitations also remain open.

The full archived regression replay passes **136,368/136,368**, with zero response-contract failures under the unchanged rubric. A sequential local diagnostic after replay completion measured p95 13.773→16.799 ms (**+21.97%**), compile time +2.37% and peak RSS -0.50%. The p95 increase exceeds the predeclared 20% investigation threshold and remains open; the earlier concurrent sample is also retained. These short local measurements do not establish a production SLA. No regression score overrides the failing Python boundary checks. See the [checkpoint verification](../../platform/evidence/README.md#evidence-25d8bf88e0ec90ce) (`output/enterprise-knowledge-expansion-batch1-20261010/verification.json`).

Acceptance budgets were fixed before candidate evaluation: zero mandatory regression/wire/tenant/budget/identity failures; investigate p95 or compilation increases above 20%, RSS increases above 15%, or import-throughput drops above 20%. Existing 32 MiB runtime-pack and 500-record/1 MiB chunk limits remain in force. Representative isolated load measurements and a fair paired throughput baseline remain open before publication.

Next work: correct the interpretation-source boundary without weakening evidence checks, investigate latency, implement tenant-backed literal-name/model handling with sibling and conflicting-modifier tests, expand another reviewed lexical family, then complete the all-demo release gates. The disposable database was removed after validation; it was not a durable published candidate registry. Saved candidate files and evidence remain reproducible locally.
