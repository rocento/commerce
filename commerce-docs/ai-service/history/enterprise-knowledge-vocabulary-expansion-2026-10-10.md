# Phase 2 vocabulary expansion and resumable imports

> Historical record of the 2026-10-10 revision-9 increment, retained during consolidation on 2026-10-14. Its staging state, old local database port and blockers describe that candidate only. Later repair/publication is recorded in [revision 12](enterprise-knowledge-revision12-publication.md). Use the [current importer guide](../enterprise-knowledge-vocabulary-expansion.md) for new work.

Date: 2026-10-10. **First expansion batch implemented, tested and staged locally as inactive knowledge revision 9.** The full vocabulary targets in the [enterprise plan](../plans/enterprise-knowledge.md) remain open. Production was not connected, deployed or activated.

## What grew

| Kind | Revision 8 | Revision 9 | Added concepts |
| --- | ---: | ---: | ---: |
| Product nouns | 118 | 2,585 | 2,467 |
| Activities | 147 | 249 | 102 |
| People / recipients | 81 | 109 | 28 |
| Materials | 45 | 90 | 45 |
| Occasions | 45 | 63 | 18 |
| Colors, countries, devices, dimensions and units | 420 | 420 | 0 |
| **Total concepts** | **856** | **3,516** | **2,660** |
| **Canonical and alternate forms** | **1,784** | **5,580** | **3,796** |

Revision 9 has 5,571 distinct token-normalized surfaces; nine existing shared spellings remain explicitly scoped by kind. All prior IDs, canonical forms and aliases are retained. The 88 governed rules—including 54 relationship rules—are unchanged. New vocabulary reuses those rules instead of creating one rule per word.

Examples include audiobook recording, motion graphics, macro photography, hand sewing, furniture restoration, sourdough baking, milk frothing, trail running, stepmother/stepmum, lab partner, bridesmaid, microfiber/microfibre, merino wool, carbon steel, borosilicate glass, coffee urn, espresso maker, staple gun and cranberry juice. Words supplied by a shopper do not establish demographics, stock, suitability, compatibility or medical facts.

## Sources and review

Product nouns come from a restricted subset of [Princeton WordNet 3.1](https://wordnet.princeton.edu/), downloaded from its [official database archive](https://wordnetcode.princeton.edu/wn3.1.dict.tar.gz). Its [license](https://wordnet.princeton.edu/license-and-commercial-use) permits redistribution subject to its notice. The exact notice extracted from the noun database is preserved in `ai-service/app/commerce_language_engine/data/knowledge/WORDNET-LICENSE.txt` and in the pack's source field, so database exports and upload bundles retain it.

- Archive SHA-256: `3f7d8be8ef6ecc7167d39b10d66954ec734280b5bdcd57f7d9eafe429d11c22a`.
- `data.noun` SHA-256: `2cad22fe43461ee7ae61a564ae6a518c57445c8597e53542caddb5c26a6a5d94`.
- Selected branches: clothing/footwear, furniture, home appliances, utensils/tools, electronics, sporting goods, musical instruments, toys, jewelry, cosmetics, fabrics, solid foods, foodstuffs, beverages and two explicit office-tool senses.
- Of 3,778 selected senses, 2,467 supply new, unambiguous product vocabulary. Forms with multiple WordNet noun senses, collisions with existing concepts, non-plain common-noun spellings and empty remaining form sets are excluded. General diet labels and unselected branches are not imported. The source is historical vocabulary, not current product specifications.
- Each imported concept records its exact synset, source hash, branch anchors, lexical-only usage and review scope. Glosses are not copied into runtime claims. No Arabic-script forms or generated synonym/plural combinations are added.

Activities, recipients, materials and occasions are first-party English wording in `phase2-expansion-curated.json`. Existing meanings are extended only when they already own the exact canonical surface. Source exclusions are recorded in `output/enterprise-knowledge-expansion-20261010/exclusions.jsonl`.

Review is **AI-assisted extraction-policy and sampled review** for imported nouns, plus AI-assisted first-party wording review. Hashes bind the reviewed forms and scope; they do not prove independent human adjudication of every entry. Independent review remains a release gate.

## Import behavior and database tables

Migration `031_knowledge_bulk_imports.sql` adds three operator-only tables in the existing `commerce_language` database:

| Table | Purpose |
| --- | --- |
| `knowledge.bulk_imports` | Immutable manifest/base identity, progress state and final candidate ID |
| `knowledge.bulk_chunks` | Completed chunk checksums, sizes and record counts |
| `knowledge.bulk_concepts` | Staged concept records with unique IDs and ordered positions |

Each batch commits its rows and checkpoint together. A retry skips committed batches, rejects changed bytes or conflicting IDs, and uploads missing batches. An interrupted batch rolls back independently. A per-import lock prevents two operators from advancing the same upload simultaneously.

Finalization reconstructs and validates the pack, checks its canonical hash and expected active fingerprint, and calls the existing inactive importer. The final candidate uses the existing `knowledge.packs`, `knowledge.concepts`, `knowledge.aliases`, `lexicon.terms` and release lifecycle tables. It never changes the production channel. If the candidate commits before the final checkpoint update, a retry recovers the same candidate instead of duplicating it.

Cancellation stops an unfinished upload and retains its audit rows. Imported candidates use the existing release evaluation/promotion/rollback process. There is no activation command in the bulk CLI. Runtime roles cannot read or modify the upload tables, including after shared-tenant grants are reapplied.

Bounds: at most 500 records and 1 MiB per chunk; 32 KiB per record; 1 MiB manifest; 100,000 concepts and 32 MiB serialized pack. **Upload is resumable, but finalization still assembles and compiles one bounded pack in memory.** GB-scale collections need partitioning and selective loading in later work. These limits are not a GB throughput certification.

## Commands

Run these from `ai-service/app/commerce_language_engine`. Database commands require an operator `DATABASE_URL` supplied through the existing private configuration. Apply migrations through the existing deployment/operator workflow first; do not restore a local database over production.

```sh
# Create a new immutable upload directory; existing directories are not overwritten.
node scripts/bulk-language-knowledge.ts prepare \
  --pack data/knowledge/shopping-en-phase2-v3.json \
  --bundle /absolute/path/to/new-bundle --batch-size 250

# Save the returned import ID. Repeating this command resumes missing chunks.
node scripts/bulk-language-knowledge.ts upload \
  --bundle /absolute/path/to/new-bundle \
  --expected-fingerprint CURRENT_ACTIVE_FINGERPRINT

node scripts/bulk-language-knowledge.ts inspect --id IMPORT_ID
node scripts/bulk-language-knowledge.ts finalize --id IMPORT_ID

# Optional: stop an unfinished upload while retaining its audit records.
node scripts/bulk-language-knowledge.ts cancel --id IMPORT_ID
```

`upload --max-chunks 2` deliberately pauses after at most two new batches. A changed manifest or base fingerprint creates a different import identity; an existing upload is never silently rebased. Finalization rejects a stale active fingerprint. Follow the [release runbook](../language-release-upgrade.md) for evaluation and promotion. `deploy.sh` does not perform this vocabulary upload or approve its activation automatically.

To reproduce source extraction, retain the hash-locked `sources/data.noun` under the output directory and run `node scripts/prepare-vocabulary-expansion.ts`. It creates the same revision-9 file and exclusion report. To check the final evidence from the repository root, run `node scripts/knowledge-baseline/verify-vocabulary-expansion.mjs`. Earlier phase evidence remains unchanged; their frozen reports are historical results, not reruns against this expanded runtime.

## Local staging and measured size

The pre-migration database backup is `/private/tmp/commerce-vocabulary-expansion-before-20261010.dump` (also retained inside the local database container). The existing local shared database on port 5432 received migration 031 and the inactive candidate; no new database replaced it.

- Candidate release: `c6eb172b-d8b8-4e1e-8cc9-32bb8190a7af`.
- Candidate fingerprint: `234d1cb26252bd7631223ad15a1ea0135f076d2cb367a304e9d8be087e78194c`.
- Pack hash: `e8ea7b7570a46b313c36e76336aa06adaa73ef6311e39e663b95561d2bc0e9a0`.
- Upload ID: `ad88c0c6d2b59018d8e9f1a84a907d64f14ab0a3f8d55c5bdc315e65ed0b771d`.
- Active release remained revision 5: `4d29d56d-5e4c-45bd-96b8-83ba9b7177b2`.

The rehearsal committed two chunks / 500 concepts, resumed all 15 chunks / 3,516 concepts, verified exact relational counts and pack content, and repeated finalization without creating another candidate. Upload and finalization took approximately 1.86 seconds on the local host; this excludes backup, migration and source preparation.

The formatted knowledge pack is **3,890,219 bytes (3.89 MB)**. Concept upload payload is **2,646,222 bytes**; headers are separate. Staging concepts and indexes occupy 4,440,064 bytes; chunk/job tables add 139,264 bytes. The entire local language database measured 136,215,575 bytes, including pre-existing releases and data. These measurements are not the future 10–50 GB knowledge target, and evaluation artifacts are separate.

## Verification and remaining gaps

- Full Node suite: **750 passed, zero failures/skips**. Final targeted run after the last import-bound and annotation checks: **47 passed**.
- Real Node-to-Python admission: **13 passed**, including new recipient/use/material wording, budgets, absent merchant fields, forged context and exact noun annotation.
- Deployment/migration checks: 16 passed plus 12 subtests; eight existing assistant-merge integration tests were skipped because their separate disposable container was not configured. The changed language grant behavior was tested against real PostgreSQL, including repeated policy application.
- TypeScript typecheck and Python lint pass. Source, bundle, old reports and the original CSV are hash-checked.
- Frozen historical regression: 4,000 conversations / 4,675 turns; **zero regressions and zero gains** under the existing parser rubric. The original live answer grades were not changed.
- Twenty-two AI-authored development examples: typed relation extraction **3 → 20 passes**, 17 gains, zero regressions. These are exposed authoring examples, not independent held-out quality labels. `EXPANSION-002` (macro photography with an under-budget phrase) and `EXPANSION-005` (hand sewing) still return the older `catalogPurpose` field instead of typed `shoppingContext`; their labels and outputs are retained.
- Sequential local parser p95: **8.425 → 8.653 ms (+2.70%)** across 4,675 turns. Peak process RSS: **458,768 → 460,688 KiB (+0.42%)**. These are single-process samples, not production load or GB-scale tests.

Exact complete product wording now takes precedence in the diagnostic product meaning: “coffee urn” is annotated as the full noun instead of “coffee.” This does not change catalog entity authority or repair every legacy category match. Raw product text remains available for catalog grounding.

Generic searches such as “a gift for my stepmum” and “products made of carbon steel” remain outside the contextual extractor's bounded product rule. They are documented gaps, not counted as solved. Initial test logs are retained; absent optional action arrays and the established strict meaning of “under” were corrected in the test harness, while these generic-request gaps stayed visible.

Next work: address the typed-context routing gaps; independently review and add the next useful source batches toward 10,000–25,000 concepts / 100,000–250,000 forms; add reviewed exact-model product evidence; then scale evaluation and selective retrieval. Existing tracking-contract and routing-architecture repository blockers, archived-corpus gates, live catalog checks, all-demo consistency and rollback requirements still prevent production promotion.

Evidence: `output/enterprise-knowledge-expansion-20261010/` contains source hashes, exclusions, pack/bundle manifests, frozen runtime, test logs, authoring-example results, offline replay, local staging, performance and verification reports.
