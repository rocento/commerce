# Mobile experience backend

Milestone 1 of the [native mobile platform roadmap](../mobile/plans/native-preview-and-release.md) adds the App Studio contract and backend foundation. Milestones 2 and 3 add the [native proof of concept](../mobile/history/native-milestones-2026-10-11.md) and separate [Mobile App Studio](../mobile/app-studio.md). Enrolled device exchange, live device assets, signed binaries and store submissions remain later work. The mobile migrations and standalone dashboard were deployed on 2026-10-11. App Studio now supports production-only editing and direct publication.

## Ownership and boundaries

The [domain-mobile crate](../../commerce-api/rocento-api/crates/domain-mobile/src/lib.rs) owns validation and transactional persistence. The [gateway module](../../commerce-api/rocento-api/crates/api-gateway/src/mobile.rs) adapts the existing administrator session and request-origin protection. Its routes are composed in the normal database-backed gateway. [Migration 20261011010000](../../commerce-api/rocento-api/migrations/20261011010000_mobile_experience.sql) creates the separate `commerce-mobile-apps` schema without changing existing commerce data.

Commerce remains installation-isolated. Mobile control-plane merchants do not make existing catalog, customer or checkout tables safe to share across merchants. Future app onboarding must bind commerce requests to each merchant's verified installation; a config session never authorizes commerce APIs.

All management operations require an active administrator session **and** an explicit `commerce-mobile-apps.memberships` row for the target merchant. Installation `*` permissions do not bypass this check. Owner can read, edit, publish and queue builds; designer can read/edit; operator can read; release admin can read/queue builds. Every query scopes resources to merchant and environment. Support access must be explicitly provisioned and audited through trusted onboarding.

App config reads require an opaque, hashed, expiring `commerce-mobile-apps.app_sessions` credential linked to an active app identity, merchant, environment and platform. The database limits session lifetime to one hour. Trusted short-lived sessions now have a locally implemented owner-approved internal enrollment boundary; see the [enrollment rollout](../mobile/history/commerce-2026-10-12.md#internal-enrollment-and-publishing-verification--2026-10-12). No unauthenticated identifier-only minting or embedded app secret is supported. Public consumer attestation remains a separate release design. An empty installation fails closed until provisioned. Authenticated management and mobile config requests have a 600-request limit per principal/session per 15 minutes, in addition to gateway request admission.

## Contract and validation

[Canonical schemas and two merchant fixtures](../../commerce-api/rocento-api/crates/domain-mobile/contract/README.md) include light/dark palettes, system typography, bounded semantic tokens, closed navigation, the six registered home section types, supported features and English/Arabic messages. The canonical files are packaged inside the backend build context. Runtime configuration cannot contain signing settings, arbitrary URLs, HTML or executable component types.

Validation checks schema, six-digit colors, 4.5:1 contrast for text/background, text/surface and onPrimary/primary, unique section IDs, tab destinations, complete referenced translations, Arabic RTL, supported runtime versions, merchant asset ownership and server entitlements. Config JSON is limited to 128 KiB and 30 sections. The initial compatibility matrix reserves schema/runtime 1.0.0; renderer support must be tested before widening it. Milestone 3 adds sanitized private PNG uploads, scoped asset browsing and an App Studio asset manager via [migration 20261011020000](../../commerce-api/rocento-api/migrations/20261011020000_mobile_studio_assets.sql). Trusted verified HTTPS registry records remain supported. Private administrator asset reads require membership. Locally implemented native asset delivery additionally checks active device access and a reference in the latest compatible published config; it does not expose draft uploads.

## Draft and publish workflow

App Studio management URLs require `?environment=production`. The backend retains legacy staging isolation for existing runtime/test records, but the apps ingress rejects staging and other environment values:

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/v1/mobile/merchants` | Active memberships and entitlements; no environment parameter |
| GET / POST | `/v1/merchants/{merchant}/assets` | Merchant asset list (100/page, beforeId) and sanitized image upload |
| GET | `/v1/merchants/{merchant}/assets/{asset}/content` | Owned private image bytes; no environment parameter |
| GET | `/v1/merchants/{merchant}/app-config/audit` | Immutable audit history (50/page, beforeId) |
| GET / PUT | `/v1/merchants/{merchant}/app-config/draft` | Read/create/update draft with `expectedRevision`; 0 creates, stale writes return 409 |
| POST | `/v1/merchants/{merchant}/app-config/validate` | Validate the saved draft including current ownership and entitlements |
| POST | `/v1/merchants/{merchant}/app-config/publish` | Owner publishes current revision with `Idempotency-Key` |
| GET | `/v1/merchants/{merchant}/app-config/versions` | Latest 50 versions; use exclusive `beforeVersion` to page |
| POST | `/v1/merchants/{merchant}/app-config/rollback` | Owner republishes `targetVersion` as a new version, with expected draft revision and idempotency key |
| GET / POST | `/v1/merchants/{merchant}/app-builds` | Read latest 50 build records or queue validated manifest |
| GET | `/v1/merchants/{merchant}/app-builds/{build}` | Read a scoped build record |

Mutation requests retain `X-Commerce-Request: 1` and the existing allowed-origin checks. Draft configs use `configVersion: 0`. The backend assigns monotonically increasing published versions per merchant/environment. Publication also advances the draft revision; refetch it before further edits. Production drafts publish directly after owner, revision, schema, asset and entitlement validation; there is no staging dependency. Rollback selects only that environment's immutable history and revalidates current entitlements/assets.

The merchant lock, membership recheck, revision comparison, snapshot insertion, draft update, idempotency receipt and audit event occur in one transaction. Concurrent publications with different keys and the same revision have one winner. Reusing a key with a different action, actor or payload returns 409. Database triggers prevent updates/deletes to versions and audits. Every publication after bootstrap records its previous version as the rollback target; the first publication has no earlier target. Audit events retain draft before/after content and published version references. External event delivery/outbox consumers are future work.

## Runtime delivery

`GET /v1/mobile/config?platform=ios&runtimeVersion=1.0.0&locale=en` accepts only the enrolled app bearer session. Authentication, expiry and compatibility checks happen before `If-None-Match`; invalid sessions cannot receive 304. Responses carry tenant-specific ETag, `Cache-Control: private, no-cache`, `Vary: Authorization` and `X-Config-Checksum`. The body is the config alone, without administrator IDs or build settings.

The checksum is SHA-256 of the exact UTF-8 JSON response bytes. Native clients should hash these bytes before decoding, rather than reserializing JSON. The schema contains all supported translations; when the requested en/ar locale is absent, clients use `defaultLocale`. Other locale query values are rejected. A missing publication returns 404; an incompatible latest publication returns 409. The server does not silently serve superseded versions. Native clients must validate and retain their last-known-good compatible snapshot in Milestone 2.

## Build queue boundary

Build requests include a separate manifest, platform and idempotency key. They require owned verified icon/splash records, a provisioned native identifier/store-account reference and supported runtime. Records capture source commit, manifest checksum, merchant/platform build number and queue status. Responses never include signing credentials or the private manifest. The queue has no executor yet: `queued` means recorded, not a completed or signed binary. Signing isolation, associated-domain verification, store-account lifecycle, delivery of build events and release/submission records belong to Milestone 5. Actual secrets must remain in a secret manager; manifests hold opaque references only.

## Local checks

From the repository root, with Rust 1.94 and a disposable PostgreSQL database whose user can create SQLx test databases:

```sh
cargo +1.94.0 test --manifest-path commerce-api/rocento-api/Cargo.toml --locked -p domain-mobile --lib
DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:PORT/TEST_DB cargo +1.94.0 test --manifest-path commerce-api/rocento-api/Cargo.toml --locked -p api-gateway --test commerce-mobile-apps -- --test-threads=1
cargo +1.94.0 clippy --manifest-path commerce-api/rocento-api/Cargo.toml --locked -p domain-mobile --all-targets -- -D warnings
python3 commerce-ops/scripts/contracts/generate_openapi.py
python3 -m unittest commerce-ops/scripts.tests.test_mobile_contract commerce-ops/scripts.tests.test_openapi_contract
python3 commerce-ops/scripts/checks/check-migration-history.py
python3 commerce-ops/scripts/checks/check-documentation.py
```

Install the existing [OpenAPI test dependencies](../../commerce-ops/scripts/tests/requirements-openapi.txt) in a virtual environment before Python checks. Generate frontend API types with the command in [API contracts](api.md). CI runs mobile domain/integration tests through the Rust workspace and the Python fixture suite through the frontend contract job. Local checks establish contract and database behavior only; CI and real-device review remain required before production.

## Verification recorded on 2026-10-11

Local verification passed 6 PostgreSQL-backed mobile API tests, 2 mobile domain tests, 101 existing gateway library tests and 37 Python contract/documentation tests. Coverage includes two merchant sessions, platform and environment isolation, direct production publication, legacy environment isolation, RBAC, invalid components/contrast/runtime, foreign assets, entitlements, stale revisions, concurrent publishing, idempotency, immutable history, rollback, ETags, expiry and build queue ownership. The disposable PostgreSQL 16 instance was separate from commerce databases and was removed after checks.

Strict Clippy passes for `domain-mobile`. Gateway-wide strict Clippy is currently blocked by 7 existing warnings in `storefront_notifications.rs` and `notification_campaigns.rs` (redundant conversions, explicit dereferences and argument count). Those notification implementations were not changed for this task. API inventory regeneration also required classifying the 5 already-implemented campaign routes under their existing merchant administration audience; their public/merchant projections remain unchanged. Canonical examples, generated OpenAPI/client models, API audience inventory, migration version uniqueness, focused formatting and documentation links pass. CI and native-device release acceptance remain pending; production dashboard checks are recorded separately.

Milestone 3 verification adds two integration cases (eight total) for membership discovery, audited tenant-scoped assets and private object upload/read/publication. The image decoder also has a focused sanitization test. See the [standalone dashboard guide](../mobile/app-studio.md) for browser and dedicated ingress evidence.
