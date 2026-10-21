# Backend architecture and crate map

[Cargo.toml](../../commerce-api/rocento-api/Cargo.toml) defines a Rust 2021 workspace with `crates/*`. Axum/Tokio compose HTTP and async work; SQLx/PostgreSQL owns transactional commerce data. Domain crates own business rules and application use cases. Infrastructure crates own auth, database access, event transport, media and observability. Gateway handlers authenticate, admit input, invoke owning services and map transport responses.

[Gateway startup](../../commerce-api/rocento-api/crates/api-gateway/src/main.rs) validates security settings and notification transports, initializes observability, optionally connects to `DATABASE_URL`, applies embedded forward migrations and wires identity, commerce, admin and publication routers. A database-free process serves foundation liveness but is not ready for commerce. Configured startup also needs its media, search and commerce-worker dependencies; merely setting a database URL is insufficient.

[Worker supervision](../../commerce-api/rocento-api/crates/api-gateway/src/workers.rs) assigns a name to each long-running task. Workers own retries for transient dependency failures. An unexpected return, panic, or cancellation immediately invalidates readiness and triggers graceful HTTP draining, worker cleanup, and a nonzero process exit so deployment can restart the gateway. Worker readiness reports task health; dependency outages and stalled jobs need their own operational monitoring.

| Area | Gateway source under `commerce-api/rocento-api/crates/api-gateway/src` |
| --- | --- |
| Identity and permissions | `identity.rs`, `admin_depth.rs` |
| Catalog and attributes | `catalog.rs`, `attributes.rs` |
| Cart, checkout and orders | `cart.rs`, `orders.rs` |
| Delivery and capacity | `areas.rs`, `capacity.rs`, `msi.rs` |
| Markets and localization | `markets/`, `markets.rs`, `market.rs`, `localization/` |
| Themes and navigation | `themes.rs` |
| Support and segments | `support.rs`, `segments.rs` |
| Grids, exports and reporting | `grids.rs`, `exports.rs`, `reporting/`, `analytics.rs` |
| Order and shipment notification consumers | `commerce_notifications.rs` |
| Merchant queries and customer journey | `merchant/`, `customer_journey.rs` |
| Assistant delegation and trust | `assistant.rs`, `assistant_trust.rs`, `assistant_compound.rs` |
| Public snapshots and discoverability | `public_commerce/`, `discoverability.rs` |
| Process readiness | `readiness.rs` |

Authoritative transactions and receipts remain in Rust. Node renders public storefront documents from typed snapshots, and Python consumes narrowly delegated commerce capabilities. Neither side receives general authority from language or UI state. Shared schemas should represent existing domain contracts rather than duplicating business rules in callers.

[Wishlist transfer](../../commerce-api/rocento-api/crates/domain-cart-checkout/src/wishlist.rs) is a checkout application command: cart/inventory/wishlist changes, the replay claim, and the saved receipt commit together. The gateway retains admission, authentication and audit. Canonical product IDs bind a request to its payload; saved JSON receipts replay unchanged across releases. [Typed stale proposal errors](../../commerce-api/rocento-api/crates/domain-cart-checkout/src/error.rs) replace message-text classification while preserving existing HTTP bodies and delegation failure states. Other legacy validation errors remain unchanged.

[Scoped inventory transactions](../../commerce-api/rocento-api/crates/domain-inventory/src/locking.rs) allow independent cart and checkout commands, and order transition/refund/dispatch commands, to proceed concurrently. Lock order is the shared maintenance barrier, shared catalog barrier, sorted cart owner identities, cart/order rows, then sorted product keys. Cart commands lock existing lines and reservations plus every product they may add before reading allocation facts. This preserves last-unit exclusion and serializes guest merges even before a customer cart exists. Catalog writers retain their exclusive barrier. Bulk inventory/configuration, expiry and compound commands still use the exclusive maintenance barrier; these remain a scaling constraint to measure under load. Inventory transactions have a two-second lock wait limit and a 15-second per-statement limit. Deferred split-capacity confirmation (capacity enabled without checkout holds) takes a common confirmation lock before its group bucket locks, preventing opposite-window lock inversions. This narrow confirmation path remains serialized; pre-held capacity and unrelated cart work can proceed independently.

Idempotent checkout replay releases its cart scope and returns a repeatable-read order snapshot, preserving a consistent status/payment/history view during concurrent lifecycle updates. Wishlist transfer takes the shared wishlist mutation lock before checking current membership, so a concurrent removal cannot be silently transferred.

Guest merges reject a union exceeding 200 distinct cart lines before releasing holds or changing either cart. Overlapping lines count once. Reallocation uses the cart's global or delivery-area sources, preserves eligible existing holds and counts shared sources once.

[Reservation expiry](../../commerce-api/rocento-api/crates/domain-inventory/src/expiry.rs) runs in batches of at most 100 holds under the existing inventory transaction lock. A full batch commits and yields for 50ms before draining more; idle/error polling remains every two seconds. Every expired hold retains its release and stock-update events, while each affected product is refreshed once per batch. Cart commands perform exact-key expiry classification when replacing/removing a hold instead of sweeping unrelated reservations. Deletion and expiry classification use one SQL statement, and failed cart operations preserve their prior holds through the transaction boundary.

[Availability reads](../../commerce-api/rocento-api/crates/domain-inventory/src/availability.rs) subtract only live reservations from enabled, in-stock sources, independently of the cleanup backlog. Area membership uses `EXISTS` so a source linked through multiple stocks contributes once. Area search reads remain bounded to 20 product candidates; default-stock reads keep their existing semantics. Read-only cart snapshots and replenishment warehouse quantities use live allocation facts too.

[Cart snapshots](../../commerce-api/rocento-api/crates/domain-cart-checkout/src/snapshot.rs) load current product facts, live holds, selling rules and stock in batches of at most 20 products on the caller's transaction. Delivery-area context is resolved once, and line assembly runs in memory before one pricing assessment. Stored name/unit and missing-product fallbacks, exact money, currency errors and live expiry semantics are preserved. Bundle, wishlist transfer and shopping proposal commands mutate their lines before constructing one final cart response; the existing inventory transaction continues to own rows, reservations, events and replay receipts together. Checkout product validation and market facts retain their existing queries and safety checks.

[Internal timings](../../commerce-api/rocento-api/crates/infra-observability/src/timing.rs) expose fixed operation/result histograms for inventory transaction pool acquisition, inventory lock acquisition, selected transaction lifetimes, cart snapshots, and expiry batch execution/size. Pool acquisition includes SQLx connection health/opening but excludes `BEGIN`; lock acquisition includes its query round trip; scoped cart timing includes owner, row and product lock acquisition and the queries that discover those keys. Transaction durations cover cart open/set/remove/clear, coupons, bundles, delivery and measured quantities, checkout quote/place, reorder, wishlist transfer, shopping/execution/trust inventory transaction owners, and expiry after acquiring the lock, through the awaited commit. Shared helpers receiving a transaction do not start another transaction timer. Snapshot timings include reading and assembling the response and pricing assessment, excluding transaction begin/commit. An unfinished application transaction is `aborted`; its timer does not claim to measure completion of SQLx's asynchronous implicit rollback. Snapshot errors are explicit `error`, while a cancelled snapshot is `cancelled`. Expiry timings and batch sizes describe attempted work, which an enclosing transaction may later abort. Pool size/idle/max gauges are sampled at acquisition and each metrics scrape. Labels never contain account, cart, product, query, credential or error-text values.

[EC2 ingress](../../commerce-ops/deploy/ec2/configure.py) returns 404 for normalized `/api/metrics` and its subpaths on all six store/admin API virtual hosts. Monitoring reads `/metrics` directly from the gateway's loopback port. This restriction is an ingress policy; the gateway route itself remains available to its internal callers.

## Workspace crates

- [api-gateway](../../commerce-api/rocento-api/crates/api-gateway): HTTP composition and route admission.
- [commerce-core-contracts](../../commerce-api/rocento-api/crates/commerce-core-contracts): Shared domain primitives and contracts.
- [domain-admin-iam](../../commerce-api/rocento-api/crates/domain-admin-iam): admin iam business rules and application services.
- [domain-admin-operations](../../commerce-api/rocento-api/crates/domain-admin-operations): admin operations business rules and application services.
- [domain-attributes](../../commerce-api/rocento-api/crates/domain-attributes): attributes business rules and application services.
- [domain-cart-checkout](../../commerce-api/rocento-api/crates/domain-cart-checkout): cart checkout business rules and application services.
- [domain-catalog](../../commerce-api/rocento-api/crates/domain-catalog): catalog business rules and application services.
- [domain-cms](../../commerce-api/rocento-api/crates/domain-cms): cms business rules and application services.
- [domain-customers](../../commerce-api/rocento-api/crates/domain-customers): customers business rules and application services.
- [domain-fulfillment](../../commerce-api/rocento-api/crates/domain-fulfillment): fulfillment business rules and application services.
- [domain-inventory](../../commerce-api/rocento-api/crates/domain-inventory): inventory business rules and application services.
- [domain-orders](../../commerce-api/rocento-api/crates/domain-orders): orders business rules and application services.
- [domain-payments](../../commerce-api/rocento-api/crates/domain-payments): payments business rules and application services.
- [domain-pricing-promotions](../../commerce-api/rocento-api/crates/domain-pricing-promotions): pricing promotions business rules and application services.
- [domain-reviews](../../commerce-api/rocento-api/crates/domain-reviews): reviews business rules and application services.
- [domain-search-client](../../commerce-api/rocento-api/crates/domain-search-client): search client business rules and application services.
- [domain-support](../../commerce-api/rocento-api/crates/domain-support): support business rules and application services.
- [domain-tax](../../commerce-api/rocento-api/crates/domain-tax): tax business rules and application services.
- [domain-theme](../../commerce-api/rocento-api/crates/domain-theme): theme business rules and application services.
- [infra-auth](../../commerce-api/rocento-api/crates/infra-auth): auth infrastructure.
- [infra-db](../../commerce-api/rocento-api/crates/infra-db): db infrastructure.
- [infra-events](../../commerce-api/rocento-api/crates/infra-events): events infrastructure.
- [infra-media](../../commerce-api/rocento-api/crates/infra-media): media infrastructure.
- [infra-observability](../../commerce-api/rocento-api/crates/infra-observability): observability infrastructure.
- [shared-kernel](../../commerce-api/rocento-api/crates/shared-kernel): Shared domain primitives and contracts.

## Reporting and analytics process boundary

The dedicated [analytics worker](../../commerce-api/rocento-api/crates/api-gateway/src/analytics_worker.rs) owns ClickHouse initialization, reporting snapshots, order/cart analytics consumers, and optional assistant telemetry collection. The gateway constructs a read client without contacting ClickHouse at startup. It retains authenticated reporting routes, commerce transactions, outbox publication, order and shipment notification consumers, and notification delivery. Analytics failure cannot fail gateway readiness or its worker supervisor, or block confirmation enqueueing.

The worker uses the same backend image with the `analytics-worker` command. Compose gives it a 512 MiB memory limit, one CPU, and no published port. Its database budget is four connections: three for order receipts/detail reads and health checks, and one dedicated to reporting snapshots. `/health` is liveness; private port 8082 `/ready` checks task health, PostgreSQL, NATS and ClickHouse with bounded probes. These checks do not certify consumer lag or report freshness. `/metrics` exposes `commerce_analytics_worker_ready` and reporting metrics under the Prometheus job `commerce-analytics`.

The order analytics consumer retains the `order-facts-v1` JetStream durable and its cursor, but writes PostgreSQL receipts under `order-analytics-v2`. It only projects ClickHouse facts. The gateway's independent `order-notifications-v1` durable starts with `DeliverAll` to process retained order events and commits its own receipt with the notification job before acknowledging each event. It checks historical `order-facts-v1` receipts to avoid recreating confirmations already handled by the former combined consumer. New analytics code never writes that legacy receipt namespace. Preserve all receipt history; a stable event-ID job key also prevents duplicate enqueueing while old and new consumers overlap. See [notification persistence](data-and-integrations.md#notifications).

Order and shipment consumers use the gateway's validated notification mode. The analytics worker no longer needs `NOTIFICATION_MODE` or SMTP credentials; an existing `NOTIFICATION_MODE` environment entry is harmless. Optional assistant telemetry needs the tenant and signing-key mount from `compose.assistant.yaml`; it uses a narrow telemetry client rather than initializing the commerce application.

Reporting routes retain authentication, authorization, range validation and response schemas. ClickHouse failure or a missing completed snapshot returns HTTP 503 with `Retry-After: 3`. If ClickHouse is available during a worker outage, the most recent completed report can still be returned; clients must display its existing generation/age metadata. Reporting reads still run through the gateway, and PostgreSQL/ClickHouse are shared infrastructure: this isolates background execution and failure supervision, not every resource contention source.

Deploy the gateway and analytics worker from the same image. No new migration, data copy, or durable subscription reset is required; do not delete or reset existing durables. Temporary mixed versions preserve enqueue deduplication, but analytics outages can still delay confirmations until the new gateway is running. Verify both readiness endpoints, progress of both order consumers, and a completed reporting generation after deployment. Confirm queue creation during a ClickHouse outage using the [isolated reliability runner](../platform/operations/commerce-reliability.md), not a production outage exercise.

Rollback across this ownership change requires coordination: pause order ingress, drain the outbox and both order consumers, then roll back the gateway and analytics worker together. If that drain cannot complete, retain the new notification consumer until outstanding confirmations are handled. A new analytics receipt does not prove notification completion, and the retained analytics cursor cannot replay events automatically for an older combined consumer. Preserve all receipts and queued jobs. When rolling back further to a gateway that itself owns analytics tasks, also stop the standalone analytics worker. This procedure is not an automatic or rehearsed rollback guarantee.

## Enforced Rust module boundaries

The reviewed [dependency policy](../../commerce-api/rocento-api/architecture-policy.json) classifies every workspace crate and lists its permitted direct internal dependencies. [The Rust architecture check](../../commerce-ops/scripts/check_rust_architecture.py) reads Cargo metadata rather than searching import text. CI rejects unclassified crates, unapproved internal edges, external local path crates, stale permissions, cycles and forbidden layer dependencies. Checks include renamed/inherited dependencies, optional dependencies, build/dev dependencies and every target platform. It runs offline without building or executing application code.

The composition layer (`api-gateway`, including its worker binaries) may assemble domain services and infrastructure. Domains cannot import HTTP/server/client or NATS transport crates directly; `domain-search-client` is explicitly classified as an adapter because it implements Meilisearch and event integration. Infrastructure cannot depend on domain/application crates. Contracts cannot depend on runtime, storage or transport infrastructure. The precise direct-edge list is intentionally conservative: extending it requires an ownership review and a policy change in the same PR, not automatic regeneration to make CI pass. Remove unused allowances when removing dependencies.

Current domain dependencies on `infra-auth` retain shared errors/security helpers; dependencies on `domain-admin-iam` retain permission/audit interfaces. Several domains use `domain-inventory` transaction and locking helpers. These existing edges are recorded, not disguised as completely independent domains. Moving those shared contracts is future work and must preserve error and lock behavior.

| Owner | Data and rules |
| --- | --- |
| `domain-catalog`, `domain-attributes` | Product/category publication, visibility and attribute definitions in `catalog` and `attributes` |
| `domain-inventory` | Stock, sources, areas, reservations, allocation and inventory lock protocols in `inventory` |
| `domain-cart-checkout` | Cart/quote/purchase orchestration, replay and wishlist transfer in `cart_checkout`; coordinates the atomic purchase |
| `domain-orders`, `domain-payments` | Immutable order snapshots and lifecycle in `orders`; COD obligations, collection and manual refunds in `payments` |
| `domain-fulfillment`, `domain-tax`, `domain-pricing-promotions` | Delivery/capacity policy, tax calculation and promotion rules in their respective schemas |
| `domain-customers`, `domain-admin-iam` | Customer identity/locations and administrator roles, permissions and audit in `customers` and `admin_iam` |
| `domain-cms`, `domain-reviews`, `domain-support`, `domain-theme`, `domain-mobile` | Content/translations, reviews, support, themes and mobile experience configuration in their respective schemas |
| `domain-admin-operations` | Administrative orchestration through the owning domains; does not become a second stock/catalog owner |
| `domain-search-client` | Derived search adapter; PostgreSQL domains remain authoritative |
| `infra-events`, gateway notification modules, dedicated workers | Shared `platform` outbox, durable receipts and job delivery; derived analytics belongs to the analytics worker |
| `infra-db`, `infra-auth`, `infra-media`, `infra-observability` | Database utilities, security primitives, object storage and telemetry adapters |
| `commerce-core-contracts`, `shared-kernel` | Shared values/contracts only; no transaction ownership |

### Cross-domain transactions

Checkout remains an in-process application command owned by `domain-cart-checkout`. Order creation, reserved-stock consumption, fulfillment confirmation, COD payment creation, cart clearing, outbox events and replay identity commit together on the existing PostgreSQL transaction. Participating helpers receive the caller's transaction; they must not independently commit or publish an external effect before it commits. Order cancellation, dispatch, collection and refund are owned by `domain-orders` and coordinate inventory, fulfillment and payments on the existing transaction. Wishlist transfer remains owned by `domain-cart-checkout`, including wishlist mutation locks, reservation changes and durable replay receipt.

Gateway handlers own HTTP parsing, admission, authentication and response mapping; business invariants belong in domain application methods and must remain valid for non-HTTP callers. The first incremental extraction moves bestseller publication eligibility into `domain_catalog::Service::storefront_visible`. It reads the same storefront projection and preserves active-parent filtering; availability and purchase authorization remain separate checks.

This gate enforces direct crate dependencies, not arbitrary SQL table ownership, transitive third-party behavior, Rust `include!` usage, or every handler's business logic. Existing cross-schema read projections and gateway-owned legacy queries remain migration debt. New writes should use the owning domain's command/transaction API; review cross-schema queries explicitly rather than treating shared PostgreSQL as permission to bypass invariants. HTTP routes, database schema and checkout transaction boundaries are unchanged by this step.

Run `python3 commerce-ops/scripts/check-rust-architecture.py` and `python3 -m unittest commerce-ops/scripts.tests.test_rust_architecture` from the repository root. PostgreSQL regression coverage includes `catalog_visibility`, `bestsellers`, `orders` (including late payment failure rollback and concurrent idempotent checkout), and `commerce_concurrency` under the API gateway integration tests. Use disposable test databases as described in [backend development](development.md).

## Asynchronous delivery and recovery

The transactional outbox in [infra-events](../../commerce-api/rocento-api/crates/infra-events/src/lib.rs) retains every committed event until JetStream acknowledges publication. Delivery is at least once. `Nats-Msg-Id` carries the original outbox UUID, but broker deduplication has a finite window: consumers must still enforce their own replay rules. A crash after remote acceptance and before the PostgreSQL commit can republish the same event. Retry scheduling allows later events to progress; neither the old concurrent publishers nor the new retry queue guarantees global ordering.

The publisher owns one additional lazy PostgreSQL connection per gateway replica, with a 500ms acquisition deadline. One due row is locked with `SKIP LOCKED`; statements have a one-second timeout and lock waits a 250ms timeout. Broker publication plus acknowledgement has a three-second deadline. Completed failures persist `attempts`, `last_attempt_at`, a fixed diagnostic code and `available_at`, with delays of 1, 2, 4, 8, 16, 32 and then 60 seconds. Connection/stream initialization retries every five seconds and does not increment per-event attempts before selecting an event. Events are never deleted or automatically marked published after repeated failures. Subject validation rejects empty segments and wildcard/invalid subject characters before contacting NATS.

| Consumer or queue | Existing recovery contract and audit result |
| --- | --- |
| Orders and shipment notifications | PostgreSQL `(consumer_name,event_id)` receipts commit with notification enqueueing, then the delivery is acknowledged. The independent order durable/receipt is `order-notifications-v1`; shipment durables retain their existing names. Preserve receipt history, including legacy `order-facts-v1` receipts. The recovery harness forces an order redelivery without a broker deduplication header and waits for both order consumers' acknowledgements. |
| Order/cart ClickHouse projections | The order durable remains `order-facts-v1`, with new receipts under `order-analytics-v2` committed after projection and before acknowledgement. A write may replay after a crash. Logical keys and deduplicated reads are required; physical row counts are not an exactly-once guarantee. |
| Catalog search | Retries batches, sends progress acknowledgements during long work, uses a database writer lock across replicas and double-acknowledges successful work. |
| Notification delivery | Existing bounded provider deadlines, scheduled retries, terminal failure and sensitive-payload scrubbing remain intact. Stable job IDs do not guarantee an external SMTP provider will deduplicate a send accepted before a crash. |
| Engagement jobs | Existing job locks, transactional completion, scheduled backoff and terminal failure after exhaustion remain separate from the commerce outbox. Worker readiness includes failed/stale jobs. |

Malformed consumer payloads can still be redelivered repeatedly and delay that durable consumer. This phase does not introduce automatic discard, a general dead-letter queue, schema-version routing, or a universal consumer-lag dashboard. Diagnose and repair these cases explicitly; do not acknowledge away an unprocessed commerce event to clear an alert. The demonstrated no-duplicate business effect is order-confirmation **enqueueing**, not guaranteed exactly-once delivery by external email providers.

Migration `20261011030000_outbox_retries.sql` is additive and preserves old pending/published rows. Apply it before starting the new gateway (normal gateway startup migrates first). Older binaries remain compatible with the extra columns, but ignore retry scheduling; rollback therefore loses backoff behavior. Keep the columns and receipt history on rollback. Include the publisher's extra connection in capacity planning. See [queue operations and recovery checks](../platform/operations/commerce-reliability.md#asynchronous-queue-operations).

## Measured cart-market read optimization

[Cart market provenance](../../commerce-api/rocento-api/crates/domain-cart-checkout/src/market_context.rs) reads the cart's market, singleton store settings and active market release in one SQL statement. Previously it performed three sequential reads on the same transaction. The combined read retains missing-cart `NotFound`, missing-configuration database errors, inactive-market rejection and country/currency mismatch validation. Each call reads current transaction-visible data; there is no cross-request cache. Existing locks and checkout atomicity remain unchanged. See [isolated SQL profiling](../platform/operations/commerce-reliability.md#profiling-measured-bottlenecks) for reproducible measurement and its limits.
