# Phase 3 — Conditional requirements and product evidence

> Historical record: identities, commands and results apply to the recorded candidate only.
> For current operations, use the [language release lifecycle](../language-release-upgrade.md)
> and [shared database runbook](../shared-database-operations.md). See the [history index](README.md).

Date: 2026-10-10

Status: initial electronics implementation is complete locally. Four profiles are staged as inactive domain release revision 1 in a dedicated local `assistant` database. The language candidate remains revision 8. Production was not contacted or changed. Real catalog attestations, independent review and the production release gates remain open.

## Behavior

For **“I need a laptop for video editing and my limit is $75”**, the language engine retains laptop, intended use and the budget. With the new `domain_evidence` feature enabled and a reviewed release bound to the tenant, shopping asks which reviewed software/workload applies before searching. The server saves this question and the original constraints; a reply can select only an issued choice. Browser-supplied choices cannot change the allowlist, and stale replies are rejected.

After confirmation, the existing scoped catalog tools search within the customer's product, currency and price constraints. Each candidate is compared with the selected hardware profile and its exact-product attestations. Results are:

- **Verified against this hardware profile:** every required fact is present, current, consistent and supported by an attestation for this tenant and exact product identity.
- **Unmet:** complete evidence establishes that a requirement is not met.
- **Unknown:** facts are missing, malformed, conflicting, expired, withdrawn, inferred, or attached to another tenant/product/model. Known individual failures remain in the operator trace when the overall outcome is unknown.

The output describes the limited hardware check and links the requirement sources. Internal operator diagnostics record the release fingerprint, profile/product IDs, per-requirement source IDs and product-evidence IDs. Those details use the existing opt-in diagnostics/tracking mechanism; historical traces cannot be reconstructed when capture was disabled. Shopper-facing copy does not expose database hashes or IDs.

Budget, currency and other hard requirements are independently checked after retrieval. This path never uses the ordinary over-budget alternative list. Empty results mean no qualifying candidates were found among the results checked, not that a universal market claim was established. Catalog titles cannot prove product category: a “laptop sleeve” is not admitted as a laptop.

## Initial reviewed data

| Profile ID | Explicit scope | Primary source |
| --- | --- | --- |
| `shotcut-windows11-sd` | Shotcut, Windows 11 64-bit, SD editing, CPU processing | [Shotcut FAQ](https://shotcut.org/FAQ/) |
| `shotcut-windows11-hd` | Shotcut, Windows 11 64-bit, HD editing, CPU processing | [Shotcut FAQ](https://shotcut.org/FAQ/) |
| `shotcut-windows11-4k` | Shotcut, Windows 11 64-bit, 4K editing, CPU processing | [Shotcut FAQ](https://shotcut.org/FAQ/) |
| `zoom-windows11-basic-video` | Zoom desktop, Windows 11 64-bit, basic video classes, included camera/microphone/speakers | [Zoom desktop requirements](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060748) |

These profiles encode the documented hardware requirements with typed equality, minimum and allowed-value comparisons. They do not certify editing speed, codec support, project storage capacity, advanced effects, broadband quality, school software, managed-device permissions or every software version. Unsupported software, other operating systems, gaming and combinations of uses still require clarification and additional reviewed profiles. Confirmation is explicit even when there is only one available profile; the engine never chooses the customer's software automatically.

Each source has a stable ID, HTTPS URL, review method, reviewer, review timestamp, recheck date and hash of its external review note. Notes are short paraphrases stored under `output/enterprise-knowledge-phase3-20261010/sources/`, outside the runtime artifact; they are not full archived publisher documents. Sources were AI-reviewed on October 10, with recheck due November 9, 2026, or sooner if requirements change. This is not independent human approval.

The existing vocabulary and grammar remain in the language release. This phase adds domain knowledge and evidence execution; it does not add vocabulary counts or claim to resolve the historical 4,000 bad-answer grades.

## Database records

The existing `assistant.knowledge_sources` / `knowledge_chunks` store tenant RAG documents and vectors. They do not provide deterministic conditional requirements or exact-model fact attestations. Migration `011_domain_evidence.sql` adds these structured records in the existing `assistant` database:

| Table | Responsibility |
| --- | --- |
| `assistant.domain_releases` | Immutable validated manifest and content fingerprint |
| `assistant.domain_sources` | Immutable source metadata projections for a release |
| `assistant.domain_profiles` | Immutable conditional profile projections for a release |
| `assistant.domain_bindings` | Tenant's explicitly activated release; absent for this candidate |
| `assistant.product_evidence` | Immutable tenant/product fact attestations with units, exact identity hash, source, review and expiry |
| `assistant.product_evidence_revocations` | Append-only withdrawals of individual attestations |
| `assistant.domain_release_revocations` | Append-only withdrawals of requirement releases |

Shared sources contain no tenant product data. Bindings, product evidence and its revocations have forced RLS tied to the authenticated tenant login and request context. Changing the request tenant setting cannot reveal another tenant. Runtime roles have read-only access; knowledge writers can append their tenant's facts/revocations but cannot publish or activate shared profiles. Release staging and tenant binding changes are operator-owned. New releases replace requirements; immutability prevents editing historical releases in place.

Attestations bind to product ID, SKU, name, category identity and product type. Price and stock are excluded from this hash and read from current commerce tools. Required values must also match the current catalog exactly, including units and authoritative provenance. No fact is taken from a product name or inferred attribute. An explicit revocation removes an incorrect attestation from consideration; conflicting unrevoked current attestations produce unknown.

## Local staging and catalog findings

- Database: `assistant`, dedicated container `commerce-knowledge-phase3-db`, `127.0.0.1:57433`. This is an isolated local staging instance, not a replacement or merge of the existing demo databases.
- Domain revision: **1**; fingerprint: `ee6aa1c4103004435e5ca7f2321f530ac890e5776a74a9eefe3d1cfe407e33bd`.
- Four profiles, two sources, **zero active bindings and zero product attestations**. Synthetic test facts were confined to tests/disposable databases.
- A read-only local electronics query found two sampled demo laptops at $999 and $1,199. Their attributes do not provide an exact manufacturer model, CPU/OS/graphics facts or current source attestations. They also use a text `memory` field rather than the typed `ram` field in these initial profiles. No source-backed product facts were invented to fill these gaps.

The bounded local catalog query is recorded in `output/enterprise-knowledge-phase3-20261010/local-catalog-review.json`. It is not a live production audit or an exhaustive alias/category search. Real activation requires reviewed tenant schema mappings where attribute codes/units differ, exact product-source attestations, and an answer-quality check against the current catalog.

Useful DBeaver reads:

```sql
SELECT fingerprint, revision, created_at FROM assistant.domain_releases;
SELECT id, metadata FROM assistant.domain_profiles ORDER BY id;
SELECT id, metadata FROM assistant.domain_sources ORDER BY id;
SELECT tenant_id, release_fingerprint FROM assistant.domain_bindings;
SELECT tenant_id, product_id, id, metadata FROM assistant.product_evidence;
```

Tenant-role queries require the matching `assistant.tenant` context. Operator reads follow the existing database access policy; no runtime credential has been elevated.

## Validation

- **335 final targeted Python tests passed**, zero failures or skips. This includes Phase 2 admission regressions, shopping/context/catalog/evidence checks, server continuations, HTTP/SSE, runtime integration and generated capability consistency.
- **34 Phase 3 tests** within that run cover the 26 pre-implementation scenarios plus contract, source-integrity, malformed-data and integration checks. Expectations were AI-authored before implementation and are synthetic; they are not independent human labels or a live recommendation benchmark.
- **One real PostgreSQL integration test passed**, covering all forward migrations, repeated shared upgrades, staging without activation, immutable records, wrong-tenant access/write rejection, writer/runtime grants, activation/rollback and both fact/release revocation. It runs in a disposable database within the dedicated local container.
- **43 deployment tests passed.** Both fresh assistant initialization and existing/shared database upgrade commands include migration 011. Shared RLS reapplication preserves global requirement tables and scopes tenant tables.
- **Mypy passed all 255 application modules**; changed Phase 3 files pass Ruff. A pre-existing budget-rule loader annotation was made explicit without changing its runtime behavior.
- Assessment-only benchmark: 1,000 synthetic checks, p95 **0.193 ms**. This excludes parsing, catalog HTTP, database latency and model calls; it is not end-to-end production latency.
- The broad Python run recorded **4,666 passed, 3 failed, 28 skipped**. Two failures were resolved and retested in the final targeted run: refreshed generated capability hashes and corrected the SSE test's provider setup. The remaining failure is the existing public tracking-contract snapshot mismatch described below. The original broad-run output is preserved.

Locked expectation SHA-256: `ab99f9a475ceff2fd9de0cf8666aae20d365dfb766378f104dd7a5f42d8c4e97`.

The original 4,000-case CSV and prior frozen reports are preserved. Its live grades have not been changed, and no new bulk live test ran. This phase's Python/domain behavior is measured by its separate checks, not by regrading old parser output. The 16 reserved Phase 0 cases remain unexecuted.

Evidence directory: `output/enterprise-knowledge-phase3-20261010/`. Reproducible checks and current/frozen source integrity are recorded by `scripts/knowledge-baseline/verify-phase3.py` and its `verification.json` output.

## Operator workflow and remaining gates

Validate or stage the artifact with `scripts/domain-evidence.py`. Set `DOMAIN_EVIDENCE_DATABASE_URL` through the operator's normal secret mechanism; do not put credentials in commands or reports.

```sh
ai-service/.venv/bin/python scripts/domain-evidence.py validate \
  --pack ai-service/data/domain-evidence/electronics-v1.json \
  --sources-root output/enterprise-knowledge-phase3-20261010

# Same arguments with "stage" import the release; they do not activate it.
# "attest --fact <reviewed-exact-product.json>" validates/imports one fact.
# "inspect" reports stored releases and their binding counts.
```

The initial runtime is opt-in through `AI_FEATURE_FLAGS=domain_evidence` alongside the existing flags. Enabling it requires the assistant database; it must also have a valid tenant binding, current sources and product attestations. Missing/unavailable evidence fails closed to unknown, without a catalog-tag fallback. Rebinding/revoking a release during a catalog search is checked again before returning an assessment. The feature was **not enabled** in any demo by this work.

`deploy.sh` can deliver the runtime/schema updates through the existing deployment path, but it does not seed or activate these domain profiles. No general promotion shortcut was added. Production promotion still requires:

1. Independently review the source/profile scope and validate real catalog answers; add reviewed merchant field mappings and exact-model facts. Extend software/workload coverage by measured demand.
2. Resolve the existing repository checks: `test_public_contracts_preserve_v1_with_optional_shopping_clarification_fields` sees tracking schema additions in `backend/openapi.json`; `check-ai-architecture.py` flags the existing diagnostics import in `execution/language/routing.py`. Neither file was changed or its assertion weakened by Phase 3.
3. Complete the prior exact archived-corpus gate and adjudicate the 15 Phase 0 order-route flags. Preserve previous baselines and report limits separately.
4. Promote matching language/Python/domain artifacts under the existing review, all-demo rollout and rollback controls. Only then activate the feature for an explicitly selected tenant and check a bounded live sample.

Other domains retain their existing medical/allergen/compatibility boundaries. This release does not expand grocery, pharmacy or jewelry suitability claims. Large vocabulary counts and million-scenario evaluation remain later coverage work, not a measure of this four-profile foundation.
