## Grocery release readiness continuation — 2026-11-12

Prepared a new **unapproved local review candidate** for `aws-onboarding-test`:
`sha256:252553844a001c6b133d3a0cdb9dfb92456d542650896df1f4b7a11193ada248`.
The packet is retained at
`commerce-output/2026-11-12-grocery-release-readiness/deliverables/candidate/`.
It binds rebuilt ARM64 API, storefront/admin and MinIO artifacts, exact provider
image IDs, selected dirty-source fingerprints, migration hashes and current
executor/policy/verifier checksums. It is not installed or approved on AWS.

Implemented narrow Rust TLS dependency updates and a pinned supported Go builder
with Debian updates for MinIO. Fixed merchant public metrics exposure, rejected
artifact-directory symlinks, and replaced shared proxy-peer throttling with
tenant/client-specific ingress limits and exact Cloudflare proxy trust. Actual
Nginx tests cover encoded paths, forged headers, separate client/tenant budgets
and refresh/logout exemptions. Candidate verification now consumes immutable
candidate IDs and artifacts rather than mutable build tags.

Current local checks: 25 PostgreSQL onboarding integration tests, five browser
scenarios, nine proxy/hostname tests and both onboarding typechecks passed.
The final combined release tooling/executor/alert/control/policy suite passed 57
tests, and the actual disposable Nginx suite passed seven. The rebuilt API passed
HTTP/checkout invariants, worker health, reporting contention, ClickHouse and NATS
outage/recovery scenarios using its exact image ID with the standard isolated
provider fixture. That fixture uses its recorded provider images, not the entire
merchant candidate, and its short workload does not establish production capacity.
Separately, the unchanged candidate verifier passed against all ten exact merchant
services inside a disposable Linux Docker controller: fresh migrations, Grocery
installation, admin login, theme publication, repeat bootstrap, container isolation
and candidate integrity. Root-owned tool/artifact checks remained enabled. Its
sanitized wrapper report explicitly identifies local Docker execution; the
verifier's fixed AWS target label is not evidence of AWS acceptance. All fixture
containers, volumes and networks and the controller were removed afterward.
The historical capacity-schema upgrade fixture passed through 105 migrations and
preserved a synthetic reservation; the actual AWS upgrade baseline remains unverified.
Source and extracted frontend artifact secret scans found no secrets in their
declared scope. API gateway binaries compile; Rust architecture and affected auth
tests pass. Full Rust formatting still reports pre-existing gateway test formatting
differences; those unrelated files were preserved.

Security remains **blocked**. Trivy 0.76.2 with the 2026-11-12 database reports
rebuilt API 1 critical / 101 high OS rows and rebuilt MinIO 7 critical / 78 high
rows. The retained review distinguishes package counts from applicability and
includes separate Rust/frontend lockfile scans; the container scan does not detect
the statically linked Rust dependency inventory. Debian documents why its Bookworm
zlib binary is not affected by the reported MiniZip issue, but no blanket
suppression or independent acceptance was applied. The pinned MinIO community
source remains affected by
[CVE-2026-40344](https://github.com/minio/minio/security/advisories/GHSA-9c4q-hq6p-c237)
and [CVE-2026-41145](https://github.com/minio/minio/security/advisories/GHSA-hv4r-mvr4-25vw).
Its Go rebuild and passing isolated S3 CRUD smoke do not resolve those authentication
bypasses. A supported patched storage artifact or separately implemented and
reviewed mitigation is required. No AIStor licensing/product change was made.

Live read-only checks: onboarding and ops HTML return 200, anonymous staff
dashboard API returns 401, and both `test` merchant hostnames return 525. A browser
rendered both sign-in pages, but no authenticated session was available. SSH refused
the host because its advertised keys differ from saved trusted keys; verification
through the AWS console was requested without bypassing host-key checks. No AWS
authentication, uploads, deployments, payment confirmations, password resets or
tenant mutations occurred. Current database lifecycle/coverage, OWNER membership,
worker/timer health and alert recipient/inbox delivery therefore remain unverified.

The readiness gate remains blocked with approval empty. All nine evidence
categories must meet their full coverage before a distinct accountable reviewer
can approve that exact candidate/environment. After resolving host identity and
security blockers, refresh target-specific evidence, install the reviewed packet,
and allow only the normal worker to provision the existing confirmed store.

## Staff dashboard — 2026-11-12

Local verification: 25 PostgreSQL integration tests, five Playwright browser scenarios, seven customer/staff proxy tests, ten merchant executor tests, and five tenant-control unit tests passed. The database tests cover staff/customer audience separation, membership and role revocation, reset/logout revocation, idempotent payment confirmation, restricted-store payment/provisioning denial, retained expired reservations, actual host-completion SQL, and suspension arriving during final validation. Browser tests use fixtures and cover payment confirmation, exact-slug suspend/archive, authentication boundary, and desktop/mobile layouts.

AWS deployment completed on 2026-11-12 at `https://ops.rocento.com`. PostgreSQL was backed up before migration 006; the running API image was retained as `rocento-onboarding-api:before-ops`. The existing verified owner account was enrolled; no password was reset. API/ops containers, the merchant worker, and tenant-control timer are running. The controller reports Result=success.

Public checks: ops HTML 200, unauthenticated staff dashboard 401, cross-origin login 403, existing onboarding 200. A real browser rendered the deployed staff sign-in screen with no page errors. Authenticated UI actions were verified with browser fixtures and PostgreSQL integration tests, not by using the owner's password.

An isolated AWS runtime fixture verified exact-host HTTPS 503, container stop, and retained data volume. Only after those assertions passed did test cleanup remove its disposable container, volume, network, directory and nginx file. No real customer store was suspended or archived. The real `test` store remains QUEUED/ENABLED with BLOCKED/APPROVED_RELEASE_REQUIRED and no control command. Release security review and independent approval remain pending; the changed executor also requires refreshed release evidence before activation.

## Grocery executor and wildcard DNS — 12 November 2026

- Installed the restricted host executor and systemd provisioning worker on AWS;
  the previous Compose worker is stopped. Invalid executor requests are rejected.
- Wildcard DNS resolves both merchant hostnames and a fresh hostname. Onboarding
  returned HTTP 200; an unprovisioned wildcard hostname returned Cloudflare 525
  because the origin intentionally rejects its TLS handshake.
- AWS ARM64 commerce API and reusable storefront/admin production builds passed.
  The expected MinIO prebuilt images were unavailable from Quay and Docker Hub;
  an explicit official upstream source release was built as a separate candidate.
- **10 executor tests**, **3 alert tests**, **2 frontend hostname-pairing tests**, admin typecheck,
  shell/Python syntax checks and documentation checks passed.
- An actual disposable AWS runtime passed fresh migrations, Grocery catalog
  installation, admin authentication, theme publication, repeat bootstrap and
  container network/volume/image isolation checks on all ten services, including
  analytics, engagement and export worker health. An initial expanded run caught
  ClickHouse startup failure; a larger process/memory budget and explicit readiness
  dependency fixed it, and the complete fixture passed. Generated merchant Nginx
  configuration also passed `nginx -t`. Fixture containers and volumes
  were removed afterward. No real tenant was activated by this test.
- Candidate inventory: `sha256:c779d1018e81391c60b25ed6d1f42bf2826a27567fd59e27eb5ad6d367296731`.
  Its root-owned readiness packet is **unapproved**. Runtime smoke does not
  establish browser checkout, external delivery, schema upgrade, production
  capacity, operational acceptance or independent release approval.
- A one-time operator alert was accepted by SMTP; inbox delivery is unconfirmed.
  The failure-monitoring timer is active. Two merchant allocations are allowed on
  this test host; further allocations block until capacity is expanded.
- Trivy 0.76.2, vulnerability database updated 2026-11-12 07:01 UTC, reported API: 1 critical / 101 high findings; MinIO: 7 critical /
  82 high findings. These are raw package counts, not exploitability conclusions.
  Applicability/remediation review remains incomplete. For example,
  [Debian's CVE-2023-45853 record](https://security-tracker.debian.org/tracker/CVE-2023-45853)
  explains why its Bookworm zlib binary packages are not affected by that MiniZip
  issue. No blanket suppression or security approval was applied.
- The confirmed test tenant remains QUEUED, blocked on approved release metadata;
  paid service coverage has not started. Administrator credential handoff remains
  an operator step until an invitation/SSO flow is implemented.

## Provisioning jobs — 12 November 2026

- Local PostgreSQL 17: **19 tests passed**, including concurrent consumption/claims,
  blocked release/executor, lease loss, bounded retries, organization isolation,
  wrong evidence, approval revocation, paid-theme locking, atomic domain rollback,
  and one-time activation with service coverage starting only after validation.
- Proxy: **4 tests passed**; browser: **4 tests passed**, including blocked status,
  hidden premature links, simulated activation and mobile overflow checks.
- AWS ARM64 API/worker and web production builds passed; migration 005 applied
  after a protected PostgreSQL backup, with previous images retained for rollback.
- Live worker consumed the existing confirmed test payment once: one job, one
  local receipt, `QUEUED` tenant / `BLOCKED` job at RELEASE with
  `APPROVED_RELEASE_REQUIRED`. No completed deployment steps or started coverage;
  external outbox publication remains untouched. All theme records are DISCOVERED.
- Public page returned HTTP 200; the status endpoint rejected anonymous access
  with HTTP 401. Authenticated new status UI was covered by mocked browser tests,
  not rechecked in the customer's live browser session during this deployment.
- Successful activation in these tests uses a test-only executor. It does not
  establish a live merchant deployment or production readiness.

# Onboarding verification history

## Live customer payment acceptance — 12 November 2026

Continued the user's existing AWS test account rather than creating a duplicate
or changing its password. Read-only database inspection confirmed a verified
account, persisted Launch/Grocery draft, paired hostname reservation and an
existing `AWAITING_PAYMENT` request. Signup and email verification were completed
by the user before this acceptance run; a fresh registration or new inbox
delivery was not replayed. The user signed in, and the saved draft and selected
plan/theme were inspected in their actual Chrome session.

The operator API confirmed the existing request using the explicitly synthetic
EGP 1.00 / 30-day configuration and a receipt marked `AWS-E2E-SIMULATED`.
No funds were transferred or represented as commercially received.

| Check | Live result |
| --- | --- |
| Existing signup and email verification | Verified account present; user-completed steps inspected |
| Sign-in and saved setup | Signed-in customer, reserved brand/address and Launch/Grocery choices visible |
| Existing payment request | `AWAITING_PAYMENT`, Rocento, EGP 1.00, 30 days |
| Operator call without authentication | 403 |
| Confirmation with wrong amount | 409 `PAYMENT_TERMS_MISMATCH` |
| Simulated operator confirmation | 200, `CONFIRMED` |
| Identical confirmation retry | 200, same confirmed request |
| Retry with a different receipt | 409 `PAYMENT_ALREADY_CONFIRMED` |
| Customer payment display and refresh | Confirmed status, amount, coverage and pending setup visible |
| Persisted effects after retry | Exactly one confirmation, entitlement, `billing.confirmed` audit and billing outbox event |
| Tenant and routing | Tenant `QUEUED`; both hostname routes remain `RESERVED` |

The 30 service days are credited but have not started. The billing outbox event
has not been published. Provisioning jobs, approved theme releases, runtime
allocation/deployment, merchant DNS/TLS/routing, activation, renewals and refunds
remain pending. This verifies live payment acceptance through the current queue
boundary; it does not establish that a merchant store can launch automatically.
The test records were retained as acceptance evidence. A private screenshot and
machine-readable result are retained in the workstation's ignored onboarding
test evidence directory; no account credentials were added to source control.

## AWS test installation — 12 November 2026

Uploaded the current tracked and non-ignored project source to the verified new
ARM64 AWS instance. A checksum-only comparison found no differences in the
selected source files. Credentials and generated workstation state were excluded
from the source transfer; approved SMTP/TLS inputs were installed separately in
root-only configuration storage.

The separate `rocento-onboarding-test` Compose stack runs PostgreSQL, the API and
the customer UI. All four migrations applied successfully. The API and database
bind only to loopback; Nginx serves `https://onboarding.rocento.com` through
Cloudflare. SMTP TLS and authentication succeeded without sending a message.
The public anonymous wizard, account page, mobile layout, CSRF rejection (403),
invalid login (401), and inaccessible operator proxy route (404) passed a browser
smoke check without creating accounts. The 12 Rust integration tests passed on
the AWS ARM64 host against a separate disposable PostgreSQL container, which was
removed after the run. Test-runner fixture mounting was corrected before this
successful run; no application data was used.

The subsequent UI redesign preserves the account, reservation and payment flows.
Its local TypeScript check, three proxy tests and three browser tests passed.
Desktop and mobile screenshots were inspected. Payment browser tests use mocked
API responses; real PostgreSQL behavior is covered separately by the Rust suite.
The redesigned production image was then built and deployed on AWS. Live HTTPS
browser checks passed all four wizard steps and login/register/reset views,
with no JavaScript errors or horizontal overflow at 320px and 390px widths.
The previous frontend image was retained for rollback.

Billing uses explicitly synthetic EGP 1.00 / 30-day terms for all plans with
instructions not to send money. Actual inbox delivery and a real tester's full
email-link journey still require acceptance. No merchant stores were provisioned.
See the [test deployment guide](../../../commerce-ops/services/onboarding/README.md)
for Cloudflare configuration, runtime paths and lifecycle commands.

## Rocento offline billing — 12 November 2026

Implemented one offline method, Rocento, with server-configured terms and
instructions, customer request/status routes, and dedicated operator-token
inspection/confirmation routes. Migration 004 normalizes legacy draft methods
and adds payment requests, append-only confirmations and service-day credits.
Confirmation atomically queues the tenant and writes audit/outbox entries;
it does not deploy a store or start service coverage.

Current local verification:

- PostgreSQL foundation/billing suite: **12 passed, 0 failed, 0 ignored**,
  including migration reapply and upgrade from populated legacy drafts.
- Billing scenarios verify server-owned pricing, missing configuration,
  organization isolation, operator-only access, concurrent duplicate approval,
  receipt reuse across tenants, confirmation/expiry races and full rollback
  when the billing outbox write fails.
- Customer proxy security: **3 passed**, including denial of operator routes.
- Playwright onboarding: **3 passed**, including unavailable payment setup,
  awaiting/confirmed status, refresh/reload persistence and mobile overflow.
  Payment API responses are mocked in these browser tests; the independent
  Rust suite uses real PostgreSQL. Desktop/mobile screenshots were inspected.
- Onboarding TypeScript and production build passed; documentation and
  whitespace checks passed.

All database changes exercised here used disposable test databases. No actual
payment instructions, commercial rates, operator secrets or customer database
were configured. A live browser-to-API payment journey, external receipt
verification and hosted CI remain outside this local evidence. Provisioning,
event consumption, service-period activation, refunds and renewals remain
unimplemented. See the [operator guide](../README.md#rocento-offline-billing)
for configuration, confirmation and expiry handling.

## Rust PostgreSQL foundation verification — 11 November 2026

The current Rust API has now been exercised against disposable PostgreSQL
17.11 using the Axum router, real account sessions and multiple pool connections.
The initial `cargo test --locked --offline` compiled successfully but contained
zero tests; the foundation suite below supplies the missing Rust integration
coverage. No application defect was reproduced in these scenarios.

From `commerce-api/ops-api/`, with `ONBOARDING_TEST_DATABASE_URL` set as described
in the [test instructions](../README.md#postgresql-integration-tests):

```sh
cargo test --locked --offline --test foundation -- --ignored
```

Result: **7 passed, 0 failed, 0 ignored**. Each test created its own database and
ran the actual migration binary twice, verifying initial application of all
three migrations and a no-op reapply. Coverage:

- Registration, email verification, one-time challenge consumption, password
  reset, old-password rejection, logout and session revocation.
- Expired verification challenges and sessions, cross-account token rejection,
  and disabled-account rejection.
- Optimistic draft versions under concurrent saves and organization isolation
  for draft updates, reservations, store listing and store reads.
- Competing organizations reserving the same slug: one success and one 409,
  with one tenant, two domains, one audit entry and one outbox event.
- Concurrent reservation of the same draft: the same tenant is returned
  without duplicate domains, audit entries or events.
- Concurrent expiry reconciliation, draft version increment, retained history,
  hostname reuse by another organization and protection of active tenants.
- Injected audit-write failure after tenant/domain/outbox insertion: all
  reservation changes roll back, the draft remains unchanged and retry succeeds.

From `commerce-web/`, the existing proxy suite also passed **2 tests**:

```sh
pnpm exec vitest run apps/onboarding/lib/control-proxy.test.ts
```

It verifies cross-origin/unmarked-write rejection and secure host-only session
cookie handling with a mocked upstream. The PostgreSQL suite uses in-process
HTTP requests. These results do not establish browser-to-live-API acceptance,
socket startup, email delivery, periodic reconciliation scheduling, NATS
delivery, billing, infrastructure provisioning or production readiness.

The onboarding CI workflow now runs the opt-in Rust suite on PostgreSQL 17,
runs the proxy tests and uses the current `onboarding-ops` frontend scripts.
The hosted workflow has not been run as part of this local verification.
Temporary test databases were removed after the scenarios; no existing
onboarding database or cloud resource was used.

## Rust API migration — 21 October 2026

- The HTTP service runs as a standalone Rust crate at `commerce-api/ops-api`, with separate modules for routes, accounts, drafts, mail, database setup, shared domain rules, and errors.
- `cargo check --manifest-path Cargo.toml --offline`: passed. This is a compile check; the prior NestJS verification records below predate the runtime migration.
- The Rust service is the sole HTTP API implementation. The earlier TypeScript helpers, NestJS app, and Node API test harness were removed during the runtime move.

## Foundation verification — 21 October 2026

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


## Merchant fleet implementation — 12 November 2026

Implemented staff provider selection (`aws`, `gcp`, `hetzner`), migration 007,
transactional three-slot placement, provider host creation/discovery, pinned SSH
node execution, per-merchant DNS and remote suspension/archive. Fleet creation
remains disabled until private configuration, prepared images and the timer are
explicitly enabled. No provider resources or DNS records were created during this work.

Local verification:

- PostgreSQL foundation suite: 27 passed, including the two new fleet tests.
  After adding the durable host boot deadline, both fleet tests passed again
  against newly migrated disposable databases.
- Operations merchant suites: 54 passed and 7 optional Nginx integration cases
  skipped; tenant controls: 5 passed. After adding boot-timeout/configuration
  cases, the focused fleet suite passed all 18 tests.
- Staff TypeScript check and production build passed; staff proxy suite: 4 passed.
- Staff Playwright scenario passed, including provider selection, payment,
  suspension/archive and mobile overflow checks.
- Documentation link/structure checker, Python compilation, shell syntax and
  diff whitespace checks passed.

Provider requests, DNS and SSH are mocked in the operations tests. Real VM image
boot, cloud credentials/quotas, node firewall behavior, public HTTPS routing and
three-merchant capacity require provider acceptance before deployment. The
existing Grocery staging runtime and release-approval requirements still apply.

## Merchant fleet review — 12 November 2026

Reviewed and corrected the local AWS/GCP/Hetzner implementation without deploying.
Provider discovery now traverses pagination and rejects duplicate allocations and
changed instance identities. GCP and Hetzner asynchronous creation is tracked;
transient reads and uncertain creates remain discover-only, while definitive
failures stop for review. Error output omits provider response bodies and credentials.

The allocator rejects null lease/configuration arguments. Immediately before
billable VM creation, current payment/account/store/release authorization and
release evidence are checked again. Pinned SSH verifies node/tool identity before
TLS/SMTP transfer, inherited cloud SSH keys are disabled, remote execution is
bounded by its remaining lease, and suspension/archive remains usable when fleet
creation is disabled. Provider configuration requires pinned templates/snapshots.

Local review verification:

- PostgreSQL: all 27 existing foundation cases passed; the added pre-creation
  authorization case passed separately (28 total). Concurrent placement exercised
  21 merchants across all three providers: six reservations on two hosts per
  provider, with each seventh merchant waiting at the configured host budget.
  The actual controller SQL also rejects revoked themes, disabled accounts,
  suspended stores and failed jobs for each provider.
- Provider/lifecycle suites: 30 passed. Coverage includes pagination, duplicate or
  replaced instances, asynchronous failures, timeouts, permission errors, uncertain
  create recovery, capacity, profile/release mismatch, lease expiry, node identity,
  disabled-fleet controls and idempotent recovery after partial DNS success.
- Merchant suites: 59 passed, with seven optional ingress cases skipped in that
  run; all seven subsequently passed in a disposable local Nginx container.
  Tenant controls: five passed.
- Staff browser tests: four passed, covering all provider choices, placement locks,
  VIEWER restrictions and existing payment/suspension/archive flows. Staff proxy:
  four passed. Staff TypeScript check passed.
- Documentation validation, Python compilation, shell syntax and whitespace checks
  passed. Disposable PostgreSQL and Nginx fixtures were removed after verification.

Cloud provider, DNS and SSH calls remain mocked. These results do not verify real
VM boot, image contents, credentials, quotas, firewall enforcement or public HTTPS
on AWS, Google Cloud or Hetzner. Those require separately authorized provider
acceptance; no VM, DNS, deployment or timer activation occurred in this review.


## Terraform onboarding integration — 12 November 2026

Terraform now owns new AWS/GCP/Hetzner fleet VM creation. Direct API creation was
removed. Staff selection, payment checks and PostgreSQL's three-slot allocator
remain in the onboarding controller. Each server receives a protected S3 state
key with locking; the worker checks a saved single-create plan and current
authorization before apply. Interrupted applies are reconciled through state and
read-only provider identity checks, never blindly replayed. The fleet lock is
separate from merchant deployment/control locking.

Local checks for this change:

- Terraform 1.14.0: schema validation and one mock-provider plan test passed for
  each of AWS, Google Cloud and Hetzner (three plans total). Provider versions and
  checksums are pinned in the repository. Initialization used `-backend=false`.
- Fleet provider/lifecycle/Terraform tests: 41 passed. Merchant suites: 59 passed
  and seven optional Nginx cases skipped. Tenant controls: five passed; alerts:
  three passed. No API/UI/schema behavior changed in this increment.
- Python compilation, installer shell syntax, documentation and whitespace checks
  passed. CI now includes all three Terraform module checks; hosted CI has not
  been run as part of this local work.

No real Terraform plan/apply, cloud backend initialization, provider account
request, VM creation, DNS change or deployment occurred. Registry downloads and
mock-provider plans do not validate credentials, remote state permissions or real
VM bootstrap. Fleet creation remains disabled pending explicit deployment setup.


## Terraform onboarding review — 12 November 2026

Reviewed the Terraform runner, saved-plan policy, workspace integrity, remote
state ownership/recovery, fleet authorization and all three provider modules.
Fixed acceptance of tainted state, missing post-plan enablement/backend checks,
mutable workspace inputs and provider processes surviving CLI timeouts. Saved
plans are checked for completeness/imports/drift and sealed by digest before
apply. Atomic metadata writes preserve private permissions and sync directory
entries. Modules now validate host identity, cloud-init format and pinned profiles.

Verification for this review:

- Terraform schema validation passed for AWS, Google Cloud and Hetzner; 12
  mock-provider plan tests passed (valid settings and rejected identity,
  cloud-init and provider-profile inputs for each cloud).
- Fleet suites: 49 passed, including failure at every CLI phase for all three
  providers, no automatic apply replay, changed state/input/plan rejection,
  tainted recovery, post-plan revocation and a real local process-group timeout.
- PostgreSQL foundation: 28 passed, including 21 concurrent merchant reservations
  across all providers and current-authorization checks against actual SQL.
- Staff Playwright: four passed, covering provider selection and role/placement
  restrictions. Tenant controls: five passed; provisioning alerts: three passed.
- Merchant suite initially had 65 passes and one timing-dependent ingress
  assertion. The disposable fixture now slows rate-budget refill to keep the
  normalized-path check independent of Docker exec latency; all seven ingress
  cases passed after that correction. Production rate settings were unchanged.
- Python compilation, shell syntax, documentation and whitespace checks passed.

No cloud account calls, real Terraform plan/apply, remote backend initialization,
VM creation, DNS writes or deployment occurred. Real credentials, S3 locking and
permissions, provider quotas, VM images and boot remain acceptance requirements.
Disposable local PostgreSQL/Nginx fixtures were removed after testing.

## Grocery fleet candidate preparation — 12 November 2026, 15:35 UTC

The current unapproved merchant candidate is
`9cd270995307e2a69c5fe5bd68b1649da081f6712e1f636c54270f1cb47bc2aa`.
Its exact review index is
`commerce-output/2026-11-12-grocery-aws-verification/deliverables/fleet-review-index.json`.
The frozen fleet overlay contains 127 files with inventory digest
`56e5324569b6a1fd577697ca6f7751d2d20d05fb60181eab1efce6b3bb9ea8b0`.
API, merchant web and MinIO build components remain identical to the previously
frozen bounded candidate; unrelated current workspace changes were excluded.
All 499 candidate artifact checksums were verified. No approval was recorded.

Fresh frozen-source verification passed 107 Python regression tests, four AWS
Terraform mock-plan cases, 31 foundation mock-plan cases and five rendered-policy
checks. Initial sandbox provider-startup failures and a missing policy-test input
are retained; subsequent runs with the local provider socket permitted and actual
mock-plan input passed. These are offline checks, not live provisioning evidence.

Authenticated AWS console and read-only SDK checks confirmed the applied Frankfurt
quota remains 10 vCPUs; the request for 26 is still open. The console reports usage
10, while current instance discovery reports two running instances totaling six
vCPUs. Neither permits the proposed additional eight-vCPU merchant host. The
fleet state bucket does not exist and there are no launch templates. Existing
AMIs do not establish clean merchant-image acceptance. No cloud resources, IAM
permissions, DNS routes or installed release authorization were changed.

The fleet-aware executor changes invalidate reuse of legacy runtime/capacity
results as acceptance for this candidate. Fresh runtime, indexing completeness,
public browser/isolation, three-store capacity and fourth-store allocation,
control-plane migration 007, security review, clean AMI/foundation/canary and
independent release approval remain required. The review index records those
scopes separately; all nine readiness checks remain pending.

The final read-only store inspection still shows QUEUED / BLOCKED with
APPROVED_RELEASE_REQUIRED, one confirmed payment, 30 service days and null
activation/coverage dates. OWNER access and existing records are preserved.
Alerts remain configured for info@rocento.com with protected SMTP settings;
one historical SMTP acceptance is recorded, but inbox delivery is unverified.

## Provisioning checkpoints and bounded concurrency — 2026-11-18

Migration 011 splits deployment into DATABASE, MIGRATE, SERVICES, BOOTSTRAP and
INGRESS checkpoints, retaining completed legacy DEPLOY evidence. Protocol v2 adds
read-only completed-receipt reconciliation. Node command deadlines, process-group
cleanup, per-host dispatch locking, bounded worker/fleet concurrency and draining
shutdown are covered by the focused suites.

Current local verification:

- PostgreSQL 17 disposable-container foundation suite: 35 passed, including
  migration drain/legacy compatibility, lost-response reconciliation, parallel
  claims, checkpoint ordering, release revocation and suspension during validation.
- Operations suites: 64 fleet tests passed; 99 merchant tests ran (92 passed,
  seven optional Linux/Nginx integration tests skipped); five tenant-control tests
  passed. This includes command-descendant timeout cleanup and real host flock
  contention. The shared workspace's controller/host refactor was present.
- Worker concurrency bounds unit test passed; customer/staff Next type generation
  and TypeScript checks passed using their installed local binaries.
- Focused Playwright paid-setup scenario passed, verifying all five deployment
  checkpoints map to Deploy and links appear only after activation.

No cloud VM, production migration, deployment, release approval or live capacity
acceptance was performed. Timed-out/incomplete node intents and expired leases
still require operator review. Follow the coordinated checkpoint rollout in the
onboarding service guide; do not mix protocol-v1 and protocol-v2 components.
