# Expansion batch 1 repairs — 2026-10-10

> Historical record: identities, commands and results apply to the recorded candidate only.
> For current operations, use the [language release lifecycle](../language-release-upgrade.md)
> and [shared database runbook](../shared-database-operations.md). See the [history index](README.md).

Status: requested local repairs verified on an isolated candidate snapshot. Nothing in this follow-up has been deployed or imported into production.

## Evidence-source repair

All eight failed courtesy requests were parsed after their wrappers were removed, but Python verified their relationship offsets against the original customer message. The engine now rebases typed relationship, sentence-role and unresolved-phrase spans when the interpreted source occurs uniquely and contiguously in the original message. It retains original customer text as the evidence source. Noncontiguous rewrites retain their existing behavior; arbitrary rewritten text is not trusted by Python.

The unchanged batch-1 Python admission checks pass **19/19**. Budgets remain mandatory, unpublished forged concepts are rejected, and activities do not establish product suitability. Three permanent Node source-coordinate tests cover courteous and whitespace prefixes.

## Parser latency

CPU profiling showed repeated recognition-regex allocation and normalization, especially in action-frame scans. Each parse now tokenizes its dictionary phrases once and sorts action phrases once per frame, rather than repeating those operations at every customer token. No customer-text cache or cross-release cache was introduced.

Final repeat against the frozen parser snapshot: six alternating fresh-process runs per variant, 440 timed calls per process after 66 warmup calls. The first paired run remains preserved separately:

| Median metric | Published runtime/data | Unfixed revision 11 | Fixed revision 11 |
|---|---:|---:|---:|
| p50 | 12.47 ms | 12.45 ms | 8.14 ms |
| p95 | 14.05 ms | 17.31 ms | 13.68 ms |
| Compile | 684.53 ms | 703.33 ms | 708.00 ms |
| Maximum RSS | 279,760 KiB | 281,104 KiB | 283,440 KiB |

Fixed p95 is 20.97% below the unfixed candidate and 2.66% below the published baseline. Compilation and RSS change by +3.43% and +1.32% against baseline. All thresholds pass. These are local diagnostics on the frozen 22-prompt workload, not a production latency guarantee; unrelated Python integration checks were also running, so production load testing remains a separate gate. The original +21.97% measurement is preserved.

## Tenant catalog names

Bounded source recovery retains accented spelling and punctuation that normalized product text had lost. The existing scoped catalog search now probes that spelling before accepting descriptive decomposition. One exact merchant name/SKU restricts retrieval to that product ID; duplicate exact names do not choose an arbitrary item. Name-only color/material/size words are removed from inferred filters only after identity is verified. Outside constraints, price bounds, exclusions and unknown product facts still apply.

A numeric-unit suffix is accepted only when both the unit and matching numeric product attribute are supplied by the current merchant catalog. Pro/Plus/model suffixes never qualify as pack-size suffixes. The identity probe also carries the customer's price bounds.

Local code using read-only production catalog responses successfully returns:

- Grocery: **Red Grapes 500g**, $2.75. The earlier fixture's claim that “Red Grapes” was the full exact name was imprecise; the original frozen fixture is retained and this correction is explicit.
- Electronics: **Apple iPhone 14 — 128 GB**, $599, without adjacent models.
- Jewelry: **Sapphire Silver Ring — US Size 6**, $329, without a silver-color/material question.
- Pharmacy: **Estée Lauder Advanced Night Repair Synchronized Multi-Recovery Complex**, $85, with original accented spelling.

No assistant chats, cart writes, database mutations or model fallback occurred. Twenty-seven adversarial fixture checks pass. The reserved camera exclusion case remains conservatively clarified when its complete request cannot be admitted; it does not return the excluded model. This is not a claim that all model dialogue is solved.

## Verification and remaining release work

- Python admission: 19/19.
- Exact archive: 136,368/136,368; zero wire failures.
- Node suite: 750 passed, 12 optional/database-dependent skips, zero failures.
- Python type checking: 257 modules pass.
- Four real-catalog checks: 4/4 locally, no model calls.
- Broad isolated Python run: 4,788 passed, 28 skipped, five findings. All five were repaired or resolved as fixture/artifact issues; the affected suites then pass **77/77**. A separate combined admission/catalog/shopping run passes **216/216**. These are reconciled runs, not a claim of one clean full-suite invocation after every final edit.

The first broad workspace run used an old `data/compiled.json` without required recognition rules and sandbox restrictions prevented some local integration servers. A separate validation copy uses the candidate artifact and localhost permissions; shared workspace artifacts were not replaced. Original failed logs are preserved. The SSE fixture also generated a different category UUID for the same product on each call; it now uses a stable category and expects the additional bounded identity read.

Evidence directory: `output/enterprise-knowledge-expansion-fixes-20261010/`. The runtime is `bb3c9e142a58082cc53b53cb1b523575518375a392d81bd3c9a2a4e6447851ca`; dictionary fingerprint remains `0b44d2977d88b08ec64b25706d2c9260306c5978192f2e6c27b39c71abeb06e1` (revision 11). The 16 aliases and three rules from batch 1 are unchanged. This turn adds no database migrations or knowledge rows.

Concurrent work: “Trace fruit search filtering” and “Improve rengine tracing” changed shared parser/grounding/tracing files during verification. The archive and full-suite evidence applies to the frozen `validation/ai-service` snapshot and runtime `bb3c9e14…`, not every later shared-workspace edit. Their changes were preserved. The final shared-workspace admission/catalog checks pass **46/46** and the captured-catalog replay still passes **4/4**. Shared runtime observed afterward: `288c6748…`; it is not the runtime certified by this archive.

Before publication: freeze and validate the combined workspace, then finish release packaging, immutable candidate staging/evaluation, matching Node/Python artifact checks and promotion/rollback verification for this new runtime. Production still uses revision 10 and the previously published runtime. Broader authoring tools, vocabulary growth and GB-scale ingestion remain on the main plan.
