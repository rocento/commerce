# Enterprise language knowledge evidence tools

This folder contains versioned research and release evidence harnesses for the
enterprise language-knowledge work. It is not the routine local-development,
onboarding, or platform-deployment command set. The phase names identify dated
evidence runs; they do not describe the current production release state.

## Directory status

This is the retained historical source location. Keep the flat layout: sibling
imports, recorded paths and source-hash manifests couple these files together.
Do not add new general-purpose evaluation commands here; use
[tools/evaluation](../../tools/evaluation/README.md).

The phase harnesses are not certified runnable against the current checkout.
For example, `verify.mjs` inventories the former `scripts/knowledge-baseline`
location, and several JavaScript harnesses resolve application imports using
the older repository depth. Preserve these historical bytes rather than
silently updating an old evidence run to new source. Reproduction requires its
original checkout, inputs and runtime dependencies; any modernization should
create a separately identified evaluation with new provenance.

## File index

| Group | Files | Status |
| --- | --- | --- |
| Shared evidence utilities | `lib.mjs`, `lib.test.mjs` | Shared utility source; its tests require original phase-0 benchmark artifacts |
| Phase 0 baseline | `snapshot.mjs`, `analyze.mjs`, `benchmark.mjs`, `prepare-benchmark.mjs`, `verify.mjs`, `production-inventory.sql`, `production-runtime.sh` | Frozen baseline workflow; requires its original captured inputs and output directory |
| Phase 1 and 2 | `phase1-snapshot.mjs`, `verify-phase1.mjs`, `phase2-snapshot.mjs`, `verify-phase2.mjs`, `evaluate-phase2-reserved.mjs`, `approve-benchmark.mjs`, `phase2-repair-snapshot.mjs`, `evaluate-phase2-repairs.mjs`, `verify-phase2-repairs.mjs` | Historical evaluation and repair evidence; keep paired with its immutable output artifacts |
| Vocabulary and release preparation | `evaluate-vocabulary-expansion.mjs`, `freeze-vocabulary-expansion.mjs`, `verify-vocabulary-expansion.mjs`, `diagnose-archived-release.mjs`, `diagnose-reviewed-corpus.mjs`, `evaluate-release-preparation.mjs` | Dated candidate preparation and verification harnesses |
| Phase 3 local measurement | `prepare-phase3.py`, `stage-phase3-local.py`, `measure-phase3.py`, `verify-phase3.py`, `check-repair-images.py` | Local phase-specific research checks. `stage-phase3-local.py` loads a dedicated localhost database; it is not a staging-server deployment tool |
| Bounded release-demo validation | `release-demo-order-admission.py`, `release-demo-read-bridge.py`, `release-demo-validation.py` | Historical candidate validation; the read bridge performs fixed, read-only catalog requests on a deployment host |
| Corpus repair preparation | `adjudicate-release-corpus.mjs`, `build-release-repair-contexts.mjs` | Retained corpus-review and context preparation; inspect output paths before use |
| Frozen candidate validation | `validate-release-repair-python.py` | Disposable local database/Node validation for its original frozen candidate; requires its recorded dependencies |

## Handling the evidence

Use the matching report under `commerce-docs/ai-service/history/` and its
recorded output directory before invoking a phase tool. Snapshot and verification
scripts may be create-only, require exact source hashes, or refuse to reuse an
existing output directory. Do not point an old verifier at a newer candidate
and treat it as the same evidence run.

Some retained verifiers require original source hashes. Historical reports and
catalog entries record source paths from their original run; they are historical
records, not an inventory of currently executable tools.

The promotion/rollback rehearsal programs and the verifiers/freezer that depended
on their backup artifacts were retired. Their recorded evidence remains historical
and cannot be regenerated with this checkout. Corpus adjudication and context
preparation source remains available under the historical-layout limitations above.

Production inventory and runtime collectors are read-only and require the
documented operator workflow and production access.

## Verification limits

`node --test commerce-ops/scripts/knowledge-baseline/lib.test.mjs` currently
stops during module loading because its expected historical
`commerce-ops/output/enterprise-knowledge-phase0-20261010/benchmark-candidate.json`
is absent. It also requires `benchmark-approved.json` alongside that file.
Do not generate replacements and treat them as the original evidence. The
documentation checker validates this guide; it does not certify these harnesses
or reproduce their historical results.
