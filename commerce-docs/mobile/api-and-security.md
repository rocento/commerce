# Mobile API, data and security

The [gateway route registration](../../commerce-api/rocento-api/crates/api-gateway/src/mobile.rs), [mobile domain](../../commerce-api/rocento-api/crates/domain-mobile/src), [migrations](../../commerce-api/rocento-api/migrations) and [OpenAPI](../../commerce-api/rocento-api/openapi.json) are authoritative. This document summarizes responsibilities instead of duplicating incomplete routes or hypothetical table definitions.

## Control plane

Merchant-scoped `app-config` operations load/update drafts, validate, publish, list immutable versions and roll back. Draft updates use optimistic revision checks. Assets, enrollment and app-build APIs have separate scoped authorization. Current Studio uses production drafts; the API binds requests to an explicit environment where required. See the [backend implementation guide](../backend/mobile-experience.md).

`/v1/merchants/{merchant}/app-preview/sessions` creates an authorized short-lived session. Session status/revocation is scoped to merchant and creator. Catalog-preview endpoints support the browser renderer and remain required. They do not publish or synchronize drafts.

## Native delivery

Published `/v1/mobile/config` loading supports compatibility validation, conditional requests, checksum verification, caching and fallback through the optional native adapters. Enrollment credentials are distinct from customer authentication and preview capabilities.

`/v1/mobile/preview/{session}`, `/ack` and `/assets/{asset}` serve authorized draft snapshots, revision/checksum acknowledgements and owned assets. Preview capabilities are hashed on the server and held only in native memory. Requests check tenant/environment, issuer access, expiry and revocation. Draft data never overwrites the published cache.

Worker-start/frame proxy routes connect Studio to the implemented `commerce-ops/deploy/native-preview` pilot. The gateway routes authorized frame/video, bounded input and lifecycle requests by stored platform/implementation to configured workers. Local iOS and Android workers exist; 2026-10-14 records establish the shared Android EC2 pilot. Hosted iOS and broader reliability acceptance remain open. See [native preview](native-preview.md).

## Persistence and trust

Drafts, immutable publications, preview sessions, assets, identities, enrollment and build records remain production data. Draft and published records retain independent lifecycle and authorization rules. Tenant identity cannot be authenticated by a bundle ID alone; backend authorization remains mandatory on every data request.

Trusted origins belong to build/deployment configuration, not downloaded definitions. Signing secrets and native bearer capabilities must not enter runtime definitions or diagnostic logs. Commerce checkout, customer authentication and data binding remain separate from editor simulation.
