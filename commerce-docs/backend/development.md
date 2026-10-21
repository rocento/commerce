# Backend development and checks

Use the repository toolchain and locked dependencies. The [Dockerfile](../../commerce-api/rocento-api/Dockerfile) builds with Rust 1.94 and ships the gateway plus analytics/engagement workers and seed/report/export/catalog-data binaries under user 10001, exposing port 8080.

From the repository root:

```sh
cd commerce-api/rocento-api
cargo run -p api-gateway --bin api-gateway
```

Run `cargo run -p api-gateway --bin analytics-worker` in a second terminal with PostgreSQL, NATS and ClickHouse configured, or start the Compose service. Reporting refreshes and order/cart analytics run in that worker; independent order and shipment notification consumers run in the gateway using its validated `NOTIFICATION_MODE`. The analytics worker does not need notification configuration. It uses `ANALYTICS_BIND_ADDRESS` (default `0.0.0.0:8082`) and `REPORTING_INTERVAL_SECONDS` (default 900, clamped to 30–1800); keep its health/metrics port private. M14 native test helpers also require the analytics-worker binary to be built.

`BIND_ADDRESS` defaults to `0.0.0.0:8080`. Without `DATABASE_URL`, only foundation liveness is available and `/ready` returns 503. Configured startup connects PostgreSQL and applies embedded migrations. Use [platform local setup](../platform/operations/local-setup.md), `.env.example` and Compose for a coherent dependency set rather than guessing service secrets.

| Inputs | Purpose |
| --- | --- |
| `DATABASE_URL` | Authoritative commerce PostgreSQL; startup migrations |
| `DB_MAX_CONNECTIONS`, `DB_ACQUIRE_TIMEOUT_MS` | Primary pool defaults 10 connections and 3000ms acquisition; ranges 2–200 and 100–30000ms; size across all replicas against PostgreSQL capacity |
| `HTTP_MAX_IN_FLIGHT`, `HTTP_REQUEST_TIMEOUT_MS` | Per-process handler admission defaults 256 and 30000ms; ranges 1–4096 and 100–120000ms; liveness/readiness/metrics probes bypass admission |
| `PUBLIC_SUPPORT_TOTAL_LIMIT`, `PUBLIC_ASSISTANT_TOTAL_LIMIT`, `PUBLIC_MEMORY_TOTAL_LIMIT`, `PUBLIC_ANALYTICS_TOTAL_LIMIT` | Installation quotas per 15 minutes, shared across gateway replicas; defaults 2000, 3000, 12000, 100000 |
| `AUTH_SECRET`, `COOKIE_SECURE`, `ALLOWED_ORIGINS`, `STOREFRONT_URL` | Identity, secure-cookie and origin protection |
| `AUTH_IP_RATE_LIMIT_MODE` | `peer` by default; `ingress` requires a private gateway and client-IP throttling at ingress |
| `PASSWORD_HASH_MAX_CONCURRENCY`, `PASSWORD_HASH_WAIT_TIMEOUT_MS` | Process-wide Argon2 budget; defaults 2 workers and 250ms waiting; ranges 1–32 and 1–5000ms |
| `NATS_URL` | JetStream events and consumers |
| `MEILI_URL`, `MEILI_MASTER_KEY` | Search integration |
| `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | S3-compatible media |
| `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD` | Analytics/reporting |
| `RESERVATION_TTL_SECONDS` | Inventory reservation lifetime |
| `APP_ENV`, `NOTIFICATION_MODE`, `MAILPIT_URL`, `NOTIFICATION_FROM` | Notification/security environment |
| `ASSISTANT_*` | Tenant-bound assistant infrastructure; [AI configuration](../ai-service/configuration.md) |
| `PUBLICATION_*` | Approved merchant deployment identity; [publication](publication.md) |

Inspect the owning module for exact accepted configuration. Never commit environment secrets or transfer general commerce credentials to the Python AI service.

[Security configuration](../../commerce-api/rocento-api/crates/api-gateway/src/config.rs) is validated before database connections, migrations, listeners, or workers. `APP_ENV` accepts `development`, `staging`, or `production` and defaults to production. Database-backed production/staging requires `COOKIE_SECURE=true`, an explicit HTTPS storefront origin, explicit HTTPS allowed origins, and SMTP notifications. Wildcards, credentials, paths, queries, fragments, and loopback production origins are rejected. `COOKIE_SECURE` accepts only `true` or `false`; development retains localhost defaults. Configuration errors identify the setting without printing its value.

Password work uses at most the configured execution slots plus twice as many waiting requests. Full queues or wait timeouts return HTTP 503 with `Retry-After: 3`. The execution slot stays held until blocking work finishes even if its HTTP caller disconnects. Account/IP throttles still return their existing 429 responses. Run authentication-heavy tests with `--test-threads=2` so parallel fixtures do not intentionally exhaust the default production budget.

Handler saturation, handler deadlines, inventory lock/query timeouts and database acquisition timeouts return sanitized HTTP 503 with `Retry-After: 3`. Request tracing wraps admission so these responses still carry trace IDs and contribute to error metrics. Handler deadlines stop awaiting a response; they are not a global PostgreSQL query deadline or a deadline for streamed response bodies. Inventory transactions separately bound server-side statements and lock waits. Clients must use the operation's existing idempotency key when retrying a write with an uncertain outcome.

Public support, assistant, memory and analytics admission atomically checks visitor/customer, source and installation buckets; a rejected request consumes none of them. Per 15 minutes, subject/source limits are respectively 20/100, 120/480, 120/600 and 1000/4000. `PUBLIC_ASSISTANT_TOTAL_LIMIT` accepts 120 through 1000000, preserving existing installation caps; the other installation limits accept their route's source allowance through 1000000. A lower installation cap can constrain an individual customer's or visitor's allowance. Peer mode uses the socket peer and ignores forwarded IP headers. Ingress mode requires the managed private gateway boundary: Nginx enforces source limits of 6/32/40/240 requests per minute with bursts 10/10/60/60, while PostgreSQL still enforces subject and installation quotas. Assistant chat's 120-request allowance does not change assistant-memory quotas, concurrent-turn limits or model-token budgets. Visitor cookies are HttpOnly, SameSite=Strict and secure when configured. Rotating a cookie does not reset source or installation quotas. Tune these limits against measured legitimate traffic.

Authentication retention deletes expired sessions/challenges and obsolete rate-limit keys only after a one-day grace period, in batches of 500 per table. It skips locked rows, retries transient failures and exposes last-success, failure-count and oldest-due-age metrics under `commerce_auth_retention_*`. Alert on stale success or increasing backlog; process readiness alone does not prove retention is keeping up.

## Checks

Run `python3 commerce-ops/scripts/checks/check-rust-architecture.py` and `python3 -m unittest commerce-ops/scripts.tests.test_rust_architecture` from the repository root before backend changes. The [module-boundary policy](architecture.md#enforced-rust-module-boundaries) is enforced in CI; adding a crate or dependency requires an explicit ownership review.

From `commerce-api`:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo build --workspace --locked
cargo test --workspace --locked -- --test-threads=2
```

Database-backed tests need the intended isolated PostgreSQL `DATABASE_URL` with required migrations. Use focused gateway suites first, for example `cargo test -p api-gateway --test catalog --locked`, `--test branch_setup`, `--test fulfillment_admin`, `--test markets`, `--test languages` or `--test themes`. Search stock batching is covered by `--test search_stock`; cached readiness and worker failures by `--test readiness`, with task supervision unit checks at `--lib workers::tests`. Database-free or skipped integration tests do not establish transaction behavior.

From the repository root, `python3 commerce-ops/scripts/checks/check-migration-history.py` checks version uniqueness/history, and `python3 commerce-ops/scripts/checks/check-documentation.py` checks documentation destinations. Inspect script options before applying migration upgrades or seed data. Local unit tests are not proof of live provider, storage, edge or customer acceptance.

The Phase 3 expiry regression suite is `cargo test --locked -p api-gateway --test reservation_expiry -- --test-threads=4`. Use an isolated PostgreSQL database for its fixtures. It covers backlog bounds, refresh deduplication, transactional event preservation, live area reads while cleanup is pending, scoped renewal/removal, last-unit concurrency and wishlist receipt replay. `infra-observability` unit tests verify fixed timing labels/outcomes and metric compatibility; `infra-db` tests exercise actual pool contention, ownership and acquisition timeout classification.

The Phase 4 snapshot suite is `cargo test --locked -p api-gateway --test cart_snapshot -- --test-threads=4`. Its isolated fixtures cover batch boundaries through 200 lines, pending expiry, product fallbacks, selling-rule error order, bundle atomicity and exact wishlist replay. A binary-local asynchronous read/write gate isolates metric-delta assertions from other snapshot producers while allowing ordinary snapshot tests to run together. Snapshot metrics no longer require a serial-test override; the authentication fixture concurrency budget described above still applies. `AUTH_INGRESS_NGINX_TESTS=1 python3 -m unittest commerce-ops/scripts.tests.test_auth_ingress` runs the disposable Nginx fixture for metrics restriction, normalized/encoded paths and authentication throttling.

The [cart-read-budget example](../../commerce-api/rocento-api/crates/api-gateway/examples/cart-read-budget.rs) records PostgreSQL statement counts and warm read timings for the same 1-, 20- and 200-line fixtures before and after a reader change. It requires the exact owned local `phase4_budget` database on port 57434 and refuses other database URLs. Enable `pg_stat_statements` in that isolated PostgreSQL instance before running `cargo run --locked -p api-gateway --example cart-read-budget -- before OUTPUT.json`, then `after` with a different output file against the same fixtures. This debug-build measurement establishes query-count changes, not production throughput.

### Order display statuses

Migration `20261004060000_order_status_management.sql` adds definitions, label assignments and history alongside the existing workflow. It backfills existing orders and a database trigger assigns the stage default on every state transition, including shipment and payment writers. `Order.status` stays the engine state; `status_display` supplies the safe display label and translations. Customer projections never serialize internal labels. Built-in labels include Pending, Confirmed, Processing, Shipped, Delivered, Complete (cash collected), Canceled, Delivery failed, Ready for pickup and Picked up, with English and Arabic defaults.

The design follows [Adobe Commerce's state/status distinction](https://experienceleague.adobe.com/en/docs/commerce-admin/stores-sales/order-management/orders/order-status). Rocento only exposes stages supported by its existing COD workflow: Adobe payment-review, hold/unhold and closed/refunded states are not introduced as unsupported operational actions. Refunds retain their existing payment records and rules.

Configuration uses `GET/POST /v1/admin/order-statuses` and `PUT /v1/admin/order-statuses/{code}`. Per-order labels use `GET/POST /v1/admin/orders/{id}/status-label`. Changes require reasons and expected revisions; conflicts return 409. Stage/code immutability and default/archive rules are server enforced. Registry writes and assignments serialize through a transaction advisory lock; assignments also lock the order row. Public display definitions and authenticated management schemas are included in the reviewed OpenAPI projections.

Validate against an isolated database with `cargo test --locked -p api-gateway --test order_statuses --test order_sales -- --test-threads=1`, plus `cargo test --locked -p domain-orders --lib statuses::tests`. Deploy the migration with the gateway before the frontend. No application database is changed by the implementation checks.
