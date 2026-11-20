# Implemented API v0.3

Base: `http://127.0.0.1:4100/api/v1`. These are local foundation contracts, not the complete planned v1 API.

The HTTP service is implemented in the standalone Rust crate at this module's root and started with `cargo run --locked --bin rocento-onboard-api` from `commerce-api/ops-api/`. The matching migration runner is `cargo run --locked --bin migrate`.

| Method | Path | Access | Behavior |
|---|---|---|---|
| GET | /stores/:id/provisioning | Owning customer | Lifecycle, job status/step/reason, activation and coverage dates; URLs only when ACTIVE. Foreign tenants return 404. |
| GET | /health | Public | Process liveness; not DB readiness. Provisioning disabled. |
| GET | /plans | Public | Proposed pricing and policy ceilings. |
| GET | /public/storefront-themes | Public | Four discovered categories; checkout disabled; no approved release claims. |
| POST | /customer/auth/register | Public | Creates a customer account and queues a single-use verification link; always returns a generic `CHECK_EMAIL` response. |
| POST | /customer/auth/login | Public | Verifies password and returns an opaque session token to the same-origin web proxy, which sets an HttpOnly cookie. Email verification is required before reservation. |
| POST | /customer/auth/request-verification, /verify | Public / token | Queues a verification link or consumes a valid single-use token. |
| POST | /customer/auth/forgot-password, /reset-password | Public / token | Queues and consumes a single-use password-reset link; successful reset revokes existing sessions. |
| POST | /customer/auth/logout; GET /me | Customer session | Revokes current session; returns account identity and verification status. |
| GET | /onboarding/draft | Customer session | Reconciles expired reservations for the organization, then returns or creates its draft and any current reservation expiry. |
| PUT | /onboarding/drafts/:id | Owning customer | Saves brand, slug, plan and theme with an optimistic `version`. Payment is persisted as `ROCENTO`; legacy draft values are accepted and normalized. |
| POST | /onboarding/drafts/:id/reserve | Owning, email-verified customer | Atomically reserves both branded domains for 24 hours and records audit/outbox entries. Requires a selected theme. Does not start checkout or provisioning. |
| POST | /slugs/check | Authenticated customer | `{slug}`; reconciles expired reservations and returns advisory availability. The transactional reservation remains authoritative. |
| POST | /registrations | Authenticated customer | Retired; returns `USE_DRAFT_RESERVATION` (410). |
| GET | /stores; GET /stores/:id | Owning customer | Own organization only; foreign IDs return 404. |
| GET | /billing/payment-requests | Customer session | Lists only the customer's organization requests, with snapshotted terms, instructions and current status. |
| POST | /onboarding/drafts/:id/payment-request | Owning, email-verified customer | Requires a live reservation and configured terms/instructions/operator. Creates one Rocento request per reserved tenant; retries return the same record. Client-supplied pricing cannot override server terms. |
| GET | /operator/billing/payment-requests/:id | Dedicated billing operator token | Inspects the request's terms and status. Customer sessions cannot authorize this route. |
| POST | /operator/billing/payment-requests/:id/confirm | Dedicated billing operator token | Requires `receiptReference`, `amountMinor`, `currency`, `serviceDays`. Atomically confirms funds, grants service-day credit, records audit/outbox and moves the tenant to `QUEUED`. Identical retries have no additional effect. |

Customer browser calls use a same-origin Next.js proxy. The proxy keeps the opaque session token in an HttpOnly cookie and forwards it server-to-server; JavaScript cannot read the token. Local file email delivery is development-only. The customer wizard offers one offline method, Rocento, after reservation. Operator routes are excluded from the proxy. The customer bearer fixture stays outside browser bundles, is disabled by default, and is rejected in production. The reservation reconciler expires unpaid `SLUG_RESERVED` tenants and their pending payment requests; it retains history and permits expired names to be reused. Paid `QUEUED` tenants are not released by reservation expiry. Production customer identity integration, generic idempotency headers and full OpenAPI generation remain future work. Staff OIDC/MFA remains deferred; explicit staff membership and separate sessions now protect the operations dashboard; the dedicated operator capability is documented in the [billing guide](../README.md#rocento-offline-billing). Do not expose this API directly to the internet.

Payment states are `AWAITING_PAYMENT`, `CONFIRMED` and `EXPIRED`. There is no
customer "mark paid" endpoint. Missing billing configuration returns 503;
operator permission failures return 403. Terms mismatch, receipt reuse, expired
payment and inconsistent confirmation retries return 409. A confirmation credits
service days but does not start service, consume outbox events or deploy a store.

Errors: invalid input/slug 400, unauthenticated 401, forbidden 403, unknown/foreign store 404, slug conflict 409, unavailable dependency 503. Internal database errors and credentials are not returned.

### Staff API

All paths below are under `/api/v1/staff`. `POST auth/login` uses the existing account credentials and requires enabled staff membership; `POST auth/logout` revokes the staff session. `GET me`, `dashboard`, `clients?search=&page=0`, and `stores/{uuid}` require staff authentication. Clients are paginated at 50; dashboard results cap payments/jobs at 200 and audit events at 100. Dashboard also returns `hosts`: the controller-recorded fleet inventory with id, provider, reference, state, address, error, updatedAt, usedSlots and maxSlots. This read-only staff data contains no cloud credentials and does not trigger cloud API discovery. Slot counts include all retained placements; free slots do not guarantee release/profile compatibility.

`POST payments/{uuid}/confirm` requires OWNER and the same receipt/amount/currency/serviceDays body as operator confirmation. `POST stores/{uuid}/control` requires OWNER and `{action: "SUSPEND"|"ARCHIVE", reason, confirmSlug}`. The response identifies a durable command; acceptance does not mean the host operation completed. Follow its status in store details.

The browser proxy is `/api/control`; it enforces same-origin JSON writes, a route allowlist, and a Secure/HttpOnly/SameSite=Strict host-only cookie. Tokens never enter browser JavaScript. The backend remains loopback-only.

`POST stores/{uuid}/hosting` requires OWNER and exactly `{provider: "aws"|"gcp"|"hetzner"}`.
It records an audited staff decision; customers cannot select hosting through the
customer proxy. Selection may change while an enabled store is `SLUG_RESERVED` or
`QUEUED`, before a running job or placement. The same selection is idempotent;
changes after reservation return `409 HOSTING_PLACEMENT_LOCKED`. Other providers
return `400 INVALID_HOSTING_PROVIDER`. VIEWER receives 403; a customer session
receives 401. Payment confirmation remains independent: an unselected paid store
waits with `HOSTING_PROVIDER_REQUIRED` when its approved release reaches execution.

Staff client/store/job responses include `hostingProvider`; store/job responses
include `hostId`. Store detail additionally includes `hostState` and `hostingLocked`.
Migration 007 adds `merchant_hosts`, `merchant_placements`, and the transactional
`reserve_merchant_host` function. Three numbered slots and unique constraints
bound capacity even across concurrent workers; reservations remain on failure,
suspension and archive. Host creation occurs in a separately enabled host service,
never in an HTTP request or schema migration.

## Offline payment codes and calendar billing

`POST /api/v1/onboarding/drafts/:id/payment-request` accepts
`{ "serviceMonths": 1 }` (default) or `12`. Prices use the approved USD catalog;
annual cost is monthly cost times twelve. The response includes `serviceMonths`;
existing requests retain their original terms.

Staff OWNER `POST /api/v1/staff/payments/:id/confirm` and the private operator
confirmation endpoint now return `{ code, paymentRequestId, expiresAt }` after
validating the existing receipt/amount/currency/serviceDays body. They issue a
six-digit code for manual delivery, without granting service or queuing setup.
Reissuance is limited to once per minute and invalidates the previous code.

Customer `POST /api/v1/billing/payment-requests/:id/redeem` accepts
`{ "code": "012345" }`. It requires the verified owning customer, a valid
reservation, and an unlocked code. Five incorrect attempts produce
`PAYMENT_CODE_LOCKED`; incorrect/unissued codes return `INVALID_PAYMENT_CODE`.
Successful redemption returns the confirmed public payment, grants coverage and
queues setup atomically. Repeated successful redemption does not duplicate credit.
Coverage for new requests uses calendar months from activation; legacy requests
continue to use their original service days.

Store details (`GET /api/v1/staff/stores/:id`) include `job`, either null before worker ingestion or the current job with `id`, `tenantId`, `status`, `step`, `reason`, `attempts` and `updatedAt`. This is independent of the dashboard’s latest-200-job window. Completed checkpoints remain in `steps`.
