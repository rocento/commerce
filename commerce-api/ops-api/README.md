# Rocento onboarding API

Standalone Rust service for customer accounts, server-synced onboarding drafts, and temporary domain reservations. It is maintained separately from the customer and staff interfaces in [`../../commerce-web/apps/onboarding`](../../commerce-web/apps/onboarding) and [`../../commerce-web/apps/onboarding-ops`](../../commerce-web/apps/onboarding-ops). See the [onboarding guide](../../commerce-docs/onboarding/README.md) for the complete project layout.

The Rust crate is at this module's root. Routes, account security, draft and reservation logic, database setup, mail delivery, and domain rules are kept in separate files under `src/`. PostgreSQL schema and seed data live under `database/`.

## Local development

Requires Rust/Cargo and Docker. From this folder:

```sh
cp .env.example .env
# Set AUTH_MAIL_KEY in .env to a fresh 64-character hex value from: openssl rand -hex 32
docker compose -f ../../commerce-ops/local/onboarding/compose.yaml up -d
cargo run --locked --bin migrate
docker compose -f ../../commerce-ops/local/onboarding/compose.yaml exec -T postgres psql -U rocento -d rocento < database/local-seed.sql
cargo run --locked --bin rocento-onboard-api
```

The API listens at http://127.0.0.1:4100. Health is available at `/api/v1/health`. Customer sessions are held in an HttpOnly, same-origin cookie by the onboarding web app; the app's server-side proxy forwards account and draft requests. Local file mail is development-only.

For local customer fixture calls, set `LOCAL_AUTH_ENABLED=true` and a random `LOCAL_CUSTOMER_TOKEN` of at least 32 characters in `.env`, then restart the API. The fixture is rejected in production. Never commit local secrets or use these settings in a production environment.

The browser-local onboarding preview works without this service. Rocento offline
payment requests and operator confirmation are available after explicit billing
configuration. Staff operations and host provisioning are implemented. Merchant activation still requires an approved, verified release.

## Contracts and implementation notes

- [Implemented API contracts](docs/api-contracts.md)
- [Inventory and implementation plan](docs/implementation-plan.md)
- [Verification history](docs/verification.md)

Build the Rust service with `cargo build --locked`. Database migrations use a Rust binary in this crate, so API and migration tooling share the Cargo lockfile.

## Rocento offline billing

Run migrations before starting the updated API. Migration 004 changes saved
draft payment values to `ROCENTO` and adds payment requests, an append-only
confirmation ledger and service-day entitlements. Older clients may still send
`PADDLE` or `MANUAL_CASH` when saving a draft; the API stores `ROCENTO`.

New customer requests use the approved USD monthly catalog prices: Starter $29,
Launch $79, Growth $300 and Enterprise $2,500. The final onboarding step accepts
`serviceMonths: 1` or `12`; yearly billing costs exactly 12 monthly payments.
Migration 010 adds calendar-month coverage and payment codes. Existing requests
retain their original snapshotted terms and legacy day-based coverage.

1. The verified customer reserves an address and requests monthly or yearly payment.
2. An OWNER verifies funds offline, supplies the receipt reference, and generates a
   six-digit code in the staff Payments dashboard. Send this code manually to the
   named client. The API never emails it and does not queue setup at issuance.
3. The signed-in customer submits `{ "code": "012345" }` to
   `POST /api/v1/billing/payment-requests/:id/redeem`. Successful redemption
   atomically records confirmation, grants coverage and queues setup.

Codes are stored as salted Argon2 hashes, scoped to the payment and customer,
and expire with the reservation. Five incorrect attempts lock the code. An OWNER
can issue a replacement after a one-minute cooldown; this invalidates the old
code. A successful redemption can be retried without granting coverage twice.
Receipt references cannot fund multiple requests. Expired reservations require
manual resolution; no refund or late-payment reassignment endpoint is provided.

Staff authentication is sufficient for this flow; customer billing no longer
requires the legacy `ROCENTO_PAYMENT_TERMS` or `ROCENTO_PAYMENT_INSTRUCTIONS`
environment variables. Those settings remain supported for internal legacy callers.
The optional loopback operator API still requires `ROCENTO_BILLING_OPERATOR_ID`
and a random 64-hex-character `ROCENTO_BILLING_OPERATOR_TOKEN`; its `/confirm`
endpoint now issues a code using the same verified receipt/terms body as staff.
It no longer directly queues provisioning. Never expose this operator API publicly.

Calendar coverage begins after validated activation and ends one or twelve
calendar months later (month-end dates clamp to the last valid day). `serviceDays`
is retained for legacy confirmation compatibility; `serviceMonths` controls new
coverage and is shown in both customer and staff interfaces.

`QUEUED` means paid and awaiting provisioning, not an active store. The worker
below consumes confirmed payments and starts service coverage only after validated
activation. Automatic renewal remains pending; merchant execution requires a reviewed release. This single-operator credential is a
limited administrative capability, not staff identity-provider integration;
rotate it by updating the private environment and restarting the API. Do not
publish the operator API directly to the internet.

## PostgreSQL integration tests

[The foundation suite](tests/foundation.rs) exercises the actual Axum router,
account and draft services, and PostgreSQL transactions. It covers email
verification, password reset/session revocation, draft version conflicts,
organization isolation, concurrent reservations, expiry/name reuse and rollback
after an injected audit-write failure. Each scenario runs the migration binary
twice to verify initial application and a no-op repeat.

Run from this module with a disposable PostgreSQL 17 container:

```sh
docker run --rm -d --name onboarding-foundation-postgres \
  -e POSTGRES_PASSWORD=onboarding-test-only -e POSTGRES_DB=onboarding_test_admin \
  -p 127.0.0.1:55439:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine
docker exec onboarding-foundation-postgres pg_isready -U postgres -d onboarding_test_admin
# Once pg_isready reports accepting connections:
ONBOARDING_TEST_DATABASE_URL=postgres://postgres:onboarding-test-only@127.0.0.1:55439/onboarding_test_admin \
  cargo test --locked --test foundation -- --ignored
docker stop onboarding-foundation-postgres
```

The suite requires an explicit IPv4-loopback URL whose database is
`onboarding_test_admin` and a role allowed to create databases. It creates a
unique `onboarding_test_<uuid>` database per test and drops only those databases,
including after scenario assertion failures. The container uses temporary
storage; stopping it removes its test data. It does not use the existing local
onboarding Compose volumes or read the application's database URL.

These tests are explicitly ignored by default because they require PostgreSQL;
`cargo test` alone does not run them. CI runs the opt-in suite using a dedicated
PostgreSQL service. Requests exercise HTTP handlers in-process; this does not
verify the browser proxy, socket listener, email delivery, background timer,
NATS, billing or deployment. See [verification history](docs/verification.md)
for the dated results and remaining coverage.

## Durable provisioning jobs

Migration 005 adds jobs, append-only step/attempt evidence and local event receipts.
Run `cargo run --locked --bin provisioning-worker` with `DATABASE_URL`; `--once`
processes at most one step. Existing confirmed payments are picked up automatically.
The transactional PostgreSQL subscriber does not mark outbox events published;
external transport/NATS delivery remains separate and unimplemented.

Migration 011 splits deployment into durable checkpoints:
RELEASE → ALLOCATE → DATABASE → MIGRATE → SERVICES → BOOTSTRAP → INGRESS → VALIDATE → DONE.
The customer interface groups the five deployment checkpoints under Deploy.
Claims use row locks and a 180-second lease. Each node checkpoint has a shared
100-second command budget, inside a 110-second remote call and 130-second worker
execution timeout. A lost executor response permits at most 20 seconds of
read-only receipt reconciliation while the original lease is still valid.
Only a matching completed receipt can advance the job. Missing/incomplete receipts
or expired leases still require review; external mutations are never blindly replayed.

`PROVISIONING_CONCURRENCY` defaults to 4 and accepts 1–8. `--once` still processes
at most one checkpoint. SIGINT/SIGTERM stop new claims and drain in-flight work.
Independent merchant hosts execute concurrently, while each host retains its
installed deployment lock for ports, ingress and tenant controls. Safe executor
failures retry with backoff, at most five failures per checkpoint. Missing
prerequisites are checked every 60 seconds without consuming retries; host-lock
contention is checked after one second. Completed checkpoints survive restarts.

Before migration 011, stop/drain every worker and verify no RUNNING jobs remain.
The migration rejects live jobs, maps unfinished DEPLOY jobs to DATABASE without
changing their status, and preserves historical DEPLOY evidence for jobs already
awaiting validation. Do not reset FAILED jobs to force migration or recovery.
Protocol v2 requires coordinated worker/controller/node installation and fresh
release evidence; see the service guide's checkpoint rollout procedure.

Activation atomically records evidence, activates both reserved domains, starts
paid service coverage, updates the tenant and emits one activation event. Payment,
coverage terms, selected theme and pinned approved release are rechecked under
locks before committing each step. Paid themes cannot be changed by the customer.

The worker requires a separately reviewed executable at
`/usr/local/lib/rocento/onboarding-executor`. This file and every parent must be
root-owned, not group/world-writable, and not symlinks. It receives one JSON input
on stdin with `schemaVersion: 2`, `operation: execute|reconcile`, stable
`idempotencyKey: jobId:step`, and `job`
(IDs, lease token, step, theme, pinned release version/digest and exact hostnames).
It receives no inherited database or SMTP environment. Exit 0 must return the
`Evidence` JSON defined in `src/provisioning.rs`; exit 75 guarantees safe replay;
78 means release authorization is missing. Other exits require review. Output is
limited to 64 KiB. Check names are a contract with a trusted executor, not proof
that the worker itself performed infrastructure checks.

The executor must actually enforce release authorization, architecture/artifact
availability, tenant capacity/isolation, migrations, runtime/admin readiness and
HTTPS/DNS/tenant/release identity checks before reporting success. It must keep
operations idempotent across process restarts and terminate child operations on
cancellation. The host implementation and restricted installer are documented in the
[onboarding service guide](../../commerce-ops/services/onboarding/README.md#automatic-merchant-provisioning).
The worker has no Docker socket. Candidate verification and reviewed merchant
artifacts remain required before activation; do not supply synthetic evidence or manually set ACTIVE.

The customer GET `/api/v1/stores/:id/provisioning` exposes only their organization's
status, blocker, activation/coverage times and live links after activation. The
wizard polls it and displays blocked, progressing, review-required and active states.
Health `provisioningJobsEnabled: true` identifies this orchestration capability;
`provisioningEnabled: false` is a conservative capability flag, not a live readiness
probe. The installed worker, approved release and provider configuration determine
execution readiness.

## Staff operations dashboard

`ops.rocento.com` runs the separate `onboarding-ops` app on loopback port 3101. Migration 006 adds explicit OWNER/VIEWER membership, independent four-hour staff sessions, and durable store-control commands. There is no public staff enrolment. An existing verified account must be enrolled by a trusted host operator. Customer sessions and operator tokens cannot authenticate staff routes. Password reset revokes staff sessions.

Owners can search clients, inspect provisioning and audit history, confirm a payment using its snapshotted terms and an independently verified receipt, and request suspension or archive with an exact store slug and reason. VIEWER can only read. Payment confirmation is idempotent and does not approve a release.

Suspension and archive immediately disable provisioning and payment confirmation. The root host controller applies an exact-host 503 response, stops only the tenant runtime, and then marks the command APPLIED. Data, volumes, hostnames, payment history and capacity allocations are retained; coverage dates are not extended. Archive is not permanent deletion. Restore, permanent deletion, staff administration UI, and OIDC/MFA are not included. Failed commands require host operator review.


## Merchant hosting selection and fleet

Terraform is the required server-creation engine for AWS, Google Cloud and
Hetzner. It runs in the background fleet worker using protected per-server
remote state; the API and PostgreSQL continue to own staff selection, payment
authorization and the maximum of three merchant reservations per host.

Migration 007 adds staff-selected `aws`, `gcp`, or `hetzner` hosting, a central host
registry and durable placements with at most three merchant slots per host.
OWNER staff select hosting in store details through `POST /api/v1/staff/stores/:id/hosting`.
Selection becomes immutable once capacity is reserved; customers and VIEWER staff
cannot change it. Host creation runs outside the API in a separately enabled
controller timer. New stores without provider selection or configured fleet
infrastructure remain blocked. Existing local merchant data is not migrated.

Follow the [fleet installation and recovery procedure](../../commerce-ops/services/onboarding/README.md#merchant-fleet-aws-google-cloud-and-hetzner)
for private provider templates/credentials, machine images, release evidence,
per-provider host budgets, pinned remote execution and DNS routing. Provider
adapters are implemented but live provider acceptance remains a deployment step.
