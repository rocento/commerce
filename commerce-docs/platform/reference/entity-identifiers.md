# Entity identifiers

Persistent business entities expose a numeric `entity_id` alongside their existing UUID `id`. The numeric identifier is easier to read, search and communicate in administration. The UUID remains the primary key and the key used by routes, foreign keys, relationships, events and existing integrations.

The numeric pattern follows [Adobe Commerce’s generated customer entity identifiers](https://github.com/magento/magento2/blob/2.4-develop/app/code/Magento/Customer/etc/db_schema.xml). This platform retains its established UUID primary keys during the additive rollout.

`entity_id` is scoped to one entity table within one installation/database. Product 12 and customer 12 are different records; product 12 in another store database is also a different record. A numeric identifier alone does not authorize access. Existing permissions and ownership checks still apply to the UUID record.

## Storage rules

- PostgreSQL allocates the identifier with `bigint GENERATED ALWAYS AS IDENTITY` when a row is inserted. Normal writers omit it.
- A unique constraint prevents duplicates within the entity table. A check constraint requires values between 1 and 9,007,199,254,740,991, and the sequence has the same maximum with cycling disabled. JSON and JavaScript can represent every allowed value exactly.
- The database rejects changes to an existing identifier. Identifiers can contain gaps after failed transactions or deletions; they do not promise row counts, chronological order or consecutive numbering.
- UUID `id` values and all UUID references remain unchanged. Numeric entity identifiers are separate from order numbers, ticket numbers, SKUs, customer identifiers, channel codes, document keys and revision numbers.
- Existing UUID columns called `entity_id` in audit logs, translations and market overrides continue to mean the referenced record's UUID. They do not become numeric identifiers for those rows.

## Entity coverage

Migration `20261003020000_entity_identifiers.sql` adds identifiers to this explicit list of 43 tables:

| Domain | Tables |
| --- | --- |
| Administration | `admin_iam.admin_users`, `admin_iam.roles` |
| Attributes | `attributes.definitions`, `attributes.sets`, `attributes.industry_profiles`, `attributes.value_relationships`, `attributes.enrichment_suggestions` |
| Catalog | `catalog.products`, `catalog.categories`, `catalog.attributes`, `catalog.media`, `catalog.media_folders`, `catalog.product_configurations` |
| Customers | `customers.customers`, `customers.customer_locations`, `customers.segments` |
| Inventory | `inventory.inventory_sources`, `inventory.stocks`, `inventory.delivery_areas` |
| Cart and checkout | `cart_checkout.carts`, `cart_checkout.quotes`, `cart_checkout.market_drafts`, `cart_checkout.market_releases`, `cart_checkout.trust_agents` |
| Orders | `orders.orders` |
| Payments | `payments.manual_refunds` |
| Tax | `tax.rules` |
| Pricing and promotions | `pricing_promotions.rules` |
| Fulfillment | `fulfillment.shipments`, `fulfillment.stores`, `fulfillment.schedules`, `fulfillment.capacity_rules`, `fulfillment.capacity_reservations`, `fulfillment.plans`, `fulfillment.plan_groups` |
| Support | `support.tickets`, `support.messages` |
| Content | `cms.documents`, `cms.revisions`, `cms.releases` |
| Reviews | `reviews.reviews` |
| Themes | `theme.themes`, `theme.versions` |

Settings, sessions, operational logs, event ledgers, receipts, assistant execution records, junctions and projections retain their existing keys. Channel assignments are keyed by channel code. The catalog storefront product and category views expose the corresponding base entity's numeric identifier.

New addressable business entities should follow the same storage rules and expose the identifier in their response contract. Membership tables and derived projections should retain the identifiers of the entities they reference instead of allocating unrelated numbers.

## API and administration

Entity responses expose the number as a read-only integer. Create and edit inputs omit it. Routes and relationship fields continue to accept UUIDs. Existing UUID `entity_id` reference fields keep their original types and input behavior.

Admin entity lists show an Entity ID column or label. Their entity search accepts either `123` or `#123`, and sorting uses numeric order. Shared grids also make the number available for exports. Search results read the canonical number from PostgreSQL while older search documents are being rebuilt.

Immutable historical receipts may omit the number. Deserialization preserves those receipts without inventing an identifier or emitting zero. Numeric metadata is excluded from the commercial comparison of saved checkout reviews from product comparisons in saved cart proposals, from market publishing review hashes, and from address fingerprints used by fulfillment holds and trusted actions. Introducing the metadata does not invalidate an unchanged review, hold or approval.

## Upgrade and validation

The migration adds identity columns directly so PostgreSQL backfills existing rows without issuing business-row updates. This preserves published theme versions, timestamps and cart revisions. It appends the identifier to storefront views while preserving all existing column ordinals and market pricing/availability behavior. A five-second lock timeout makes the migration fail safely if an active transaction blocks the required table locks; deployment must retry after resolving that contention.

The SQLx integration suite in `commerce-api/rocento-api/crates/api-gateway/tests/entity_identifiers.rs` verifies a fresh installation and an upgrade with existing products, customer addresses, carts, published theme versions and market overrides. It checks all 43 table definitions, backfilled identifiers, UUID business facts, reference-column types, generated values, duplicates, immutable identifiers and the JavaScript integer bounds.

Run the tests against an isolated PostgreSQL database:

```sh
cd commerce-api/rocento-api
DATABASE_URL=postgres://user:password@127.0.0.1:5432/disposable_test cargo test -p api-gateway --test entity_identifiers
```

SQLx creates temporary test databases. Do not target a production database. Applied migrations retain their original bytes; subsequent changes require a new migration.
