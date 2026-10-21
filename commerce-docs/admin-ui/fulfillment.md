# Fulfillment administration

System → Configuration → Delivery & pickup (`/system/configuration/fulfillment`) exposes stores, branches and fulfillment capabilities. The legacy `/settings/fulfillment` link redirects here. Read requires `fulfillment.settings.view`; management requires `fulfillment.settings.manage`. Creating a branch that holds inventory also requires `inventory.write`, and enabling pickup requires `fulfillment.pickup.manage`.

Add store or branch creates the store and, for a physical inventory branch, its inventory location/link in the same transaction. A branch needs an address and at least one fulfillment method. An optional stock pool is validated before commit. Stock quantities are not inferred or copied. Configure them separately, then coverage, schedules and pickup instructions.

In the selected store’s **Delivery coverage** section, **Global delivery coverage** enables worldwide delivery using default and global stock pools. The switch starts off. Enable it and save with a change reason to bypass delivery-area boundaries and city restrictions. Stock quantities, schedules, capacity, and market rules still apply. Disable it to restore the saved area/city policy. Coverage changes invalidate open fulfillment selections, so customers must review them again. Global stock can remain visible worldwide while global delivery is off.

Retrying the same receipted branch request with the same store ID is idempotent; changed details under the same ID fail. Permissions are checked on retries and transaction failure rolls back linked creation/audit. An uncertain legacy creation without a receipt must be inspected rather than guessed.

Delivery fees and geographic tax rules are configured separately in System → Configuration → Delivery fee (`/system/configuration/delivery-fee`) and Tax rules (`/system/configuration/tax`). Changes apply to new checkout reviews; existing orders retain their recorded amounts.

## Location pickup management

Inventory → Locations → open a location (`/catalog/sources/:id`) owns pickup settings. The **Store pickup** panel explicitly selects the store–location connection; a shared location does not have one global pickup policy. Set **Accept pickup at this location**, **Pickup instructions**, and **Preparation time (minutes)**, then provide a location change reason and save. Saving a new connection attaches the existing location to that store without changing product stock.

The location screen requires `inventory.read`. Pickup viewing requires `fulfillment.settings.view`; changing pickup requires both `fulfillment.settings.manage` and `fulfillment.pickup.manage`. Pickup operators can work without `inventory.write`; physical location details remain read-only for them. New inventory locations must be saved before adding pickup connections.

Store-wide Store pickup and Scheduled pickup switches remain in Delivery & pickup settings. Its Store locations section summarizes connections and links to the location editor with `?store=<store-id>`, preserving the selected store. Existing pickup configuration can be maintained while store pickup is off; enabling a new pickup connection requires the store policy to allow pickup. A disabled location or unavailable stock still prevents collection.

Location details and pickup settings save independently. Unsaved changes are protected across navigation and pickup store switching. Failed saves retain the draft; successful pickup saves use the existing audited store-source endpoint. Refreshed changes to the same connection require reloading that connection before saving; this does not add server-side optimistic concurrency to the existing API.

## Capacity and scheduling

`/fulfillment/capacity` needs `fulfillment.capacity.view` and `fulfillment.schedule.view`. Schedule writes use `.schedule.manage`, cap writes use `.capacity.manage`, and overrides additionally use `.override.manage`. New/edit pages preserve those checks when entered directly.

System → Configuration → Capacity activation (`/system/configuration/capacity`) owns legacy installation-wide checkout admission activation. Viewing requires both capacity and schedule read permissions; changing activation requires both management permissions and a reason. Installations using store fulfillment policies show their effective controls and link to Delivery & pickup settings instead. Per-store capacity enforcement and checkout holds remain in the selected store's fulfillment policy.

The operational scheduling page provides local date navigation, source/area/method/status filters, operational rows, booked totals, rule remaining capacity and peak utilization. Configure schedules disabled first, set caps, then activate the applicable store policy or legacy installation control with a reason. Dated/slot overrides retain parent scope and dates. Zero-order caps prevent new allocation rather than cancelling existing bookings. Changes affecting future bookings require explicit acknowledgement.

Order details show the booked source, window, reservation and original timezone. Backend reservations atomically hold capacity and inventory, revalidate cart/destination/facts at checkout, and distinguish expiry, stale review and idempotency conflicts. See [fulfillment API and semantics](../backend/fulfillment.md).

Validate permission states, zero caps, stale edits, source selection, local time/date behavior, errors and responsive layouts. Branch and schedule UI success must reflect returned authoritative state.
