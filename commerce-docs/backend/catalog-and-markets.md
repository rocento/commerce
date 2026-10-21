# Catalog, localization and market publication

Catalog owns product identity, active status, primary/additional category membership, typed attribute definitions/sets, imported facts and media references. The primary `category_id` remains the source for existing policies and breadcrumbs; `category_ids` projects up to 50 unique directly assigned categories including primary. Additional assignments expand browsing/discovery without rewriting historical order facts.

Omitting category assignments preserves compatible existing clients; an empty additional list removes extra assignments. Catalog transactions and foreign keys protect valid membership and category deletion. Search indexes categories and ancestors, with ordinary product events and category reindexing updating derived documents. Recommendation evidence must come from verified facts rather than guessed product attributes.

Industry and enrichment scripts can alter schema/data and require reviewed inputs for the intended installation. Demo files are assets, not proof of live inventory. [Asset guidance](../frontend/assets-and-demos.md) links the retained demo sources.

## Category availability

`GET /v1/catalog/category-availability` returns a category-ID-to-count map, including zero-count categories, with `Cache-Control: no-store` enforced by the gateway middleware. Counts use the search index's category membership and ancestor projection. They require in-stock products globally, or available products in the selected delivery area's stock pools. Delivery header validation is shared with shopper search and product reads; an uncovered selected pin fails before querying search.

The direct provider uses Meilisearch multi-search in batches of 100 with no returned product hits. Counts retain the provider's `estimatedTotalHits` semantics and indexing delay; they are for category ranking, not an authoritative inventory total. Delegated providers keep their existing internal search contract with four concurrent requests. Missing or malformed batch results fail the request instead of presenting incomplete counts. Frontend sections share this map and rank all candidates before applying display limits.

## Translation preparation

Localization persists an installation source locale and revisioned draft languages. Catalog translations contain text, source snapshots and review state; shared IDs, SKU, price, currency, stock and slugs do not become translated copies. Source-text changes invalidate text review; unrelated stock/price changes do not. Saving draft languages does not publish another public content locale.

The separate interface message catalog is [backend/interface-messages.json](../../commerce-api/rocento-api/interface-messages.json), embedded by Rust. English/Arabic forms and reviewed overrides have their own revision and source-change behavior. CSV and formatter contracts retain plural-form placeholders and plain-text output. Shopper interface language and market country/currency are separate concerns.

## Published market overlays

One market release is published per storefront installation. Readiness checks country/currency compatibility, source language, assortment, missing prices and unsupported composite parent overrides. Publication requires `markets.publish`, `catalog.write` and `cms.publish`, reviewed source/configuration fingerprints, an explicit reason and current revision. Stale review fails closed.

Publication snapshots overrides without altering source catalog. Later draft edits do not affect live prices. Effective views serve storefront, search results, feeds, recommendations and checkout. Source-inactive products cannot be activated by an overlay; disabled parents hide children. Category/navigation exclusions are per record and do not cascade into product exclusion.

Quotes and assistant proposals are invalidated when market facts change; durable search reindexing is asynchronous. Carts/orders retain release context. Restore defaults removes the active overlay while preserving release/order history. Store country/currency cannot change beneath an active release.

This does not supply simultaneous shopper country switching, separate market payment/delivery/tax policy or multi-country URL binding. Tests live in gateway `markets`, `market`, `languages`, `catalog`, `catalog_schema` and relevant checkout/publication suites. Actual production activation still needs fresh readiness and acceptance.


## Product relationship rules

The admin Catalog → Product relationships page manages related products and up-sells on product pages and cross-sells on the cart page. The design follows [Adobe Commerce related product rules](https://experienceleague.adobe.com/en/docs/commerce-admin/marketing/promotions/product-relationships/product-related-rule-create): separate source/display conditions, priorities, optional schedules, audiences, and manual precedence. Ordering here is deterministic rather than random.

Rules belong to the installation catalog. Read access requires `catalog.read`; create/update/delete also require `catalog.write`, the existing request-origin/CSRF protection, and a current revision. Audit before/after snapshots and outbox records commit atomically with mutations. New rules start disabled in the editor. Updates take effect on subsequent uncached reads. Apply migration `20261005120000_product_relationship_rules.sql` with the regular backend migration process before deploying the gateway/frontend changes.

Conditions support ALL or ANY comparisons over SKU, assigned category, product type, published base price, and explicitly promotion-enabled scalar product attributes. Attribute comparisons support equality/inequality and recheck current promotion eligibility at evaluation time. Price ranges use decimal arithmetic. There are no nested condition groups, relative-price operators, array-attribute comparisons, or external CDP audiences. Up-sell placement does not automatically imply a higher price; configure its display conditions accordingly. Date-times are UTC, with inclusive starts and exclusive ends. Lower priority numbers run first, tied by rule UUID. Stop-processing suppresses lower-priority rules after a source match, including a rule with no available display results.

Manual selections retain their configured order and precede automatic results; automatic ordering uses product UUID. Products must be active in the published catalog, be top-level products, share the first source's currency, and pass live delivery-stock checks. All supplied source/cart product IDs are excluded and results are deduplicated. Authenticated customer segments, reviewed localization, visible attributes, media and existing offer pricing use the regular storefront services. Segment membership cannot be supplied by the caller. Missing/deleted segments do not qualify. Responses use `Cache-Control: no-store`; client query keys include customer, locale and delivery context.

Bounds: 200 rules per catalog; 20 conditions in each group; 20 manual products and segments per rule; 1–20 results per rule; 50 source IDs; 100 distinct candidates evaluated for stock in batches of 20; and 20 displayed results per placement. Candidate limits precede stock filtering, so the displayed count can be lower than the configured maximum. SQL statements have a two-second evaluation timeout and the gateway imposes a five-second overall evaluation deadline. These are operational bounds, not a large-catalog load-test certification. Installation-level isolation follows the existing separate-database deployment model.

The typed contracts expose `/v1/admin/catalog/relationship-rules` and its attributes/update/delete routes, plus `GET /v1/catalog/relationships?sources=<comma-separated-UUIDs>&kind=related|upsell|cross_sell`. Gateway database tests cover mutation conflicts, audit records, permissions, conditions, manual order, attribute revocation, stock batching and authenticated audience projection. Browser tests cover editing, conflict recovery, read-only access and mobile overflow. Production migration, deployment and workload acceptance remain separate release steps.
