# Enterprise knowledge release repair

> Historical record: identities, commands and results apply to the recorded candidate only.
> For current operations, use the [language release lifecycle](../language-release-upgrade.md)
> and [shared database runbook](../shared-database-operations.md). See the [history index](README.md).

Date: 2026-10-10. Status: **final verification passed for the frozen candidate**. The exact archive gate, full Node/Python suites, corrected exclusion workflow, all-demo catalog/HTTP checks, image integrity, promotion/rollback and backup restoration are verified. This preparation did not activate a release; the user subsequently requested activation in the coordinated chat.

This report supersedes the failed revision-9 candidate in [release preparation](enterprise-knowledge-release-preparation.md), while preserving its reports. It certifies only the frozen sources and images identified below. “Locate intent keyword handling” has separately migrated 1,273 recognition definitions into release data and reports 790 passing tests plus the same 136,368-case archive passing, under runtime `8e850728…` and a different dictionary fingerprint. The user has subsequently requested activation in that chat. The two chats have coordinated: this report validates runtime `9f58fcc4…` and the corrected Python image below; a combined activation must use matching regenerated artifacts/images and its own recorded evaluation. Any intervening activation invalidates the old expected-active UUID in this report's publication commands.

## Changes and benchmark review

The parser now handles bounded courtesy wrappers, command negation, dictionary-owned collection reads, incomplete collection writes and context references more consistently. Return-policy conditions such as “if it is not right for me” remain intact. A 4,000-conversation replay exposed 56 regressions in the first repair; the repaired successor retains the conditional text and has zero regressed turns or checks. The initial failed reports remain available.

Python shopping grounding now preserves catalog-verified typed requirements after the source text is masked for later interpretation. Previously, meaning extraction could demote a required material exclusion into an optional preference. The fix retains the requirement in both filters and the meaning frame, checks contradictions, and prevents excluded, unknown or inferred-only products from being returned as alternatives. Intended-use and occasion preferences remain optional. End-to-end tests cover `excluding leather` and `without latex`; these are literal material constraints, not medical-safety claims. All 54 schema/evidence/workflow checks pass, including alternatives, no-valid products, ambiguous fields, fresh/resumed requests and meaning extraction on/off. The complete PostgreSQL/HTTP suite subsequently passed with 4,776 tests and one optional provider skip.

Immutable knowledge revision 10 adds the governed `question.replacement_arrival` rule with eight date/purpose templates and migration `032_delivery_question_knowledge.sql`. All 15 historical replacement-arrival questions now produce `DELIVERY_DATE` with `NEEDS_CONTEXT`, asking for the order/purchase context, destination and availability evidence. They do not create orders or assert an arrival date. The pack contains **3,516 concepts, 5,580 forms and 89 governed rules**; licensed vocabulary provenance is retained.

Benchmark revision 4 retains all **136,368 original cases**, in order, and preserves their texts, splits and provenance. Of the original 2,253 failed cases, 795 have justified expectation/context corrections; 1,458 retain their original expectations for runtime repair. Across the whole archive, 15,543 cases have documented patches, predominantly 13,975 missing authoring-domain contexts. All prior entity assertions remain except two documented literal product-case corrections; discount discovery receives an additional ranking assertion. The generation code applies the same semantic authoring contracts before deduplication.

These corrections come from the original wording, authoring provenance and documented contracts, not the candidate's predictions. The equality rubric is unchanged, and no cases were removed. Review is AI-assisted semantic review, not independent human labeling. [Benchmark patches and review](../../platform/evidence/README.md#evidence-2575f3c866670f46) (`output/enterprise-knowledge-release-repair-20261010/benchmark-v4`) preserve each change and its reason.

## Exact candidate

| Identity | Value |
| --- | --- |
| Release UUID | `694122fc-b5dc-4cf0-b2c6-b5fecd7b75f9` |
| Base UUID | `80882336-f1a0-4cdf-bac3-1eebaccc58ea` |
| Knowledge / dictionary version | 10 / 8 |
| Runtime SHA-256 | `9f58fcc4a7394d61658310f8bcb37fbde3c3427345d876e20c4b19b1fa0a1182` |
| Fingerprint | `6e01b06a8e3cbce4676116d9e33cefd80bdc266e2d4ac5268ac9151b6c19f9a2` |
| Artifact SHA-256 | `1c60aa945090a45000e3f4cdda5c9c8236c4af1f1a31deb5a43ca729ae470b75` |
| Corpus SHA-256 | `f32c3b98693f40e3a9bfc19c7cb55de0496e3a5e865b28faa1cc278798607c0a` |
| Node image ID | `sha256:f606a9d8a446d07c800b723751472b6967bf823fc6f0c7c928b9c1b0c84f8db9` |
| Python image ID | `sha256:7d5d6ded450e8f843996d6108737d5aa756d202e491dcef6d656c24d69233f9d` |

Authoritative evidence: [final frozen run](../../platform/evidence/README.md#evidence-c64cfced20a27c0b) (`output/enterprise-knowledge-release-repair-20261010/final`). Runtime/build manifests bind the source, packaged candidate bundle and images. Superseded Python image/build/catalog evidence is preserved under `final/before-python-exclusion-repair/`; the only runtime differences are the two Python grounding files. The workspace's mutable source is not the validated artifact.

## Validation

| Check | Result and scope |
| --- | --- |
| Exact release gate | **136,368 passed; 0 failed; 0 invalid wire responses.** Real recorded evaluation in a disposable database; unchanged `commerce-language-release-v1` rubric. |
| Node suite | **783 passed, 0 failures/skips**, including real PostgreSQL fixtures and the new conditional-tail guards. Tests use the frozen API; compatibility-only adaptations to concurrently refactored tests retain assertions. |
| Python and deployment | Full suite: **4,776 passed, one optional unconfigured live-provider skip, zero failures** with PostgreSQL/HTTP enabled. Deployment: 163 tests + 777 subtests; shared DB: 9 + 4; mypy: 255 modules. The two legacy expectations are separately versioned; original fixtures and earlier failures are preserved. |
| Original shopper replay | **4,000 conversations / 4,675 turns; 43 improved turns and 0 regressed turns/checks.** 1,309 complete conversations and 1,483 turns pass the minimum-language rubric. Historical live CSV and grades unchanged. |
| Replacement arrival | **15/15 semantic and actual HTTP admission checks pass**, with zero model calls and zero commerce calls. |
| Fresh live catalog | **16/16 checks pass across all four demos** with the corrected Python runtime and 15 fresh read-only catalog responses at 16:39 UTC. Strict budgets, real product identities/prices, follow-ups and uncertainty checked. Zero commerce writes or model calls. |
| Authored vocabulary examples | **22/22 pass.** Development examples, not held-out customer accuracy. |
| Images | Both arm64 images pass non-root/read-only/network-disabled checks. All 254 Python-service source files and compiled dictionary bytes inside the successor image exactly match the verified build. Prior image evidence is retained. |
| Promotion and rollback | All four tenant identities, session isolation, restricted-table access, candidate startup, old-runtime rollback and stale-candidate rejection pass; disposable resources removed. |
| Full backup restore | Both captured production database dumps restored in an isolated container on the same production host: **67 tables, 304 constraints**, zero invalid indexes or unvalidated constraints. Container/volume removed. No dump payload exported. |

The frozen gate tests a corrected synthetic development archive. It does not establish 100% real shopper accuracy. The original shopper replay still has 3,192 turns that fail its minimum-language checks; the 2,253 archive failures were a different dataset and gate.

## Performance and operating limits

The first final sample measured parser p95 11.211 ms. A subsequent adjacent baseline/candidate comparison measured approximately 8.806 ms / 10.577 ms (+20.11%) and peak harness RSS +9.21%. Profiling investigated the Phase 0 20% threshold: the new structural-frame scans beneath `countIntents` and `suppressRequestPrefixes` account for approximately 4.52 seconds of the 5.15 seconds of additional sampled runtime, with repeated action-phrase normalization/sorting dominant. Reusing a structural parse and precompiling action tokens are follow-up optimizations. No performance-only change was made to the frozen runtime. Both original and paired samples are retained in the [performance investigation](../../platform/evidence/README.md#evidence-d07b60b01e2dc621) (`output/enterprise-knowledge-release-repair-20261010/final/performance-comparison.md`); the measured slowdown remains an explicit release tradeoff. Load/compile time in the pair increased from 75 ms to 433 ms, separate from per-request latency.

This is local sequential parser timing on an Apple M4 Pro with Node 25.9.0. Production uses Node 22.18.0. These runs do not measure HTTP response latency, simultaneous customers, catalog retrieval or production capacity.

## Publication and rollback

Use the [exact publication and rollback runbook](enterprise-knowledge-release-publication.md) with the validated release identities, after coordinating the separately requested activation. It includes a fresh backup, frozen language-database operator inputs, exact image transfer, candidate import, a new evaluation recorded in production, coordinated four-store promotion, identity/readiness checks and rollback to the retained old images and UUID. The existing `deploy.sh` does **not** select these prepared output artifacts automatically; `--sync-language-db` would export the still-active local revision 5.

The saved production readiness check after rehearsal found all four demos healthy on the original revision 5, UUID `80882336-f1a0-4cdf-bac3-1eebaccc58ea`, runtime `c7f3c2f3b25adcab267acf2d2e208ee2c68424affcbde53f8465d680a36c0fad`. This preparation made no main-local active release changes. The other chat's later activation request is a separate operation; check its result before using these recorded baseline identities. The backup restore was isolated; routine rollback should preserve customer writes by switching releases/images, not by restoring old SQL dumps.

An initial attempt to export production backups for a local restore was rejected by automatic approval review. The completed same-host isolated restore avoided exporting database contents and satisfied the recovery rehearsal.

## Remaining enterprise plan

This closes the targeted parser/archive and Python grounding repair for the frozen candidate. It does not complete the larger plan: Phase 2 targets of 10,000–25,000 concepts and 100,000–250,000 forms, independently reviewed knowledge, real product attestations, wider domain profiles, selective loading and million-scenario evaluation remain open. The current pack is measured in MB, not GB. `domain_evidence` remains disabled until real catalog evidence and review gates pass. Arabic and a new bulk live test are outside this release.

Reproduction and integrity commands, run from the repository root:

```sh
node scripts/knowledge-baseline/verify-release-repair.mjs
```

The [final verifier report](../../platform/evidence/README.md#evidence-8c5922b91d7b7efd) (`output/enterprise-knowledge-release-repair-20261010/final/verification.json`) passed at 16:47 UTC, binding 35 evidence files and checking 80 preserved historical files. It checks the immutable runtime/build hashes, benchmark retention and patches, exact evaluation, all-demo evidence, test outcomes, original historical files and rollback evidence. It deliberately does not certify the concurrently edited checkout.


## Coordinated production overlay handoff

A subsequent read-only inventory of the deployed grocery Python container identified the exact file-level delta to the validated service: **14 replacements and 5 added modules**, with no removed Python modules. All 254 service Python source hashes match the frozen target after applying this delta. The dependency lock and all six non-Python runtime assets are unchanged; two existing `.DS_Store` files are non-runtime metadata. The [handoff manifest](../../platform/evidence/README.md#evidence-ff0e25e4f44a76b5) (`output/enterprise-knowledge-release-repair-20261010/final/python-production-overlay-handoff.json`) lists absolute frozen source paths and before/after hashes. The activation chat received this manifest. Its combined dictionary must replace the frozen dictionary with matching pins; `domain_evidence` remains disabled. This comparison performed no deployment or data changes.

The [assistant migration decision](../../platform/evidence/README.md#evidence-231c55d4753a7f08) (`output/enterprise-knowledge-release-repair-20261010/final/assistant-migration-decision.json`) records a fresh read-only production check at 17:42 UTC: all required effects of migrations 004–010 and forced tenant policies are already present, and all four demos keep `domain_evidence` disabled. No new `assistant` migrations are required for this overlay. Skip migration 011 and `conversations-setup.py`; preserve existing flags and policies. This does not waive the combined candidate’s `commerce_language` migrations or exact evaluation. The decision was shared with the activation chat and the publication runbook was corrected.

## Subsequent production publication

The coordinated combined release `0cd45170-7a58-423c-8109-03b677edffec` is now published with corrected runtime `6b29b7cc…` and matching dictionary `1db6ecd8…`. All four demos passed operational verification; the [production report](enterprise-knowledge-production-verification.md) records the exact identities, live evidence, rollback assets and four separately observed exact-name answer-quality limitations. The earlier frozen evidence in this report remains unchanged and certifies its original candidate only.
