# Fulfillment and capacity

Store capabilities, inventory locations/stock pools, schedules, capacity and checkout reservations have separate ownership. A physical branch links a newly created store/location transactionally; optional stock linkage is validated, permissions are checked and stock quantities are not copied. Receipted same-input retries use the same store ID without duplicate creation; changed inputs fail. Read/write/pickup permissions remain distinct.

The [capacity contract source](../../commerce-api/rocento-api/crates/api-gateway/openapi/capacity_contract.py), [gateway](../../commerce-api/rocento-api/crates/api-gateway/src/capacity.rs) and domain fulfillment/cart code define current behavior.

| Endpoint | Purpose / authority |
| --- | --- |
| GET `/v1/fulfillment/delivery-options` | Verified customer's eligible cart/address windows |
| POST `/v1/fulfillment/reservations` | Atomic capacity and inventory hold |
| DELETE `/v1/fulfillment/reservations/{id}` | Owning customer's idempotent release of an unconfirmed hold |
| GET `/v1/admin/fulfillment/configuration` | Capacity/schedule view permissions |
| GET `/v1/admin/fulfillment/capacity` | Capacity view; operational counters and utilization |
| POST `/v1/admin/fulfillment/settings` | Capacity and schedule management; explicit activation reason |
| POST `/v1/admin/fulfillment/schedules` | Schedule management; overrides need override permission |
| POST `/v1/admin/fulfillment/capacity-rules` | Capacity management; overrides need override permission |

Permission names have the `fulfillment.` prefix. Admin mutation/session/origin safeguards still apply; bodies do not establish ownership. Customer discovery omits full/invalid windows and private counters.

A hold binds schedule, owned location, start/end window and idempotency key; the server derives cart, demand, area and source. Repeated unchanged live holds return their original record, changed inputs fail, and expired/terminal holds require fresh admission. Quote expiry is bounded by hold expiry. Placement revalidates cart, destination, source, physical facts and inventory.

Schedule configuration includes method, timezone, local windows, lead/cutoff rules, duration, spacing, advance horizon, hold TTL and exceptions. Configure disabled before activation. Capacity rules constrain orders/units and supported dimensions over slot/hour/day scopes with optional dated overrides. Zero caps block new holds without cancelling bookings; changes affecting future bookings require acknowledgement. Preserve the original timezone and policy snapshot with bookings.

Customer conflicts use codes including `SLOT_SELECTION_REQUIRED`, `RESERVATION_EXPIRED`, `RESERVATION_STALE`, `IDEMPOTENCY_CONFLICT` and `SLOT_UNAVAILABLE`. Alternative search is bounded and does not promise every future eligible slot. Normal order idempotency remains separate from hold idempotency.

Validate `branch_setup`, `fulfillment_admin`, `cart_inventory`, `orders` and domain capacity suites with an isolated database. [Admin guide](../admin-ui/fulfillment.md) and [storefront flow](../frontend/storefront.md) describe the corresponding UI.

## Global stock availability

Stock pools expose `is_global` in the inventory administration API and stock editor.
It defaults to false for existing pools and for API inputs that omit the field.
Global pools contribute availability at every browsing location. Covered locations
combine their area pools with global pools; browsing without a pin combines default
and global pools. Outside delivery coverage, only global pools contribute stock.
Product details, search filters, category counts, best sellers and assistant catalog
facts use this scope. Live quantities exclude active reservations, disabled sources
and assignments marked out of stock; sources shared by several pools count once.

Global stock visibility is independent of delivery coverage. In Admin → Delivery &
pickup settings → Delivery coverage, `global_delivery_enabled` enables worldwide
delivery per store. It defaults to false and supports system inheritance and store
overrides. When enabled, area boundaries and city restrictions are bypassed, and
checkout can reserve from default and global pools. Shared physical sources count
once. Inventory, source enablement, store source assignments, scheduling, capacity,
and market destination rules still apply. Turning the switch off restores the saved
area/city policy and invalidates open fulfillment plans. With it off, a global pool
must be assigned to an eligible delivery area or be the default pool to fulfill orders.

Demo preset seeding creates a dedicated `demo-global` source/pool and resets every
active demo product to 1,000 units in that source. Regional source quantities remain
separate. For an existing isolated demo, run `commerce-ops/scripts/seed-demo-storefront.py <preset>
--apply --global-stock-only --api-base <target> --credentials <file>` after commerce-ops/deploying
the global-stock migration and API. A rerun skips already-correct assignments.
