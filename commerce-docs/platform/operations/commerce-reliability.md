# Commerce reliability baseline

This baseline measures commerce correctness and reliability, including the reporting/analytics process boundary. It combines a dependency map, a focused Grafana dashboard, and repeatable synthetic HTTP/database checks. It does not certify production capacity or change checkout transaction boundaries.

## Critical journeys and dependencies

| Journey | Authoritative path | Supporting dependencies and failure behavior |
| --- | --- | --- |
| Product browsing | Storefront → Rust catalog API → commerce PostgreSQL | Search requests additionally use Meilisearch; media uses object storage. The baseline measures direct product reads, not search or media downloads. |
| Cart changes | Storefront or delegated assistant → Rust cart/inventory modules → commerce PostgreSQL | Live reservations and stock checks share database transactions. Search and analytics receive asynchronous updates; their freshness is separate from write success. |
| Checkout | Authenticated customer → Rust checkout → inventory, orders, fulfillment and COD payment records in one PostgreSQL transaction | Order events are recorded in the same transaction and published through the existing outbox. A timeout is an uncertain outcome; it does not authorize a new purchase with a different idempotency key. |
| Order confirmation | Commerce outbox → NATS → gateway order notification consumer → PostgreSQL notification job → delivery worker | The independent `order-notifications-v1` consumer commits its receipt with the job before acknowledging. ClickHouse and the analytics process are not dependencies; NATS, PostgreSQL and notification transport remain necessary for their respective stages. |
| Login and recovery | Rust identity/customer modules → commerce PostgreSQL | Login needs password hashing and session storage. Verification and password recovery need working notification delivery; console delivery in this harness verifies only the local development flow. |
| Assistant shopping | Rust authentication/delegation → Python assistant → Node language engine → scoped Rust commerce APIs | AI storage and optional provider integrations have their own availability requirements. The baseline does not start or exercise these services. |
| Reports | Rust reporting API/worker → PostgreSQL snapshot → ClickHouse | Reporting runs in the dedicated analytics worker with a separate one-connection pool. The baseline runs additional one-shot report refreshes concurrently with purchases. |

[Gateway startup](../../backend/architecture.md) currently initializes search/media dependencies before serving its complete router. An auxiliary dependency can therefore block startup even when an already-running checkout would not call it. The Compose provider health dependencies are another startup constraint.

The gateway supervises notification delivery, outbox publication, authentication retention, inventory/capacity expiry, order and shipment notification consumers, search indexing and publication workers. An unexpected supervised task exit invalidates readiness and initiates gateway shutdown. Ordinary dependency failures may be retried within each worker. Reporting snapshots, order/cart analytics and optional assistant telemetry have their own worker process and readiness. Export and engagement also have dedicated processes.

## Dashboard and metric semantics

Start the existing [observability stack](observability.md) and select **Commerce · Reliability baseline**. Its definition is [reliability.json](../../../commerce-ops/deploy/observability/grafana/reliability.json). Select the gateway and analytics instances so independent installations are not silently aggregated. Reporting freshness is scraped from `commerce-analytics`, not the gateway.

Panels reuse route request/error counters, route latency histograms, database acquisition and inventory-lock histograms, transaction/cart-snapshot timings, primary-pool gauges, reporting success, and authentication-retention success.

New queue diagnostics on the existing private `/metrics` endpoint are:

| Metric | Meaning |
| --- | --- |
| `commerce_queue_pending{queue="outbox"}` | Committed outbox rows without a publication acknowledgement recorded in PostgreSQL |
| `commerce_queue_pending{queue="notifications"}` | All pending notification jobs, including delayed retries and jobs waiting for expiry cleanup; not a count of immediately deliverable messages |
| `commerce_queue_oldest_pending_seconds{queue=...}` | Age since creation of the oldest pending job at sample time; zero for a successfully sampled empty queue |
| `commerce_reliability_sample_success` | Whether the most recent collection attempt succeeded |
| `commerce_reliability_last_success_seconds` | Unix timestamp of the last successful collection, zero before any success |
| `commerce_reliability_sample_failures_total` | Failed/expired collection attempts in this process lifetime |

Collection uses one additional lazy database connection per gateway replica, separate from the primary commerce pool. Include it in connection-capacity calculations. Sampling is read-only, cached for ten seconds, and limited to 250ms acquisition, 250ms per statement, 100ms lock waits, and a 750ms overall collection deadline. A failed query retains the previous observation and marks sampling unsuccessful. Before a first success, queue values are absent. No customer IDs, payloads, SQL errors, or secrets become metric labels.

The dashboard hides queue values when the latest attempt failed or the last successful sample is older than 30 seconds. Missing data is not an empty queue. Last-success timestamps of zero are shown separately as never successful. Queue sampling does not query NATS consumer lag, engagement backlog, or search freshness; those remain coverage gaps.

The existing alert rules also flag a running gateway whose queue sampling is failing or stale for two minutes. This is a telemetry-availability signal, not a calibrated queue-delay SLA.

HTTP error counters measure server 5xx responses, not all customer-visible failures. The runner separately records 4xx, 5xx and transport errors. Server histograms have finite bucket resolution; small-sample p99 estimates and values beyond their largest finite bucket must not be treated as precise measurements.

## Run the isolated baseline

Requirements: local Unix-socket Docker context with Compose, Rust 1.94.0, Python 3, and the project's locked Cargo dependencies. The runner has no target-URL/database flags. It does not read your `.env`, inherit application secrets, use existing provider volumes, or send external notifications.

From the repository root:

```sh
python3 commerce-ops/scripts/commerce-reliability.py --analytics-faults --async-faults --concurrency 1,4,8 --iterations 5
```

It builds the native debug gateway, analytics-worker, seed-admin and sync-reports binaries, starts six isolated Docker providers with fresh credentials and loopback ports, creates synthetic data, waits for authoritative `/ready`, runs the existing HTTP acceptance suite, then measures the requested concurrency levels and reporting interference. Each worker performs five sequential journeys by default: product read, cart snapshot, add one item, quote, place order. Each shopper has its own product to measure unrelated-cart concurrency. The acceptance suite separately races customers for the same remaining stock and concurrently replays a checkout key.

For optimized measurements on a controlled host:

```sh
python3 commerce-ops/scripts/commerce-reliability.py --profile release --concurrency 1,4,8 --iterations 20
```

This is a closed-loop workload: concurrency is fixed and clients wait for responses. It does not model an open arrival rate or demonstrate maximum sustainable throughput. Levels are exploratory, not claims about normal/peak production traffic. Fixtures are intentionally small. Authentication setup is outside the timed workload, and there is no browser, TLS/ingress, real email, AI, or payment-provider traffic. Native gateway resource use is not container-limited; provider resource limits and host/Docker resources are recorded. Debug measurements are development/correctness evidence only.

## Acceptance and evidence

Use `--output output/YYYY-MM-DD-purpose/evidence/baseline` for a new run created
with the [output-run helper](../reference/workspace-cleanup.md#retained-evidence).
The supplied directory must not already exist. Omitting `--output` retains the
compatibility default `.local/commerce-reliability/<run-id>/`.

The evidence directory contains:

- `report.json`: run status, workload, source digest, binary digests, provider identities/resources, per-operation successful-request p50/p95/p99, all-request status counts, order throughput, persisted invariant checks and reporting-process overlap.
- `source-manifest.json`: exact relevant source-file hashes, including uncommitted files. Source changes during a run invalidate the result.
- `*-samples.json`: individual synthetic operation timings and response classifications, without request bodies or credentials.
- `*.prom`: metric snapshots before and after each stage.
- Private build, gateway and provider logs plus generated Compose configuration. These can contain synthetic authentication codes or credentials and must not be published.

Success requires the existing last-stock and checkout-replay acceptance checks, every planned purchase completing, unique returned order IDs, matching persisted order counts, matching COD amounts/currencies, complete inventory allocations, exactly one recorded order event per order, expected stock decrements, and empty carts after the successful workloads. Reporting interference additionally requires successful report processes overlapping the workload. HTTP success alone cannot pass the run. A failed or uncertain write is recorded and stops that shopper; it is not automatically retried.

The runner removes only its generated project's containers and volumes on normal completion or handled failure, retaining private evidence. If forcibly killed, use the generated `compose.json` and the exact project name recorded in its directory to clean up that run; never use a development/production project. Hard termination cannot guarantee cleanup.

There is deliberately no new universal latency SLA. Compare results only for matching build profile, host/resources, fixture and workload. Establish latency/error/backlog targets from representative traffic and product requirements after reviewing this first baseline. A successful small synthetic run is not a production capacity certification.

## Verification

```sh
python3 -m unittest commerce-ops/scripts.tests.test_commerce_reliability
cargo +1.94.0 test --manifest-path commerce-api/rocento-api/Cargo.toml --locked -p api-gateway --lib reliability::tests
python3 commerce-ops/scripts/check-documentation.py
```

The Rust SQLx tests require an isolated migrated PostgreSQL test database and a role allowed to create disposable test databases. They check pending-only sampling and explicit failure/staleness behavior. The manual **Commerce reliability baseline** workflow runs the complete harness and uploads only the sanitized report, source manifest, timings and metrics. Existing recovery and checkout integration suites remain the broader correctness coverage.

When either fault mode is enabled, initial HTTP acceptance and fixture authentication use console notifications. Before measured purchases, the runner records the exact bootstrap order event IDs and waits for every one to have an `order-notifications-v1` receipt. It then restarts the gateway with `NOTIFICATION_MODE=mailpit` and `MAILPIT_URL=http://127.0.0.1:1`, a deliberately unreachable loopback endpoint. Only those recorded bootstrap events are exempt from queued-job assertions. Every subsequent measured or fault-scenario order must have its own event-ID notification job, with matching aggregate job and receipt counts. The reports mark `external_delivery_verified=false`: this verifies durable enqueueing, not email delivery.

With `--analytics-faults`, the runner kills the analytics process, buys during the outage, stops ClickHouse, restarts the gateway and verifies commerce readiness, checks reporting returns retryable 503, and buys again. At each outage stage, before restoring analytics or ClickHouse, it requires all notification receipts and the expected jobs described above. Restoring ClickHouse must recover worker readiness, complete reporting, all logical order facts and `order-analytics-v2` receipts without changing confirmation counts. Another worker restart must preserve those counts without restarting commerce. The manual workflow includes these checks. Results are included in `report.json` and `analytics-isolation.json`.

See [process ownership, deployment and rollback](../../backend/architecture.md#reporting-and-analytics-process-boundary).

## Asynchronous queue operations

The gateway adds `commerce_outbox_retrying` (unpublished rows with at least one completed attempt) and `commerce_notifications_failed` (retained terminal notification failures). Both use the existing bounded, cached, read-only collector and its success/freshness signals. Retry counts do not measure connection failures before an event is selected. The dashboard shows these separately from pending counts. Alerts flag an outbox oldest age over 120 seconds for two minutes and retained failed notifications for two minutes; these are initial operational thresholds, not calibrated business SLAs. Terminal notification counts include history until its applicable retention/cleanup policy removes it.

For an outbox alert, inspect only IDs, event types, attempts, timestamps and `last_error` first. Check NATS health and the oldest pending age. An event remains pending through broker errors and process restarts. Restore the dependency and allow automatic retry; do not clear `published_at` on already-published events or regenerate event IDs. If a corrected pending event needs an immediate retry, an operator may set only that verified row's `available_at=clock_timestamp()` with a `published_at IS NULL` predicate after reviewing the cause. Payload repair requires domain review; payloads can contain personal information and must not be pasted into logs, alerts or tickets.

For failed notifications, inspect the fixed failure code and purpose, then fix the delivery configuration or recipient through the owning workflow. Terminal rows have scrubbed payloads: changing their status back to pending cannot safely reconstruct the original notification. Authentication flows should create a new challenge through their normal API. A business-message resend needs explicit authorization and a reviewed domain workflow; do not delete consumer receipts to force a resend. Outbox recovery and SMTP acceptance are distinct outcomes.

`--async-faults` stops the runner-owned NATS provider, purchases during the outage, kills/restarts the gateway publisher, and checks that committed backlog survives. It restores NATS and requires all pending events to drain, matching logical order facts, independent analytics and notification receipts, and one confirmation job per order except the explicitly recorded console bootstrap events. It then republishes an already-consumed order without `Nats-Msg-Id`, waits for acknowledgements from both `order-facts-v1` and `order-notifications-v1` durables, and verifies unchanged business-effect counts, including the duplicate event's physical ClickHouse fact count. Evidence is saved as `async-recovery.json` and inside `report.json`; the manual workflow runs and uploads this scenario. The test uses only fresh local providers and synthetic data and does not verify external delivery.

Focused SQLx regressions in `tests/outbox.rs` cover the additive migration, scheduled failure/recovery, a later event progressing past a deferred one, simultaneous publishers, timeout, invalid subjects, and cancellation after simulated broker acceptance. Existing notification tests cover retries, payload scrubbing and receipt/job atomicity. Run these against disposable databases; the live-provider notification test remains opt-in. These checks do not certify production queue capacity or lossless recovery after deletion of broker/database storage.

## Profiling measured bottlenecks

Use `--sql-profile` with the isolated runner to enable `pg_stat_statements` only on its disposable commerce PostgreSQL provider. The runner preserves the provider's existing durability settings, loads the extension, resets statistics immediately before each measured stage, and saves the 100 statements with the most total execution time in private `*-sql-profile.json` files. These contain normalized query text and are intentionally excluded from workflow artifact uploads. Do not publish them without review. This flag is recorded in `report.json` and must match between before/after comparisons.

SQL statistics include concurrent workers and nested PostgreSQL function statements. Timings measure database execution, including applicable server-side waits; they exclude network transit and Rust processing. They cannot be summed as exclusive per-request latency because nested statements overlap. Compare request percentiles, completed purchases, invariant checks and exact candidate manifests alongside query counts. Use the same concurrency, iterations, profile and resources for both candidates, and distinguish debug development measurements from production capacity claims.

Example: `python3 commerce-ops/scripts/commerce-reliability.py --sql-profile --concurrency 1,4,8 --iterations 30`. Do not run comparison workloads concurrently with one another or with Rust test builds. The current cart-market optimization combines three provenance reads into one statement inside the existing transaction, preserving market/revision/currency checks and explicit missing-setting errors. It adds no application cache or pool-size increase.

### Step 5 development comparison

The accepted frozen-source pair is reference `5536a9a633574058b5caee074a55f756` and candidate `bbb68130b9974d6f92d2e1b3f8c6ad0a` under `.local/commerce-reliability/`. Both used debug binaries, SQL profiling, concurrency 1/4/8 and 30 purchases per shopper, plus reporting interference: 630 measured purchases each. Source manifests differ only in the market-context implementation. An earlier repeat invalidated by concurrent mobile-test edits was excluded; the frozen pair used independent copied build artifacts.

| Workload | Checkout p95, reference → candidate | Orders/second, reference → candidate |
| --- | --- | --- |
| 1 shopper | 54.6 → 51.4 ms | 12.45 → 11.38 |
| 4 shoppers | 62.6 → 46.5 ms | 32.86 → 35.85 |
| 8 shoppers | 74.9 → 68.8 ms | 47.66 → 49.40 |
| 8 shoppers with reporting | 75.4 → 79.3 ms | 44.20 → 43.87 |

The eight-shopper stage made 1,920 market-context calls: 5,760 statements before versus 1,920 afterward, saving 3,840 database round trips. Functional checks passed for both workloads. The timing results are mixed: normal concurrent throughput improved, while single-shopper throughput declined and reporting-under-load showed no clear benefit. These are development observations on a shared host, not statistical proof or production capacity measurements. Further reporting optimization requires its own profiling; do not infer a universal latency improvement from fewer queries. Focused regression coverage passed 68 tests across market context, market publication, checkout and inventory concurrency.

## Release verification

Step 6 packages exact native binaries once, then verifies those copies without rebuilding. Run:

```sh
python3 commerce-ops/scripts/commerce-release.py package --output .local/commerce-release/candidate --profile release
python3 commerce-ops/scripts/commerce-release.py verify --candidate .local/commerce-release/candidate
```

The output directory must be new. Packaging runs the Rust architecture gate, builds with Rust 1.94.0 and `--locked`, and records the Git revision, source-file digest (including uncommitted Rust changes), migration hashes, host platform, profile and SHA-256 of the gateway, analytics worker, engagement worker, admin seeder and report refresh executable. Read-only executable copies prevent later Cargo builds from replacing the tested binaries. These are local integrity records, not signatures or Docker image digests. Do not use a Git revision alone to identify a dirty-worktree build.

Verification rejects missing, changed, incompatible-platform or incomplete bundles before starting providers. It creates fresh isolated commerce and engagement databases, checks gateway and analytics readiness, starts the engagement worker and requires its heartbeat/projection health. It then requires HTTP checkout acceptance, concurrent commerce invariants, reporting overlap, analytics outages and broker recovery/duplicate delivery checks. Engagement health and all bundle hashes are checked again before success. Applied commerce and engagement migration versions and the release manifest are embedded in `report.json`; the verifier's own source digest is recorded separately. Cleanup failure also fails the run.

The **Commerce release verification** workflow runs on relevant pull requests and by manual dispatch. It builds and verifies the release container image as described below, and uploads only manifests and sanitized acceptance reports. Configure `Commerce release verification / verify` as a required repository check if merges must be blocked; adding the workflow does not change branch protection. Use debug packages for faster local correctness checks only.

This gate covers native commerce, analytics and engagement processes with disposable providers. It does not deploy a store, publish an image, certify a container image, exercise export jobs, or test existing-data upgrades. Rollback rehearsal is excluded by request. A passed native bundle is evidence for that exact build; a separately built deployment image still needs its own image identity and installation smoke checks before promotion. Keep private `build.log`, provider/service logs and generated Compose credentials out of shared artifacts.


### Exact deployment-image verification

The image gate uses the existing `commerce-api/rocento-api/Dockerfile`, including its release build, all eight packaged executables and non-root runtime user. It freezes the backend context before building so unrelated workspace edits during compilation cannot change the image inputs. Context-file hashes include the Dockerfile and lockfile; no target directory or environment files are copied.

```sh
python3 commerce-ops/scripts/commerce-release.py build-image --output .local/commerce-release/image-candidate
python3 commerce-ops/scripts/commerce-release.py verify-image --candidate .local/commerce-release/image-candidate
```

The build records `release-image.json` with the immutable local image ID, available registry digests, architecture, source fingerprint, Git revision and executable hashes. A locally built image normally has no registry digest until published: its `sha256:` image ID is a local content identity, not a registry manifest digest. The gate runs by that ID with `pull_policy: never`, so moving a tag cannot replace the candidate. It checks source labels, non-root user and executable hashes before and after verification.

Gateway, analytics and engagement run in containers connected only to the generated provider project, with 1 CPU and 512 MiB per application container. Seeder and reporting commands execute inside the same gateway image. The existing checkout, reporting and outage scenarios operate through loopback-published ports; both database migration histories and worker health must pass. All runner-owned containers and volumes are removed afterward, while the image and private build context remain available for review. Never upload service/build logs or generated Compose configuration.

The workflow now uses this image gate. Local ARM64 evidence applies to Linux ARM64; an x86_64 deployment needs its corresponding image built and verified on that architecture. This gate still excludes storefront/AI/ingress, export-job execution, existing-data upgrades and external email/payment delivery. It neither publishes an image nor deploys a store. Promote only the tested image, recording its registry digest after publication, and perform installation smoke checks before expanding rollout. No rollback rehearsal is performed.


### Export-worker health

`export-worker --health` is a read-only probe with a four-second overall deadline. It requires a worker progress file updated within the last 120 seconds and successful access to the export queue through a dedicated one-connection database pool. The worker clears stale state on startup and refreshes progress after successful queue claims/polls and successful export progress updates. Idle workers therefore remain healthy; a stalled loop, stale progress, database outage or inaccessible queue fails the probe.

Compose checks every 15 seconds with a five-second timeout, three retries and a 30-second startup grace period. Docker reports unhealthy status; this does not itself restart a container. Large exports must keep making progress within the 120-second window. The image gate starts the export worker, rejects an unreachable-database probe, freezes the disposable worker to verify stale-progress rejection, resumes it and requires healthy recovery. Production rollout waits for active exports to finish before replacing a worker.

### Engagement outbox compatibility repair (2026-10-11)

The shared retry-aware publisher also runs against each isolated engagement database. Those databases need `attempts`, `available_at`, `last_attempt_at`, `last_error`, and the pending-row index, just like the commerce outbox. Missing columns caused `outbox publisher reconnecting; events remain durable` warnings every five seconds even while the engagement heartbeat healthcheck passed.

`commerce-api/rocento-api/engagement-migrations/20261011030000_outbox_retries.sql` supplies the missing additive schema. Its idempotent additions support live repair while retaining the existing image and its embedded migration ledger. Do not register a migration unknown to a currently deployed image: SQLx validates applied migration versions at startup. A subsequent image built from this source will adopt and register the migration normally. Existing migration checksums must remain unchanged.

Regression coverage: `cargo +1.94.0 test --locked -p infra-events --test engagement_outbox` against disposable PostgreSQL exercises engagement migrations, retry deferral, stable event identity, publication, and adoption of an already-repaired schema. Operational verification must also inspect engagement publisher warnings and its separate database outbox; heartbeat readiness alone does not prove the publisher is functioning.


### Reporting recovery retry

The analytics reporting worker retries a skipped snapshot lock or failed snapshot
after five seconds. Successful snapshots retain the configured 30–1800 second
interval. This prevents event replay or a brief provider failure from postponing
report recovery for the entire normal interval. The database-backed reporting
regression exercises both lock contention and provider failure; the exact-image
outage scenario also requires reporting freshness to recover.
