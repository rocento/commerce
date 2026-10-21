# Marketing notifications and native storefront inbox

The [admin workspace](../../commerce-web/apps/admin/src/marketing-notifications.tsx) combines audience campaigns, publication history, and existing journey templates under Marketing → Notifications. New campaigns select audiences by customer segments, journey events, conditions, locations, and timing. The [campaign evaluator](../../commerce-api/rocento-api/crates/api-gateway/src/notification_campaigns.rs) grants eligible inbox messages through the engagement worker. Existing personalized journey programs and generated records remain available as a secondary workflow. This module is separate from account/order email templates and the SMTP delivery subsystem.

## Unified audience campaigns

The campaign flow is **Message → Audience & journey → Timing & frequency → Review & activate**. Campaign drafts are stored on the server under `/v1/admin/marketing/notifications/campaigns`; editing requires the current version. Saving a draft never delivers a message. Activation publishes a fixed snapshot, using an idempotency key so uncertain retries cannot create duplicate publications. Published content and targeting cannot be silently edited. Existing withdrawal and publication history controls remain available.

Audience rules intersect the following choices:

- Everyone, guests, or signed-in customers.
- Up to twenty active customer segments, matching any or all selected segments. Membership is checked against current customer facts when evaluating delivery.
- A scheduled audience message, or a supported journey event such as a store/product visit, category/page view, search, cart activity, checkout, purchase, or order-status change.
- The existing typed condition group, with up to ten rules matching all or any. Missing facts do not match. Product targeting and delivery-area restrictions can narrow the audience further.
- Start and expiry, delay after an event, bounded event lookback, cooldown, maximum deliveries per recipient, and suppression after a subsequent purchase.

Segment rules, customer/order conditions, purchase suppression, and authenticated commerce events require the signed-in customer audience. Guest activity is scoped to its existing inbox cookie, never linked to a customer. Guests can receive store-visit or product-visit campaigns; a guest store-visit campaign is once per browser. Product visits can repeat subject to a distinct event, cooldown, and delivery cap. Segment and customer rules are not silently ignored for guests.

Draft authors require `notifications.read` and `notifications.write`; activation requires `notifications.read` and `notifications.publish`. Campaigns targeting signed-in customers additionally require `customers.read` and `orders.read`. Rules are validated on save and rechecked on activation. Campaign messages are reviewed plain text; the existing allowlisted personalized templates remain in the legacy journey workflow rather than being expanded into broadcast content.

Native inbox activity queues recipient evaluation in the isolated engagement database. Product views enqueue evaluation directly; other authenticated browser and commerce events are discovered on the next inbox poll or touch. An event first written after the recipient leaves can therefore wait for their return; once a delayed event has been observed, its durable due job can complete without another visit. The worker checks current audience membership, the latest matching event, conditions, delay, cooldown, and the publication window before granting delivery. Known future delay/cooldown eligibility creates a durable due job; that job rechecks current facts and expiry rather than treating earlier eligibility as authorization. Event campaigns consider events after publication starts and within their configured lookback; activating a campaign does not replay older activity. Evaluation processes at most 100 campaigns per job, queues bounded continuation jobs for larger campaign sets, and serializes grants per recipient. Due jobs target the exact campaign that scheduled them. A touched recipient can also receive a scheduled audience campaign when its start time arrives; journey campaigns still require an event after that start time. Repeated inbox polls do not manufacture new event deliveries. A qualifying later delivery updates the message's inbox time and clears its read state; repeats of the same event do neither.

Scheduled times define eligibility for the native storefront inbox. This is not external email, SMS, WhatsApp, or operating-system push, and it does not promise contact with customers while they are away from the store. No existing draft or campaign is activated merely by deploying the new workspace.

Deploy the campaign migration to both database modes and update gateway, engagement worker, admin, and storefront together before activating rule-based campaigns. Withdraw those campaigns before any rollback to a binary that predates audience rules: an old reader cannot enforce the new targeting definition. Retain database backups and the matching runtime release.

## Legacy journey templates: contract and access

The API exposes metadata, filtered/paginated program listing, program creation and retrieval, version-checked updates, customer previews, generation, paginated generated records and program audit history. The full and merchant OpenAPI documents describe these endpoints. All require an authenticated admin with `notifications.read`; mutations retain the normal origin/request-marker checks. Program writes also require `notifications.write`. Generation requires `notifications.generate`. Preview, generation and generated history require both `customers.read` and `orders.read` because rendered snapshots may contain private customer/order facts. Existing restricted roles are not automatically granted these permissions.

Program configuration includes name, description, channel, trigger kind, title/body templates, status, delay, lookback, cooldown and optional suppression after purchase. Metadata supplies the supported channels, journey triggers and dynamic field allowlist. Templates are plain text, never executable expressions or HTML. Unknown or malformed variables are rejected; unavailable values are reported by preview and prevent generation. A preview is advisory: generation rechecks persisted configuration and current journey eligibility.

## Dynamic conditions

Journey programs follow **When → Conditions → Message → Review**. The condition builder uses metadata-supplied fields, operators and typed controls. A program has one bounded group of up to ten rules, matching **all** (AND) or **any** (OR). An empty all group adds no restrictions; empty any groups are invalid. There is no nested expression language, JavaScript or SQL input. Existing saved JSON definitions that omit `conditions` deserialize as an empty all group, requiring no new migration.

| Fact | Meaning | Comparisons |
| --- | --- | --- |
| Customer verified | Current account verification flag | Is true / false |
| Orders placed | Lifetime recorded orders, including cancelled orders | Equals, at least, at most |
| Account age | Whole elapsed 24-hour days since registration | Equals, at least, at most |
| Product name | Product on the selected product-view or cart-item event | Equals, contains; case-insensitive |
| Order status | Recorded workflow state on a status-change event, rather than a configurable display label | Is, is not |
| Order total | Exact amount on the selected checkout or order-placement event | Equals, at least, at most; currency required |
| Order currency | Currency on the selected checkout or order-placement event | Is |

Integer conditions accept 0–1,000,000,000. Money conditions use decimal text, at most two decimal places and 999,999,999,999.99, with an uppercase three-letter currency code. Currency mismatch fails the money rule. Missing facts always fail a rule, including a negative comparison. Product and order fields are available only for compatible triggers; changing the trigger does not silently discard existing conditions.

Conditions are evaluated against the **same latest trigger event** used to personalize the message. An older event is not selected just because it would satisfy the rules. Preview returns the group result and per-rule expected value, observed value, pass/fail and explanation. Generation evaluates saved rules against current server data again, preserving normal permissions, versions, cooldown, suppression and deduplication. A preview that passes is not authorization to bypass those checks.

For example, an order-placement program can require all of: customer verified, at least two orders placed, and this order total at least 500 EGP. Preview explains each result for the selected customer. The administrator still generates a saved message and explicitly publishes it to that customer's inbox. Conditions do not create background campaigns or change messages that are already published.

## Consistency and generation

The generator reads the existing customer journey sources using the selected customer's identity. It considers the latest matching event within a bounded lookback; it does not infer abandoned carts or completed payments from browser observations. Delay means a minimum elapsed time after that event. Cooldown is per program and customer. Purchase suppression checks for a later order placement, not payment settlement. No anonymous identity stitching is introduced.

Program edits use optimistic versions. Generation is transactional, keeps immutable rendered content with the source event/program revision, and records the result for the caller's idempotency key. Retries must reuse that key after an uncertain response. Event deduplication prevents a program from repeatedly generating for the same customer event, including after a program edit. Concurrent requests serialize eligibility checks so cooldown and deduplication remain effective. Program changes and generation outcomes are audited in the database transaction.

The database is the existing installation boundary, as for customer journeys and other commerce domains. Generated records contain personal content and are returned through protected admin endpoints. A separately published `in_app` snapshot is visible only to its recorded customer. Guest announcements never include generated customer records.

## Native inbox publication

Marketing → Notifications → Storefront inbox manages broad announcements for everyone, guests, or signed-in customers. The administrator reviews plain text, an optional supported internal CTA, start time, and required expiry before publishing. Generated history separately offers **Publish to customer inbox** for `in_app` records. Its recipient and content come from the persisted record and cannot be overridden. Other generated channels cannot be published through this route. Unresolved template syntax is rejected in broad announcements.

Publication requires `notifications.read` and `notifications.publish`. Publishing or withdrawing a personal record also requires `customers.read` and `orders.read`; administrators lacking either grant cannot see personal publication rows or their counts. Existing restricted roles need explicit assignment of the new publish permission. Publish requests use actor-scoped idempotency keys; uncertain retries retain the same key and exact input. The source record can have only one publication. Snapshots are immutable in the database. Withdrawal checks its version and updates an audit event in the same transaction. Publishing can start now or within 90 days; expiry must be after the effective start and within 90 days of it.

`GET /v1/notifications` returns the active recipient inbox with cursor pagination, unread count, and a server `snapshot_at`. `PUT /v1/notifications/{id}/read` sets one visible message read or unread. `POST /v1/notifications/read-all` accepts the list snapshot as `through`, leaving later arrivals unread. Listing and receipt writes enforce the same publication time, expiry, withdrawal, and recipient predicates. Responses are `no-store` and vary on Cookie and Authorization. Mutations require the existing origin and request-marker protection; admission limits apply per subject, source, and installation.

Valid customer bearer credentials select the authenticated customer. Invalid supplied bearer credentials fail without guest fallback. Anonymous listing issues a random `inbox_guest` HttpOnly, SameSite=Strict cookie (Secure according to the deployment security configuration), with a 90-day lifetime. Only its hash is stored. Unknown supplied tokens are replaced rather than adopted; receipt mutations require a registered unexpired cookie. Guest history is browser-specific and never merged on sign-in. Expired guest records are cleaned in bounded batches when new guest recipients are created.

The [storefront bell](../../commerce-web/apps/storefront/src/storefront-notifications.tsx) exposes All/Unread views, explicit read/unread controls, mark-all, pagination, retry and empty states. Opening it does not mark messages read. It polls every 45 seconds while the document is visible and refreshes when opened. English and Arabic interface text, RTL layout, mobile bottom-sheet presentation and native dialog keyboard behavior are supported. Both application and public-page headers include the bell. Server-rendered public HTML contains only a neutral disabled bell; session restoration and recipient requests run after hydration. Authentication changes unmount prior inbox state and cancel pending requests.

## Delivery boundary

An active program can be evaluated explicitly for a selected customer. This release does not schedule background audience evaluation or connect email, SMS, WhatsApp or browser/OS push providers. `generated` means content has been stored. Journey record visibility requires the separate publish action. Published product-visit announcements use the automatic grant flow described below. Generator channel metadata still reports delivery disabled because generation itself has no delivery side effect. The storefront bell uses durable inbox reads and periodic refresh, with no browser notification permission prompt.

A later external delivery phase must add its own durable dispatch lifecycle, provider adapters, recipient/channel consent checks, contact validation, rate controls, retries and delivery receipts. Treat the current generated content as a reviewed snapshot; do not attach it to existing transactional SMTP queues or interpret generation or native publication as consent for external delivery. Future background evaluation should reuse the same eligibility and deduplication rules rather than implement a second rule engine.

## Deployment and checks

Apply `20261004050000_marketing_notifications.sql` and `20261004070000_storefront_notifications.sql` through the normal migration process before using the workspace with an actual gateway. Deploy the gateway and storefront/admin assets together; this repository change does not publish any actual customer messages. Use the `storefront_notifications` gateway integration suite against disposable PostgreSQL, the `storefront-notifications.test.ts` API client suite, and the focused admin/storefront notification Playwright configurations for validation.

### Delivery-area announcements

Announcement publication accepts optional `area_ids` (up to 100 distinct active delivery-area UUIDs). Omit it or send an empty array for all locations. In the announcement composer, choose Selected delivery areas and select the areas before review. The chosen areas intersect with the guest/customer audience.

The storefront sends its selected delivery pin with inbox requests. The server resolves that pin using the existing delivery-area resolver, including overlap priority. Only the resolved area can match; missing or outside-coverage locations see unrestricted announcements only. Inbox listing, unread counts, mark-read, and mark-all use the same restriction. Changing location resets the inbox immediately. Area targeting applies to native inbox announcements; it does not send external email, SMS, WhatsApp, or push messages.

## Product visitor automation

The inbox composer supports **After visiting a specific product**. Select an active product through catalog search, choose everyone/guests/customers, optionally restrict delivery areas, then review and publish. The immutable publication stores `trigger_product_id`; a null value retains existing broadcast behavior. This flow is separate from manual journey generation and does not change channel delivery metadata.

After hydration and session restoration, the header first loads the inbox to establish the guest cookie. On a product route it sends `POST /v1/notifications/product-view` with `{ "product": "<UUID or slug>" }`. In production, the gateway saves a durable visit job in the dedicated engagement database and returns HTTP 202. The separate worker checks the product, server-owned recipient, audience, area, publication window and withdrawal, then inserts a unique recipient/publication grant. The storefront refreshes after enqueue and shows a dismissible alert when the grant appears. Local legacy mode still returns IDs synchronously. Repeated or concurrent visits do not resend or reset read state. Grants use delivery time for inbox ordering, pagination and mark-all cutoffs. Existing guest/customer isolation and rate limits still apply. Missing/invalid guest sessions and invalid customer tokens fail closed. Cached public HTML never contains the personalized offer.

Apply migration `20261005090000_product_visit_notifications.sql` and deploy gateway, admin and storefront together before publishing product campaigns. Before rolling back to a gateway version that predates product targeting, withdraw these campaigns; older versions cannot enforce this new targeting field.

### Grocery test requested on 2026-10-05

The live prepared coupon `TOMATO10` is 10% off the whole merchandise subtotal, without product/category restrictions, for guests and registered customers. It excludes delivery and tax; existing checkout discount rules still apply. It is a shared coupon, not a generated single-use code. The notification is once per guest cookie or customer account, not once per human across browsers.

After the new deployment completes, run `bash commerce-ops/deploy/aws-deploy/activate-grocery-visitor-offer.sh`. It checks the actual running API, activates the existing coupon, and publishes the product-specific notification for Tomatoes 1kg (`bc0cbb1d-8b21-45e2-8047-b5ac807260f3`) for seven days. Coupon and notification expire together. A mode-600 server-side request snapshot makes retries idempotent; reruns preserve expiry and withdrawals rather than silently renewing. The old manual journey draft is unused. This command does not seed or redeploy services. `--prepare` only updates the inactive coupon scope and sends nothing.

## Database isolation

See [Journey and notification storage isolation](engagement-isolation.md) for the dedicated database, shared-image worker, first-deployment migration, resource limits, backup and failed-job recovery commands.
