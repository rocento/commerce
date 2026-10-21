# Database-backed recognition rules

The language engine's runtime dictionary carries all intent vocabulary, request prefixes, phrase patterns, aliases, exclusions, and the remaining recognition definitions previously embedded in TypeScript. `recognitionRules` contains 1,273 typed definitions. Existing semantic groups, action frames, intent rules, and contextual knowledge remain in the same dictionary snapshot.

Production loads one immutable compiled database release. It does not query PostgreSQL for every message, import bootstrap vocabulary, or fall back to source-code words. Missing or incompatible recognition data rejects compilation/startup. Existing deployment bundles must be explicitly upgraded, evaluated, and exported for this runtime before deployment; migration 033 alone does not upgrade or activate a release.

## What stays in TypeScript

TypeScript implements matching, grammar composition, capture-slot extraction, context handling, scoring algorithms, supported action identifiers, and execution/confirmation boundaries. The data supplies the spoken forms those algorithms recognize. Test utterances and customer-facing messages are not runtime intent dictionaries.

The registry has three declarative entry kinds:

- `value`: typed words, lists, maps, canonical phrases, and pattern fragments.
- `pattern`: a regular-expression source and flags, with a validated capture/global contract.
- `template`: ordered literal pieces surrounding a fixed number of substitution slots.

No stored JavaScript is evaluated. Type shape, complete rule membership, expression syntax, known complete fragment syntax, capture counts, and template arity are checked before a candidate can be compiled. Composite phrase behavior is checked by the release evaluation gate. Keep capture slots compatible when editing patterns. Add synonyms through semantic groups, prefix lists, vocabulary entries, or alternatives in an existing phrase definition.

`src/generated/recognition-contract.json` contains executor shape requirements, not English vocabulary. `seeds/*.json` are explicit bootstrap/authoring inputs. Editing a seed does not change an already published release.

## Authoring and release flow

Run these commands from `commerce-assistant-platform/app/commerce_language_engine` with the operator `DATABASE_URL` set.

For a legacy release without recognition data:

```sh
npm run recognition:upgrade -- --release-id BASE_UUID --expected-active ACTIVE_UUID
```

This stages a new candidate, preserving the base dictionary, contextual knowledge, and archived corpus. Existing release artifacts and channel pointers remain unchanged. Use `none` for `--expected-active` only when the database has no active release.

For subsequent data changes:

```sh
npm run recognition:export -- --release-id BASE_UUID --output recognition.json
# Edit recognition.json and increment its revision.
npm run recognition:stage -- --release-id BASE_UUID --expected-active ACTIVE_UUID --rules recognition.json
```

Then use the existing `release:evaluate`, reviewed-dataset, export, and `release:promote` workflow for the returned candidate UUID. Evaluation must match its exact artifact, corpus, and runtime identities. Rollback selects the previous immutable release and its matching runtime.

For example, adding `purge` to the alternatives in `cart-clear-language.clear.value.1` makes “purge my cart” recognizable after publication, without changing TypeScript. Negation and confirmation checks still apply. Changes to intent groups or `requestPrefixes` use the existing full-dictionary draft/revise flow.

## Storage and isolation

`release.dictionaries.artifact.recognitionRules` is authoritative. Migration 033 adds `release.recognition_rules` as an immutable per-release SQL projection for inspection. Inserts must match the parent artifact; updates and deletes are rejected. Staging, freezing, vocabulary imports, and baseline imports preserve the exact recognition snapshot transactionally.

Each compiled release owns its recognition context, patterns, and derived caches. Concurrent requests and nested parsing cannot borrow another release's words. Public APIs receiving a dictionary bind that dictionary's rule context. Low-level parsing helpers require an explicit `withRecognitionRules` context; offline tools explicitly select their authoring inputs.

## Verification

The migration includes tests for data-only phrase changes, negation and confirmation preservation, cross-release isolation, malformed/missing snapshots, immutable SQL projections, database round trips, and the absence of inline spoken patterns/command lists in migrated recognition modules. Existing tests explicitly upgrade their legacy fixtures; production loaders have no such compatibility fallback.

The implementation evidence is in `output/db-driven-language-20261010/`. The archived benchmark retains all 136,368 reviewed cases and their existing expectations, including knowledge pack revision 10 and the conditional return-policy tail guard. This is a regression gate, not a claim about real-world language accuracy.

Initial implementation verification passed: 790 tests with no failures or skips, TypeScript checking, the comparison seed contract, and all 136,368 archived cases with zero intent/status/entity or wire-schema failures. `verification.json` and `archived-benchmark.json` record those exact runtime, dictionary, and corpus identities. Database checks used a disposable PostgreSQL instance, which was removed afterward. No production release was activated during that validation.

## EC2 activation, 2026-10-10

The subsequent authorized activation published release `0cd45170-7a58-423c-8109-03b677edffec` to the shared production channel and all four stores (grocery, jewelry, electronics, pharmacy). It upgrades the previous revision-5 knowledge release to the reviewed revision-10 dictionary with recognition revision 1 and all 1,273 SQL recognition rows. Dictionary fields outside knowledge/recognition were compared with the live base and preserved.

The active runtime is `6b29b7ccc9bafb5bd250239e1e94bb50274cc1d17d2463768d640583a87c4f91`; its dictionary fingerprint is `1db6ecd892c6f0e1c9b26f63ff2b1adc292c1444fd029a9cee29479311843472`. Evidence is under `output/db-driven-language-20261010/activation/`.

The first promotion attempt exposed missing recognition context in the publication governance checks and stopped before changing the active channel. Promotion/bootstrap now bind their candidate context explicitly. The corrected runtime passed 792 tests, TypeScript checking, a fresh complete 136,368-case replay, and cold-process bootstrap/promotion/rollback in a disposable database. The combined Python consumer passed 54 exclusion tests and matches all 254 reviewed application source hashes. Assistant schema and feature flags were left unchanged.

All eight engine/assistant containers became healthy. Each store passed 12 live HTTP interpretation and Python-contract checks plus two invalid-request rejection checks; no commerce writes were executed by these checks. The previous release `80882336-f1a0-4cdf-bac3-1eebaccc58ea`, exact rollback image tags, and private EC2 backup `/var/backups/rocento/db-recognition-20261010-v2` are retained. Rollback must restore that release with its matching images and consumer pins together.

Independent verification confirmed the release identities, image and Python source hashes, readiness, and 12 additional interpretation/consumer checks across the four stores. All four public storefront/catalog endpoints and eight public assistant streams completed successfully. Fresh catalog reads verified the names, prices, currencies, and stock of all 15 distinct recommended products.

Those public checks also exposed search-quality limitations: “Red Grapes” and “Sapphire Silver Ring — US Size 6” ask for clarification, “Apple iPhone 14 — 128 GB” includes nearby models, and the exact Estée Lauder Advanced Night Repair product name misses an available item. These are not counted as semantic passes: four general requests were satisfactory, one exact-name answer was partial, and three exact-name answers were unsatisfactory. The retained previous Node image produces identical resolver payloads for all four exact-name prompts, except timing. Paired replays of the retained old and active Python images, isolated without network/DB/model access and using the same captured catalog responses, also returned identical answer text and products for all four prompts. The active replay matched the public responses. These observed limitations therefore reproduce on the previous release; no regression was observed in the paired checks. The new release remains active. Evidence is in the activation `verification.json` and `output/enterprise-knowledge-production-verification-20261010/exact-name-python-baseline.json`.
