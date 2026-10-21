# Public storefront publication

Merchant ingress routes documents to the Node renderer, `/api` to the fixed Rust gateway, and assets to the matching build. Public HTML uses a typed installation-bound snapshot and hydrates the same component tree. It does not wait for login, cart restoration or browser location. The corporate website is a separate static-export application.

| Outcome | Document status / behavior |
| --- | --- |
| Eligible home, product, category or published CMS | 200 with meaningful initial HTML |
| Old slug or ID with eligible destination | One 301 to the current same-installation canonical |
| Missing, inactive, unpublished or invalid request | 404; no canonical, noindex/no-store |
| Explicit approved permanent retirement | 410; no canonical, noindex/no-store |
| Foreign, missing or ambiguous authority | 421 |
| Unsupported document method | 405; GET/HEAD allowed |
| Binding, snapshot, dependency or theme failure | 503; no stale offer or empty successful shell |
| Private account/cart/search/checkout flow | Existing client entry, noindex/no-store and normal API authorization |

HEAD follows GET status/header rules without a body. Canonical identity binds the persisted installation UUID, deployment identity, saved merchant origin and approved HTTPS origin. Caller headers cannot choose authority. Products use `/products/{slug}`, categories `/categories/{slug}` and CMS `/pages/{key}`. Only the configured default content locale is published. Unsupported query parameters fail rather than inventing canonical equivalence.

Effective indexing combines merchant preference, environment, binding and deployment protection. A saved indexable toggle is insufficient. Demo, staging, admin and internal APIs keep their protections. Robots policy does not authorize private access, and generated feeds or structured data do not guarantee search rankings or AI citations.

## Build and start

From `commerce-web` with dependencies installed:

```sh
pnpm --filter @commerce/storefront build:publication
pnpm --filter @commerce/storefront start:publication
```

The publication build produces client and SSR artifacts and runs `server/seal-build.mjs`. Startup rejects mismatched template/server hashes. Node defaults to private binding 127.0.0.1:8081 with 32 active dynamic requests; `PUBLICATION_MAX_INFLIGHT` accepts 1–256. Excess admission returns retryable no-store/noindex 503.

| Environment | Purpose |
| --- | --- |
| `PUBLICATION_ARTIFACT_DIR`, `PUBLICATION_SSR_ENTRY` | Matching sealed client/server artifacts |
| `PUBLICATION_GATEWAY` | Fixed private snapshot gateway |
| `PUBLICATION_APPROVED_ORIGIN`, `PUBLICATION_INSTALLATION_ID` | Approved merchant identity |
| `PUBLICATION_OBSERVATION_TOKEN` | Private observation secret, never browser configuration |
| `PUBLICATION_BIND`, `PUBLICATION_PORT`, `PUBLICATION_MAX_INFLIGHT` | Renderer binding and admission |

Gateway publication also needs explicit environment, noindex protection and matching deployment identity. See [backend publication](../backend/publication.md), [Compose overlay](../../commerce-ops/compose/compose.publication.yaml) and [vhost generator](../../commerce-ops/deploy/ec2/publication.py).

## Verification and rollout

Validate matching artifacts, origin/public-edge statuses, canonical host, robots, caching, withdrawal, media derivatives and feed freshness. Verify private APIs remain authenticated. The preserved [deployment gate](../platform/seo-geo/Tests/stage11-release/deployment_gate.py) can collect actual-host topology evidence; inspect its options and scope before running it. Local fixtures do not verify externally managed database/storage IAM or DNS/TLS/CDN/WAF.

Keep prior matching gateway/frontend artifacts and restore them together when rollback is required. Retain additive schema, orders, feed journals and attribution state. Exercise destructive fixtures on isolated synthetic environments. No new production publication, public indexing or live acceptance is claimed by this documentation rewrite.
