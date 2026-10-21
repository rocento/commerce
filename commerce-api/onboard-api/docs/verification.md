# Rust API migration — 21 October 2026

- The HTTP service runs as a standalone Rust crate at `commerce-api/onboard-api`, with separate modules for routes, accounts, drafts, mail, database setup, shared domain rules, and errors.
- `cargo check --manifest-path Cargo.toml --offline`: passed. This is a compile check; the prior NestJS verification records below predate the runtime migration.
- The Rust service is the sole HTTP API implementation. The earlier TypeScript helpers, NestJS app, and Node API test harness were removed during the runtime move.

# Foundation verification — 21 October 2026

- `npm test`: 11 passing domain/security and embedded PostgreSQL tests.
- `npm run typecheck`: passed for API, shared rules, and both frontends.
- `npm run build`: NestJS and both Next.js production builds passed. Onboarding rebuilt after validation-copy improvement.
- `npm run test:api`: passed real HTTP checks for liveness, unauthorized access, customer-to-staff denial, staff-to-customer denial, reserved slug validation, and unapproved theme gate.
- `npm run test:browser`: 2 passing Playwright scenarios covering empty/reserved input, plan/theme selection, browser refresh persistence, blocked checkout, mobile overflow, client errors and locked staff surface.
- Final dependency installation audit: zero reported vulnerabilities. This is a point-in-time dependency check, not a security certification.
- Desktop and mobile screenshots inspected: `onboarding-preview.png`, `onboarding-mobile.png`.

Docker Desktop daemon was not running. PGlite validated the actual PostgreSQL migration, uniqueness/slug constraints, atomic transaction rollback, theme approval metadata constraints, and append-only audit. Multi-connection PostgreSQL concurrency, Compose startup, NATS delivery, tenant deployment, TLS, cloud infrastructure and production authentication are not yet verified or implemented. No cloud/DNS/payment/release changes were made.

Read-only authenticated GitHub inspection confirmed `rocento/rocento` is private, defaults to `main`, and contains the same four demo definitions as the adjacent local source. No remote changes were made.

## Account, draft, and reservation-expiry follow-up — 21 October 2026

- `npm test`: 15 passing, including account verification, password reset/session revocation, optimistic draft versioning, verified reservation, expiry reconciliation/name reuse, CSRF rejection and production cookie handling.
- `npm run typecheck` and `npm run build`: passed after the API parser was moved to Nest's typed Express adapter API.
- `npm run test:api`: passed with retired registrations (410), reserved slug validation (400), and the removed staff endpoint returning 404.
- `npm run test:browser`: 2 passing. The wizard assertion matches the reserve-first flow, and the staff shell remains locked.
- Follow-up checks found and fixed incompatible audit SQL parameter typing and local fixture-auth fallback to an unconfigured account store.
- Migration `003_reservation_expiry.sql` retains expired tenant and domain rows, marks them expired, clears the draft's reservation pointer and increments its version, appends audit/outbox events, and permits only the expired hostnames/slugs to be reused. A periodic reconciler runs every 10 seconds; draft and slug reads also reconcile. This only changes the control-plane registry and does not change DNS.

Production customer identity and email-provider integration, real multi-connection PostgreSQL concurrency, Docker/NATS delivery, billing, and provisioning remain unimplemented or unverified. Staff login, OIDC/MFA, and staff API routes are removed from this phase; the staff shell stays locked.
