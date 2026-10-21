# Vocabulary imports and review

This guide owns the resumable vocabulary importer and its source/review boundaries. Reviewed against the importer source on 2026-10-14. The [first expansion report](history/enterprise-knowledge-vocabulary-expansion-2026-10-10.md) preserves revision-9 counts, source hashes, local staging and original failures; subsequent fixes and publication are recorded in [revision 12](history/enterprise-knowledge-revision12-publication.md). Remaining coverage and authoring work belongs in the [active plan](plans/enterprise-knowledge.md).

## Prepare reviewed data

Start from the intended active immutable release and add only a reviewable, scoped batch. Preserve concept IDs, source/license notices, ambiguity and provenance. Vocabulary does not establish current stock, product suitability, compatibility or medical facts. Record whether review is independent per-entry adjudication, sampled review or AI-assisted policy review; a hash proves identity, not review quality.

The first licensed noun expansion used selected Princeton WordNet 3.1 branches. Its exact extraction scope, archive/noun hashes, exclusions and original counts remain in the [historical source report](history/enterprise-knowledge-vocabulary-expansion-2026-10-10.md#sources-and-review). Preserve the source-adjacent [source notes](../../commerce-assistant-platform/app/commerce_language_engine/data/knowledge/SOURCES.md) and [WordNet license](../../commerce-assistant-platform/app/commerce_language_engine/data/knowledge/WORDNET-LICENSE.txt) in derived data and exports. Reusing that batch does not certify it as a newly reviewed source.

## Import behavior and database tables

Migration `031_knowledge_bulk_imports.sql` adds operator-only tables in `commerce_language`:

| Table | Purpose |
| --- | --- |
| `knowledge.bulk_imports` | Immutable manifest/base identity, progress state and final candidate ID |
| `knowledge.bulk_chunks` | Completed chunk checksums, sizes and record counts |
| `knowledge.bulk_concepts` | Staged concept records with unique IDs and ordered positions |

Each chunk commits rows and checkpoint together. Retry skips committed chunks, rejects changed bytes/conflicting IDs and resumes missing chunks. An interrupted chunk rolls back independently. A per-import lock prevents two operators advancing the same upload simultaneously.

Finalization reconstructs and validates the pack, checks its hash and expected active fingerprint, and uses the existing inactive release importer. It reuses `knowledge.packs`, `knowledge.concepts`, `knowledge.aliases`, `lexicon.terms` and release lifecycle tables. It never activates the production channel. If the candidate commits before the final checkpoint update, retry recovers that candidate instead of duplicating it.

Cancellation retains audit rows. Runtime roles cannot read or modify the upload tables, including after shared-tenant grants are reapplied. Imported candidates require the ordinary exact evaluation/promotion/rollback process; the bulk CLI has no activation command.

Bounds: 500 records and 1 MiB per chunk, 32 KiB per record, a 1 MiB manifest, 100,000 concepts and a 32 MiB serialized pack. Upload is resumable; finalization still assembles and compiles one bounded pack in memory. Larger collections need separately qualified selective loading. These limits are not production throughput guarantees.

## Commands

Run from `commerce-assistant-platform/app/commerce_language_engine`. Database commands require an operator `DATABASE_URL` supplied through protected configuration and migrations applied through the existing operator workflow. Substitute the newly reviewed pack and intended active fingerprint; do not reuse a historical candidate's values blindly.

```sh
# Prepare files only; an existing bundle directory is never overwritten.
node scripts/bulk-language-knowledge.ts prepare \
  --pack /absolute/path/to/reviewed-pack.json \
  --bundle /absolute/path/to/new-bundle --batch-size 250

# Upload writes inactive staging rows. Save the returned import ID.
node scripts/bulk-language-knowledge.ts upload \
  --bundle /absolute/path/to/new-bundle \
  --expected-fingerprint CURRENT_ACTIVE_FINGERPRINT

# Inspect is read-only; finalize creates or recovers an inactive candidate.
node scripts/bulk-language-knowledge.ts inspect --id IMPORT_ID
node scripts/bulk-language-knowledge.ts finalize --id IMPORT_ID

# Optional: stop an unfinished upload, retaining its audit history.
node scripts/bulk-language-knowledge.ts cancel --id IMPORT_ID
```

`upload --max-chunks 2` pauses after at most two new chunks. A changed manifest or base fingerprint creates a different import identity; an existing upload is never silently rebased. Finalization rejects a stale active fingerprint. Follow the [release lifecycle](language-release-upgrade.md) for evaluation and promotion; ordinary deployment does not approve vocabulary activation.

The command implementation is [bulk-language-knowledge.ts](../../commerce-assistant-platform/app/commerce_language_engine/scripts/bulk-language-knowledge.ts), with validation and recovery in [knowledge-bulk.ts](../../commerce-assistant-platform/app/commerce_language_engine/src/knowledge-bulk.ts).

## Validation and retained results

For each new frozen candidate, record source/license hashes, accepted/rejected/ambiguous/duplicate counts, interrupted/repeated upload behavior, stale-base and corruption rejection, concurrent-operator behavior, exact relational/artifact identities, runtime-role exclusion and unchanged activation before promotion. Measure chunk upload and finalization separately as well as end-to-end throughput. Exercise language/Python boundaries and real-catalog answer quality as separate outcomes.

The [revision-12 report](history/enterprise-knowledge-revision12-publication.md) records the later finalization optimization and local end-to-end floor passing; the first expansion's parser gaps and promotion blockers are historical. That measurement does not qualify production capacity or complete the plan's vocabulary scale milestone. Retain prior failed reports and frozen labels when measuring a successor.
