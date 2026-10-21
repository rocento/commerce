# Implemented API v0.2

Base: `http://127.0.0.1:4100/api/v1`. These are local foundation contracts, not the complete planned v1 API.

The HTTP service is implemented in the standalone Rust crate at this module's root and started with `cargo run --locked` from `commerce-api/onboard-api/`. The matching migration runner is `cargo run --locked --bin migrate`.

| Method | Path | Access | Behavior |
|---|---|---|---|
| GET | /health | Public | Process liveness; not DB readiness. Provisioning disabled. |
| GET | /plans | Public | Proposed pricing and policy ceilings. |
| GET | /public/storefront-themes | Public | Four discovered categories; checkout disabled; no approved release claims. |
| POST | /customer/auth/register | Public | Creates a customer account and queues a single-use verification link; always returns a generic `CHECK_EMAIL` response. |
| POST | /customer/auth/login | Public | Verifies password and returns an opaque session token to the same-origin web proxy, which sets an HttpOnly cookie. Email verification is required before reservation. |
| POST | /customer/auth/request-verification, /verify | Public / token | Queues a verification link or consumes a valid single-use token. |
| POST | /customer/auth/forgot-password, /reset-password | Public / token | Queues and consumes a single-use password-reset link; successful reset revokes existing sessions. |
| POST | /customer/auth/logout; GET /me | Customer session | Revokes current session; returns account identity and verification status. |
| GET | /onboarding/draft | Customer session | Reconciles expired reservations for the organization, then returns or creates its draft and any current reservation expiry. |
| PUT | /onboarding/drafts/:id | Owning customer | Saves brand, slug, plan and theme with an optimistic `version`. The API retains a payment field for future compatibility; the wizard does not collect a payment preference in this phase. |
| POST | /onboarding/drafts/:id/reserve | Owning, email-verified customer | Atomically reserves both branded domains for 24 hours and records audit/outbox entries. Requires a selected theme. Does not start checkout or provisioning. |
| POST | /slugs/check | Authenticated customer | `{slug}`; reconciles expired reservations and returns advisory availability. The transactional reservation remains authoritative. |
| POST | /registrations | Authenticated customer | Retired; returns `USE_DRAFT_RESERVATION` (410). |
| GET | /stores; GET /stores/:id | Owning customer | Own organization only; foreign IDs return 404. |

Customer browser calls use a same-origin Next.js proxy. The proxy keeps the opaque session token in an HttpOnly cookie and forwards it server-to-server; JavaScript cannot read the token. Local file email delivery is development-only. The customer wizard does not collect a payment preference or offer checkout in this phase; payment integration remains future work. The customer bearer fixture stays outside browser bundles, is disabled by default, and is rejected in production. The reservation reconciler only expires `SLUG_RESERVED` tenants whose lease ended; it retains tenant/domain history, appends audit and outbox events, and makes only expired names reusable. Production customer identity integration, idempotency headers and full OpenAPI generation remain future work. Staff OIDC/MFA and staff API access are outside this project phase. Do not expose this API directly to the internet.

Errors: invalid input/slug 400, unauthenticated 401, forbidden 403, unknown/foreign store 404, slug conflict 409, unavailable dependency 503. Internal database errors and credentials are not returned.
