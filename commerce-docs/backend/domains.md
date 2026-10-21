# Commerce domain boundaries

Cart/checkout owns saved lines, reservation-aware quote review, promotions/tax/shipping application and bounded idempotent placement. Orders retain historical commercial facts and release context rather than re-pricing history from current catalog values. Inventory and fulfillment own current stock, holds, source allocation and shipment progression. Domain receipts, not browser stream completion, determine success.

Support owns customer-scoped tickets and admin operations. Customer identity/profile, custom attributes, saved locations and journey are distinct from anonymous browser state. Assistant adapters can read or mutate only with explicitly delegated capability and owning-domain checks.

## Customer segments

Segment definitions use PostgreSQL revisions, audit/outbox and `customers.read` plus `customers.segments.write` for mutation. Counts are evaluated from supported current fields and carry observation timestamps; counts may overlap. Supported conditions have explicit allowlists and null/missing behavior. Order aggregates use qualifying completed statuses, not every attempted order; saved cart metrics are not current checkout quotes.

Missing or unsupported attribute rules fail explicitly. Do not invent estimated membership or currency aggregation without a supported currency scope. Theme targeting can consume eligible segments through its own authorization and evaluation path. Segments are not a general visitor-tracking or arbitrary promotion-rule engine.

## Admin imports, grids and exports

Admin operations validate exact CSV headers, UTF-8, duplicate identities, bounded size/rows and inventory constraints. Preview rolls back; apply validates again and commits domain writes/audit/outbox atomically. Current synchronous imports are limited to 500 rows and 2 MB and do not expose durable request idempotency. Inspect audit after a lost apply response.

Shared CSV cell encoding reversibly protects formula-like prefixes including whitespace/control cases and literal apostrophes. XLSX exports use inline strings. Background exports use durable jobs, exclusive claims, stale-worker recovery, bounded chunks and a read-only repeatable-read snapshot with stable keyset pagination. Downloads check owner/permissions and ready state and use attachment/no-store/nosniff headers.

Test ownership lies with gateway suites such as `cart_inventory`, `orders`, `support`, `segments`, `grids`, `admin_depth`, `customer_journey` and owning domain crates. Use isolated database fixtures for mutation and concurrency checks. The removed historical reports are not a current certification of scale or deployment.
