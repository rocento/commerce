# Merchant workflows

Catalog pages own product editing, primary/additional category selection, attribute definitions/sets, industry configuration and enrichment. Product identity, prices, stock and published market views remain backend-authoritative. A language edit changes translated text, not product identity or inventory. [Backend catalog and market rules](../backend/catalog-and-markets.md) describes validation and publication.

Inventory pages expose locations/sources, stock pools and quantities; multi-source inventory remains separate from storefront theme targeting. Replenishment has its own policy editor. Creating a physical branch does not invent stock quantities: add stock through the inventory workflow.

Orders and order geography use authorized current order data. Customer profiles, attributes and journey use server-owned identity. Segments save revisioned definitions and calculate membership using supported backend fields; unsupported rules must not show sample counts. Segment counts can overlap and are timestamped observations. Support and review moderation retain domain permissions and server state.

## Marketing notifications

Marketing → Notifications (`/marketing/notifications`) manages persistent notification programs. Each program combines a channel, a recorded journey trigger, title/body templates and eligibility rules. Programs have draft, active, paused and archived states. Save checks the last-read version so concurrent edits cannot silently overwrite each other. Archive retains generated history and audit records.

The journey editor follows When → Conditions → Message → Review. Add up to ten conditions with Match all / Match any and typed field/operator/value controls; the summary explains the effective rule in plain language. Only fields compatible with the selected trigger are offered. Preview shows each condition's expected and actual value and why it passed or failed. Customer verification, order count, account age, product name, order status and currency-aware order amounts are supported. Existing programs keep their behavior until conditions are added. Changing the trigger retains incompatible rules and asks the administrator to resolve them before saving.

Use an allowlisted `{{token}}` to insert customer, product, event or order facts. The preview resolves values from the selected customer's existing journey; it does not accept invented customer context. Missing values remain visible and prevent generation. The latest matching event inside the lookback window is evaluated against the waiting period, per-program customer cooldown, duplicate-event protection and optional suppression after a later purchase. Browsing observations remain distinct from authoritative commerce records.

Select a customer, preview the saved active program and choose **Generate record** to create a durable content snapshot. This stage uses explicit per-customer generation: an active program is eligible for generation, not a running background campaign. Generation itself has no delivery side effect. A saved in-app record can then be reviewed and explicitly published to its customer’s native storefront inbox. Existing transactional email templates and delivery workers remain separate; no third-party notification provider is connected. Generated history records the exact program revision, customer, source event, channel and rendered content. See [notification backend boundaries](../backend/marketing-notifications.md) for concurrency and future delivery integration.

`notifications.read` grants the workspace and audit history; `notifications.write` adds program management; `notifications.generate` adds generation; `notifications.publish` adds native inbox publication and withdrawal. Real customer previews, generation and generated content additionally require both `customers.read` and `orders.read`. Customer journeys link into this workspace with the selected customer when the admin has notification read access. A role with notification access alone can manage program content without reading customer data.

The **Storefront inbox** tab publishes general announcements for everyone, guests, or signed-in customers. Review the message, optional internal action, start time and expiry, then publish. Publication history shows Scheduled, Live, Expired and Withdrawn messages. Content and audience remain fixed; use **Withdraw publication** to remove visibility. In Generated history, **Publish to customer inbox** reviews an `in_app` record with its saved recipient and content. Guest inboxes receive only general announcements.

Announcement creation starts with the audience and message. Optional action buttons and scheduled start controls expand only when needed; visibility presets provide one, seven or thirty days. A final review names the audience, exact message and visibility window. Publication identifiers and versions are available under details instead of occupying the main history view.

## CSV and grid operations

[Import center](../../commerce-web/apps/admin/src/import-center.tsx) supplies exact-header templates and UTF-8 handling. Inputs are locked during validation/application; replacing a file clears old content, and previews belong to the exact input/reason validated. Apply revalidates current database state.

Synchronous imports are bounded to 500 rows and 2 MB, with server validation and all-or-nothing writes. They have no durable import idempotency contract; after an uncertain response inspect audit history before retrying. Arbitrary report exports need column mapping before they are valid import inputs.

CSV exports use reversible formula protection; background CSV/XLSX exports retain filters/columns, durable jobs and bounded chunks. Generation uses a stable database snapshot and keyset traversal. XLSX values are strings rather than executable formulas. Download readiness, ownership and permissions are server-enforced.

The UI must handle pending, failed, empty, read-only and conflict states. Keep successful outcomes tied to returned records or receipts and preserve source input when the user needs to correct a rejected operation. [Backend domain boundaries](../backend/domains.md) and [API contract](../backend/api.md) identify owning implementation and tests.


### Guided notification publishing

Marketing → Notifications opens the Storefront inbox sender by default. Journey programs remain available in their own tab; customer journey links and `?workspace=journeys` open that workspace directly.

The announcement composer follows **Message → Audience & timing → Review & publish**. A live inbox preview supports English and Arabic text, and optional button presets link to products, cart or support. Choose everyone, guests or signed-in customers, then optionally find delivery areas by name and select checkboxes. Area restrictions apply to the visitor's selected delivery location.

Scheduling shows the administrator's time zone. The 1-, 7- and 30-day options stay relative to a changed start time; manually editing expiry keeps that custom date. The final review shows the exact audience, selected areas, start, expiry and button destination. It contains no editable controls. An unconfirmed request locks editing and retries the same idempotency key and payload, preventing duplicate announcements.

Publication means visibility in the storefront notification bell. It does not mean a device push was delivered or that a customer read the message. The workspace labels this boundary explicitly; no device-push integration is added by this UI change.

For an automatic product offer, choose **Storefront inbox → New announcement → Audience & timing → Delivery trigger → After visiting a specific product**. Search for and select the product, choose everyone to include guests, then review and publish. Each eligible visitor receives a small alert and a saved notification once. Publication history identifies product automations and allows withdrawal. Coupon creation and redemption rules remain managed under Promotions; include the correct code and expiry in your message.
