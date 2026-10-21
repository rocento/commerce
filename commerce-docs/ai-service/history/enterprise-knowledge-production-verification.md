# Enterprise knowledge production verification — 2026-10-10

> Historical record: identities, commands and results apply to the recorded candidate only.
> For current operations, use the [language release lifecycle](../language-release-upgrade.md)
> and [shared database runbook](../shared-database-operations.md). See the [history index](README.md).

The combined knowledge and database-recognition release is published across grocery, electronics, jewelry and pharmacy. The promotion bug was fixed by explicitly binding the candidate dictionary's recognition context during promotion and bootstrap governance checks. Publication and rollback were rehearsed in a fresh process. The first failed attempt did not change the active release; the guarded retry completed successfully.

## Published identity

| Item | Value |
| --- | --- |
| Active release | `0cd45170-7a58-423c-8109-03b677edffec` |
| Previous release / rollback target | `80882336-f1a0-4cdf-bac3-1eebaccc58ea` |
| Evaluation | `e0f8b247-1470-4c5d-9767-97b21a9c6fb7` |
| Runtime SHA-256 | `6b29b7ccc9bafb5bd250239e1e94bb50274cc1d17d2463768d640583a87c4f91` |
| Dictionary fingerprint | `1db6ecd892c6f0e1c9b26f63ff2b1adc292c1444fd029a9cee29479311843472` |
| Knowledge / recognition revisions | 10 / 1 |
| Recognition definitions in database | 1,273 |
| Node image | `sha256:692924a0ef30cec36382d50671f36c43d7810f65dbaa51c1864bdbf51b3570ba` |
| Python image | `sha256:1cb229f1ce69bf5e4f0df472724d78d64730b992096461c1e28d59ddea8368b2` |

## Verification

- All 792 Node tests and all 136,368 archived cases pass, with zero response-contract failures. Cold bootstrap, promotion and rollback pass. The combined Python exclusion checks pass all 54 cases.
- The activation chat verified 12 live HTTP-to-Python cases and two rejected invalid requests per demo, plus readiness.
- Independent checks confirm all eight containers are healthy and use the expected images/release. All 254 Python source hashes per store and dependency-lock hashes match the reviewed build. Twelve additional resolver-to-Python contract checks pass.
- All four public storefronts, delivery-area endpoints and catalogs respond successfully. All eight English shopper requests complete with HTTP 200 and no error events.
- Fifteen distinct products returned in response blocks match fresh catalog reads for name, price, currency and stock.
- Existing assistant schema and feature flags are preserved; `domain_evidence` remains off. No new assistant migration was needed.

The initial public-check attempt stopped at the local Python certificate-store configuration. The successful retry used the installed trusted CA bundle with TLS verification enabled; both attempts are retained.

## Answer-quality findings

These eight bounded prompts are a smoke test, not an accuracy estimate. AI review rated four answers good, one partial and three bad for the requested shopper goal. Safe clarification counts as incomplete when the shopper supplied an exact catalog name.

| Demo | General shopping query | Exact catalog-name query |
| --- | --- | --- |
| Grocery | Rice under $50 returned an in-budget product | Red Grapes triggered unavailable-attribute clarification |
| Electronics | Laptop for online classes under $40 correctly reported no match and no verified suitability | iPhone 14 was included, alongside other iPhone models |
| Jewelry | Rings under $500 returned in-budget products | Sapphire Silver Ring triggered Color versus Metal clarification |
| Pharmacy | Moisturizer under $50 returned two in-budget products | Exact Estée Lauder product name returned no match despite appearing in the catalog |

Baseline comparison is complete: all four old/new Node payloads match except latency, and isolated retained-baseline/active Python images produce identical answer text and products using eight shared captured catalog reads. The active replay also matches the public answer text and product IDs. These four limitations therefore reproduce on the previous release; no regression was observed in this comparison. These findings do not invalidate the observed service-health checks, but prevent a claim that all shopping answers are correct. No additional production change is made for these findings without a verified fix and release checks.

## Evidence and rollback

[Activation evidence](../../platform/evidence/README.md#evidence-e85d651906e1a9d0) (`output/db-driven-language-20261010/activation/verification.json`) records the deployment and retained rollback assets. [Independent verification](../../platform/evidence/README.md#evidence-29fde7b2632842fc) (`output/enterprise-knowledge-production-verification-20261010/verification.json`), including the [paired Python baseline replay](../../platform/evidence/README.md#evidence-bf1383c1d0f6e39a) (`output/enterprise-knowledge-production-verification-20261010/exact-name-python-baseline.json`), binds public responses, internal identities, catalog schemas and fresh product checks by SHA-256.

The remote backup is `/var/backups/rocento/db-recognition-20261010-v2`; retained image tags are `rocento-language-engine:rollback-db-recognition-20261010` and `rocento-ai-service:rollback-db-recognition-20261010`. The historical frozen-candidate runbook applies to a different release and must not be replayed against this new active UUID.
