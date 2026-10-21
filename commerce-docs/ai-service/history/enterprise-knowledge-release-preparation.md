# Enterprise knowledge release preparation

> Historical record: identities, commands and results apply to the recorded candidate only.
> For current operations, use the [language release lifecycle](../language-release-upgrade.md)
> and [shared database runbook](../shared-database-operations.md). See the [history index](README.md).

Date: 2026-10-10 (Africa/Cairo)

Status: **The two named release blockers and two typed-context gaps are fixed. Publication remains blocked by the exact archived-corpus gate. Production is still revision 5.**

This report covers English vocabulary revision 9 across grocery, electronics, jewelry and pharmacy. It does not complete the enterprise vocabulary volume targets, enable Phase 3 product-evidence claims, or certify all historical shopper answers.

## Completed fixes

1. Keep deterministic routing independent of the resolution engine. Application entry points apply the existing diagnostics wrapper, preserving timing/source tracing without crossing the architecture boundary. The architecture checker is unchanged.
2. Preserve the frozen public v1 contract snapshot and explicitly check only the reviewed clarification/tracking additions. The already generated operator tracking-report limit is 96 events, previously 32; Python and frontend validators agree. Strict older report clients require the updated client. Unrelated contract changes still fail the guard.
3. Honor a published concept's `explicit_relationship_only` scope before selecting legacy `catalogPurpose`. Macro photography and hand sewing now produce `shoppingContext.relations` with `intended_use`; the camera request preserves strict `< 500 USD`. Existing merchant purposes and gifts retain their established paths. The knowledge pack was not edited.
4. Independently verify product identity for typed shopping requests without an authoritative merchant category/classification. The live catalog validation exposed bread returned for sewing supplies. The corrected admission path rejects that unrelated fallback result while retaining valid catalog matches.

## Verified candidate

| Item | Value |
| --- | --- |
| Candidate release UUID | `c4eba5dd-f7bc-407c-90d8-956280fe20d6` |
| Exact production base UUID | `80882336-f1a0-4cdf-bac3-1eebaccc58ea` |
| Knowledge revision | 9, inactive |
| Concepts / canonical and alias forms | 3,516 / 5,580 |
| Governed rules | 88, unchanged |
| Candidate fingerprint | `234d1cb26252bd7631223ad15a1ea0135f076d2cb367a304e9d8be087e78194c` |
| Candidate runtime | `91d58fcdbe541e0c87372e91243983429f7faf94885d039728b31bd30c26cb16` |
| Production runtime | `c7f3c2f3b25adcab267acf2d2e208ee2c68424affcbde53f8465d680a36c0fad` |
| Unchanged archived corpus | 136,368 cases |
| Corpus SHA-256 | `fe898fcdafd7c189d5226079558071348ecb8b941f1c28090b37c92df5dbaf74` |

The production-based candidate was staged and exported in a disposable database. The earlier local candidate remains a separate immutable record. Neither the main local active release nor the production active release was changed. Build contexts, candidate and rollback bundles are retained under [the evidence directory](../../platform/evidence/README.md#evidence-03508acd2a9b22a4) (`output/enterprise-knowledge-release-prep-20261010`).

## Validation results

| Check | Result |
| --- | --- |
| Complete Node suite with real PostgreSQL fixtures | 754 passed, 0 failures, 0 skips |
| Complete Python suite with PostgreSQL and real local language HTTP | 4,722 passed, 1 optional paid-provider test skipped |
| Architecture / generated capabilities / TypeScript | Passed; 181 route exposures unchanged |
| Deployment guards | 151 passed plus 770 subtests |
| Real shared-database isolation | 9 passed plus 4 subtests |
| Four disposable language tenant roles | Same identity, isolated sessions, denied staging access; inactive-candidate startup rejected |
| Original 4,000 conversations / 4,675 turns | Zero regressions and zero gains against the prior expansion; historical scores unchanged |
| Previously authored vocabulary examples | 22/22 pass, closing the two gaps |
| Candidate answers using live catalog reads | 16/16 pass across four demos, 15 distinct catalog reads, zero model calls |
| Publishable Node/Python images | Built successfully; non-root, read-only, network-disabled checks pass |
| Exact archived-corpus gate | **2,253 / 136,368 failures; zero wire failures** |
| Failed-evaluation promotion guard | Rejected promotion of the exact candidate; baseline unchanged |

The paid-provider skip requires an explicit isolated provider configuration and is outside this vocabulary-only, model-disabled validation. All database-dependent checks were enabled in the final Python run. Runtime/test/contract source hashes were stable during that run.

The live catalog check ran the candidate Node-to-Python shopping flow against captured, bounded, read-only production catalog-tool responses. It checked real product matches in every demo, exact catalog prices, strict budgets, recipients, budget follow-ups and refusal to invent compatibility. These are exposed development cases, not independent held-out accuracy or a candidate deployment to production. Domain evidence remained disabled.

Local sequential parser p95 was 9.955 ms, versus Phase 0's approximately 8.64 ms (about +15.2%, below the prospective 20% investigation threshold). Peak harness RSS was 485,296 KiB. Concurrent validation work was running; this remains an informational local measurement, not a production capacity or latency commitment.

## Remaining publication blockers

The exact gate was run without changing its rubric or labels. A separate complete diagnostic reproduced all 2,253 failures and compared every failed case against the **exact frozen production runtime and artifact**. Every one also fails there. Thus none is a newly introduced archived-expectation regression. That fact does not make a failing exact gate pass.

The archive contains both real interpretation defects and questionable/generated expectations. For example, an order list alone cannot identify which order to repeat, whereas a polite “if possible” should not automatically become a hard execution condition. Do not resolve these disagreements by copying actual responses into expected labels.

Largest failing template families:

| Family | Failed cases | Required review |
| --- | ---: | --- |
| Conditional feasibility | 479 | Distinguish polite feasibility wording from real conditions; retain action-admission protections |
| Request structure, all three splits | 380 | Review missing identity, quantity and selection requirements against the actual context |
| Metalinguistic commands | 143 | Distinguish discussion/pretending from a requested action; inappropriate joke routing is visible |
| Scoped negation | 143 | Preserve negation and settle the UNKNOWN/clarification contract without enabling actions |
| Other families | 1,108 | Review specific semantic routing, references, ambiguous vocabulary and two product-text mismatches |

These groups are diagnostic leads, not 2,253 independently adjudicated corrections. The [complete failure records](../../platform/evidence/README.md#evidence-f380b288bacf9b08) (`output/enterprise-knowledge-release-prep-20261010/archived-diagnostics/all-failures.jsonl`) retain corpus index, source, context, expectations, candidate output and production-baseline output.

The 15 Phase 0 replacement/arrival requests also remain semantic misroutes. Actual local `/v1/chat` admission was tested for all 15: each clarified, with zero commerce calls and zero model calls. The existing clarification asks order-related questions rather than resolving the delivery question. A proper repair needs a governed delivery-question rule, a typed purpose slot, retained product/date/context and a new immutable pack revision; suppressing the order label alone is insufficient. Original scores remain unchanged.

Next work is to adjudicate these families, fix genuine runtime defects, version any justified benchmark corrections with explicit rationale and independent review, then rerun the unchanged exact gate on the new frozen candidate. The 16 reserved Phase 0 benchmark cases remain unexecuted. Full candidate promotion/rollback rehearsal must follow a passing exact evaluation.

## Rollback preparation and publication sequence

Private backups were created on the production host at:

`/var/backups/rocento/enterprise-knowledge-prepublish-20261010.Y4C2AzBz`

The directory contains custom-format dumps of `assistant` and `commerce_language`, role/configuration recovery material, the exact current Node/Python image archive, original compiled artifact/bundle and checksums. Directory permissions are 0700; backup files are 0600. Dump table-of-contents checks passed. This is not a completed full database restore drill.

Original image identities are retained in [production-images.txt](../../platform/evidence/README.md#evidence-af946b86d7aa9eb3) (`output/enterprise-knowledge-release-prep-20261010/production-images.txt`). The image archive is approximately 124 MB; the language dump is approximately 75.6 MB. Secrets remain in the private server backup and were not included in the report or build contexts.

Candidate and old-runtime rollback bundles were independently decoded and identity-checked. Existing release-lifecycle tests cover guarded promotion/rollback. **This candidate was never promoted, so a successful candidate promotion/rollback rehearsal is not claimed.** The disposable database proved that its measured failed evaluation cannot activate it.

After the remaining gates pass, follow [the language release workflow](../language-release-upgrade.md) and [shared database operations](../shared-database-operations.md):

1. Recheck all four live identities and the exact base UUID. Refresh backups immediately before publication if traffic has continued.
2. Freeze matching Node/Python images, bundle, corpus, runtime hash and evaluation. Rehearse the exact candidate's promotion, all four runtime startups, and rollback in isolation.
3. Apply additive migrations using the shared operator and reapply tenant-role policies. Import/evaluate the candidate using its matching runtime. Do not restore retired per-demo AI databases or use ordinary authoring exports as an activation shortcut.
4. Coordinate the shared release and all four consumers in one controlled publication window. Promote only with an exact passing evaluation; pin Python to the matching language runtime. Keep domain evidence disabled until its separate facts/review gates pass.
5. Verify readiness, identities and the bounded answer sample across all four demos before declaring publication successful.
6. If rollback is needed, restore the previous release pointer with the guarded lifecycle operation and restore **both** matching old images/configuration. Use the preserved runtime hash and bundle. Keep additive schemas. Database dump restoration is disaster recovery, not the normal rollback path after new customer writes.

No production activation command was run. The default checkout's older compiled artifact was not overwritten; a normal deploy from it would not publish this prepared candidate.

## Evidence and reproduction

- [Complete source/artifact verification](../../platform/evidence/README.md#evidence-62184cb9447d6962) (`output/enterprise-knowledge-release-prep-20261010/verification.json`)
- [Python and deployment results](../../platform/evidence/README.md#evidence-41fb3ecd4d683dfa) (`output/enterprise-knowledge-release-prep-20261010/python-deployment-validation.json`)
- [All-demo catalog answer report](../../platform/evidence/README.md#evidence-a0adec6795134195) (`output/enterprise-knowledge-release-prep-20261010/live-catalog-verified/demo-validation.json`)
- [Exact failed archive gate](../../platform/evidence/README.md#evidence-49b08dd3d467f7ed) (`output/enterprise-knowledge-release-prep-20261010/initial-archived-corpus.json`)
- [Archive diagnostic groups](../../platform/evidence/README.md#evidence-9d73b5c62b0cb05e) (`output/enterprise-knowledge-release-prep-20261010/archived-diagnostics/summary.json`)
- [Disposable database and guarded release evidence](../../platform/evidence/README.md#evidence-97b85926d7c9f37b) (`output/enterprise-knowledge-release-prep-20261010/release-rehearsal.json`)
- [Private backup inventory](../../platform/evidence/README.md#evidence-82b9ac5005887f73) (`output/enterprise-knowledge-release-prep-20261010/rollback-backup.json`)

From the repository root, verify this saved run without production writes:

```sh
node scripts/knowledge-baseline/verify-release-preparation.mjs
```

Use a new output directory and new immutable release identity when runtime, pack or reviewed corpus content changes. Preserve this failed-gate evidence and the original historical reports.
