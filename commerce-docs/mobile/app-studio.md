# Mobile App Studio

App Studio is a **standalone merchant application** in the frontend workspace at [`commerce-web/apps/mobile-studio`](../../commerce-web/apps/mobile-studio). Its production hostname is **`apps.rocento.com`**, as configured by the deployment renderer. The builder supports **Production only**, with direct production drafts, validation, owner approval and immutable releases. It uses Rocento’s approved logo and original coral (`#DA7756`), accessible terracotta accent (`#B45134`), charcoal (`#242424`) and cream (`#FAF8F7`) palette.

## Separation from core administration

App Studio has its own entry point, login, navigation, CSS, build output and Nginx virtual host. It does not import the core admin application, add core admin routes or copy its bundle. The existing core dashboards keep their own hosts and artifacts.

The mobile workspace reuses the platform identity service and backend process. This is application and access-boundary separation, not a second database or identity provider. Secure, HttpOnly, SameSite=Strict login cookies are host-only; signing in at `admin.rocento.com` does not sign the browser in at `apps.rocento.com`. The mobile host proxies only login/logout, identity, mobile membership discovery, mobile drafts/releases/audits, and merchant assets. Core catalog, orders, users, roles, API reference, customer APIs and metrics return 404 on this host.

Every mobile management request additionally requires an active `commerce-mobile-apps.memberships` row. Installation `*` permissions grant no mobile membership. Merchant switches remount the editor and cancel reads, preventing a previous workspace response from replacing the new draft. Owner-only Test installations provisions internal device connections; it does not impersonate a customer or merchant.

| Mobile role | Preview and history | Edit and validate | Publish and rollback |
| --- | --- | --- | --- |
| Owner | Yes | Yes | Yes |
| Designer | Yes | Yes | No |
| Operator | Yes | No | No |
| Release admin | Yes | No | No |

Release admins retain backend build-queue permissions; hosted signing and distribution gates live in the [release plan](plans/native-preview-and-release.md).

## Editor and release workflow

1. Select a mobile merchant. The environment is always **Production**. An existing draft loads automatically; otherwise a draft starts from the latest publication or a minimal v1 template.
2. Edit the in-app name/logo, light/dark palettes, radius and density. System typography follows each native platform. Arrange all six registered section types by dragging or using the up/down buttons; configure typed banner actions, tab order, entitled features and English/Arabic messages.
3. Select the browser preview target and width, and inspect English/Arabic RTL. These are browser previews of the **SwiftUI (iOS 26) and Material 3 layouts**, with the selected merchant’s connected public catalog. They are not native renderer acceptance evidence.
4. Valid edits autosave after 900 ms using the last known revision. A write in progress preserves newer edits for the next save. Invalid input pauses saving. A 409 preserves local edits and offers a local JSON download or an explicit discard/reload. Navigation warns about unsaved changes and waits for requests to finish.
5. **Validate draft** runs the backend's authoritative checks, including ownership and current entitlements. Only the owner can open the release diff, check the approval box and publish. Each fresh review requires fresh approval. Retries of the same publication retain their idempotency key.
6. Publish the validated production draft directly. The backend rechecks ownership, revision, schema, assets and entitlements under a merchant lock; no staging release is required. The apps ingress rejects non-production environments.
7. Release history supports copying a release into a production draft and owner-approved rollback. Rollback creates a new immutable version after current compatibility/entitlement checks. Audit history includes actor, time, environment and before/after draft changes. History, audits and assets support pagination.

Theme, in-app branding, copy and layout changes publish remotely. Launcher icons, launch splash, native identifiers and store listing changes require the separate app factory process and new store builds. Production approval asks the owner to verify both real native applications; the dashboard does not automatically prove that verification.

## Platform preview behavior

The browser is a simulation with four target choices using one DOM renderer. Its current palette comes from `brand.light`; saved dark/appearance preferences do not establish dark-palette rendering parity. Real SwiftUI, Kotlin and React Native preview capabilities and recorded deployment limits are owned by [native preview](native-preview.md). Unsaved edits, saved drafts, native ACK and visible frames are distinct states.


The preview follows `commerce-mobile-apps/ios/Storefront/StorefrontView.swift` and Android `MainActivity.kt`: iOS uses a large navigation title and floating tab bar; Android uses a Material top app bar and navigation indicator. Both use native radius values (0/8/18/28), spacing (12/20), uncropped hero artwork, 150-pixel product artwork, platform carousel widths, category rows, and product sheets. The native code and saved device screenshots remain the reference when either renderer changes.

Each device has independent tab, language, product, cart and account state. The toolbar’s language control updates both; the language action inside a device updates only that device. Merchant changes reset sessions. Banner actions navigate to tabs/categories or products available in the preview catalog. Product sheets support Done/Escape and restore keyboard focus. Section editing controls are optional; catalog search remains available as a separate preview tool below each device.

Account forms and cart/checkout use a clearly labeled demo session and do not submit customer authentication, orders, payments or analytics preferences. Cart and checkout follow the native CommerceView flow: inline delivery/pickup, scheduling, availability, quote review, confirmation and order status. Fulfillment data and charges are simulated. Native fonts, glass, OS gestures, actual account data, and device APIs require verification in the installed apps; this browser preview is not a native emulator.

## Component library and advanced section editing

The Sections panel includes a searchable component library grouped into Commerce, Campaigns and Content, with descriptive icons for all six native components. Store discovery, Campaign landing and Collection story presets append three or four sections without replacing existing content. Presets include English and Arabic copy; merchants must configure their own banner images and select catalog categories before release.

The home-screen outline shows the translated section title, supports drag-and-drop and accessible move buttons, and synchronizes the selected section with both device previews. The inspector supports direct English/Arabic editing, advanced translation references, banner artwork previews, native actions, collection IDs, grid columns, category destinations and spacing. Duplicating a section creates independent IDs and translations; editing a shared translation inline first isolates that section’s copy. Removal requires an explicit inline confirmation. Component and preset insertion enforce the 30-section native limit. Operators can inspect the library but cannot modify it.

This is an editor upgrade using the existing v1 native contract. It does not introduce unsupported runtime components, arbitrary HTML, or transactional checkout. Catalog previews use the merchant’s explicitly connected storefront catalog; actual iOS/Android device validation remains part of release approval. Existing tenant isolation, revision-based autosave, role checks and owner-approved publication apply to these edits.

## Assets and validation

Uploads accept one PNG/JPEG/WebP, at most 5 MiB and 4096 pixels per side. The gateway decodes and re-encodes PNG, stripping untrusted metadata, checks allocation and output limits, and stores an immutable private object under the merchant UUID. SVG, arbitrary remote URLs, object keys and unsupported multipart fields are rejected. Membership protects reads as well as uploads. Uploaded records and audit entries commit together; failed database writes attempt object cleanup. S3 transport failures can leave an unreferenced object for later operational cleanup.

The asset library is scoped to the merchant. App Studio records uploads against production. Existing legacy environment records are retained but are not exposed by this builder. Existing trusted HTTPS registry assets remain supported. Uploaded private objects are currently exposed to authenticated App Studio administrators; enrolled-device asset delivery is implemented through the optional native adapter; see [commerce enrollment](commerce.md#optional-studio-enrollment-and-private-assets). Native POC fixtures continue using their bundled assets.

The frontend validates the exact generated canonical JSON Schema, then contrast, required tabs, action destinations, translation completeness, RTL, entitlements and supported runtime versions. Optional navigation icon overrides require runtime 1.1.0 on both platforms. Server validation and publishing remain authoritative. Neither the editor nor the JSON contract supports arbitrary HTML, CSS, URLs or executable extensions.

## Development and production wiring

```sh
cd commerce-web
pnpm install --frozen-lockfile
pnpm dev:mobile-studio
pnpm build:mobile-studio
pnpm --filter @rocento/mobile-admin test
```

The development port is **5194**. `API_PROXY_TARGET` selects a local gateway, and `API_PROXY_ORIGIN` must match that gateway's allowed origins. The default proxy origin is `http://localhost:5194`, included in the main local Compose configuration. Localhost ports do not isolate cookies; use separate local hostnames/browser profiles when testing login isolation. Production uses distinct hostnames.

The full EC2 frontend build produces `/public/mobile-admin`; deployment publishes it at `/var/www/rocento/current/mobile-admin`. The managed `apps` virtual host routes its allowlisted APIs to the primary gateway on loopback port 8080. Only that gateway adds `https://apps.<domain>` to its exact origin list. Provision mobile merchants and memberships in that gateway's `commerce-mobile-apps` schema through trusted onboarding. It does not combine the four installation-isolated commerce databases. TLS coverage, migration execution, private object storage, membership provisioning and production smoke checks are prerequisites for rollout.

## Verification

Use the following checks after changing authoring, contracts or ingress. Dated results are in [Studio history](history/app-studio-2026-10-12.md).

```sh
python3 commerce-mobile-apps/tools/generate_contract.py --check
python3 commerce-ops/scripts/contracts/generate_openapi.py
python3 commerce-ops/scripts/contracts/generate_public_openapi.py --check
python3 commerce-ops/scripts/contracts/generate_merchant_openapi.py --check
python3 commerce-ops/scripts/checks/check_api_documentation.py --check
python3 -m unittest commerce-ops/scripts.tests.test_mobile_contract commerce-ops/scripts.tests.test_mobile_studio_ingress commerce-ops/scripts.tests.test_ec2_deployment
MOBILE_STUDIO_INGRESS_TESTS=1 python3 -m unittest commerce-ops/scripts.tests.test_mobile_studio_ingress
DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:PORT/TEST_DB cargo +1.94.0 test --manifest-path commerce-api/rocento-api/Cargo.toml --locked -p api-gateway --test commerce-mobile-apps -- --test-threads=1
```

Install [OpenAPI test dependencies](../../commerce-ops/scripts/tests/requirements-openapi.txt) in a virtual environment first. Docker is required only for opt-in ingress tests; SQLx requires a disposable PostgreSQL user that can create test databases. The main CI workflow includes browser checks and contract-generation drift detection. Native preview, publication and signed-device acceptance remain separate checks.


## Browser security and deployment notes

The canonical schema is precompiled by `commerce-web/packages/api-client/scripts/generate-mobile-validator.mjs`; browser validation does not use dynamic code generation. Browser tests run against the production Vite bundle with the deployed CSP (`script-src 'self'`, without `unsafe-eval`). Regenerate the standalone validator when changing the contract; CI checks for drift.

Detached EC2 deployment explicitly renders into the active checkout’s `commerce-ops/deploy/ec2` directory. The primary gateway’s origin list includes `https://apps.rocento.com`. Mobile-only frontend releases preserve the existing core admin and storefront bundles. Production rollout evidence is under `output/rocento-mobile-production-20261011/`.

## Category selection in component settings

Product grids and carousels use a searchable category hierarchy instead of a manual collection ID. Category grids support up to 12 individually selected categories; category banner destinations use the same picker. Names and full category paths are visible, while native configuration continues to store IDs. Existing slug selections resolve by name without rewriting a draft until edited. Unavailable saved choices remain visible for replacement, and failed catalog requests preserve the selection and offer retry.

The builder reads `/v1/merchants/{merchant}/app-preview/categories`. The endpoint requires mobile membership and the server's trusted `MOBILE_CATALOG_ORIGINS` merchant binding, fetches only the storefront category list, and returns `id`, `parentId`, `slug`, and `name`. Missing bindings fail closed. The mobile ingress explicitly allows this route; core catalog administration remains inaccessible. Deploy the gateway, ingress, and mobile bundle together to enable this feature.

## Live preview catalog

App Studio reads `/v1/merchants/{merchant}/app-preview/catalog?locale=en|ar&collection=<category UUID or slug>` after authenticating the administrator and checking active mobile membership. Trusted operators configure `MOBILE_CATALOG_ORIGINS` as a JSON map of merchant UUIDs to HTTPS storefront origins. Unbound merchants fail closed. EC2 preserves this map in `deploy/ec2/state/mobile-catalog-origins.json`; the Rocento merchant is connected to `https://grocery.rocento.com`.

The read-only gateway fetches public categories and product search with the selected locale. It forwards no admin/customer credentials and follows no redirects, with bounded response sizes and request timeouts. The response projects names, category IDs/slugs, public images, effective catalog prices and availability; each collection returns up to 12 products. Unknown collections, unavailable sources and empty collections display explicit states rather than sample products or unrelated products. Availability and prices reflect anonymous storefront browsing and may change with customer, location and checkout context.

The preview cancels requests on merchant/locale changes, rejects mismatched response scopes and supports manual refresh. Category screens and configured category sections use real category names/images. No storefront cart, checkout or order is created by previewing the catalog.

Category tiles in home sections and the Categories tab open a collection product list inside the simulated phone. Product cards open details with the live image, name, price, unit and availability. Back returns through the product, collection and originating screen; selecting a tab clears the browse view. Merchant and locale changes discard the previous detail view. Browsing never edits the draft; use the separate Edit section button to select a home section. Each platform keeps independent preview navigation.

The product detail Add to cart button populates an independent in-memory preview cart for each device. Repeated additions merge by product ID; quantities range from 1–99, with native Remove one / Add one actions, a tab count and currency-aware subtotals. Out-of-stock products cannot be added, and currencies cannot be mixed. The cart survives locale and appearance changes, resets on merchant changes or page reload, and never writes drafts or calls storefront cart/order APIs. Prices are catalog snapshots; shipping and taxes are excluded.

Preview checkout follows iOS `CommerceView.swift` and Android `CommerceView.kt`. Cart quantities, delivery/pickup, branch selection, ASAP or scheduled dates, availability checks and per-source time slots stay on the Cart tab. iOS uses native-style pickers and a rounded quote panel; Android uses Material choices and inline review. Delivery addresses use an iOS sheet with a schematic map or an Android dialog with a simulated location action and manual coordinates. Pins and dates are validated. The quote shows subtotal, discount, delivery, tax, cash on delivery, total and expiry, as the current native apps do. Demo delivery costs 5 in the cart currency; pickup, discount and tax are zero. No card or wallet credentials are collected. Place order creates one PREVIEW reference, clears the bag, and shows order details/history. Simulate next status advances demo delivery or pickup statuses. Account lists the same orders. Changing quantities or fulfillment settings invalidates availability and quotes; changing tabs retains the flow. Merchant changes/reloads reset the cart and in-progress checkout; saved addresses and completed test orders remain isolated by merchant and platform in sessionStorage.

## Preview product discovery

Search in the simulated store header opens full-catalog search. Category pages also provide Filter & sort preselected to that category. Search accepts English/Arabic text, one category, a catalog price range and in-stock filtering. Ordering supports relevance, catalog price ascending/descending and name ascending. Apply with Search; Reset clears the filters. Results page in batches of 24 and open the same product details, preview cart and simulated checkout. Filters and results are scoped to the selected merchant and locale; superseded requests are aborted and stale responses discarded.

The membership-gated catalog endpoint accepts optional `q` (maximum 120 characters), `sort`, `in_stock`, `min_price`, `max_price` and `offset` (0–9999). It forwards an allowlisted query to the bound storefront search service; category filters still resolve against that storefront's categories. Price range and ordering follow storefront catalog search prices; displayed product prices include valid public offers. Section previews remain capped at 12 when `q` is absent. Discovery includes `total` and nullable `nextOffset`; no admin credentials are forwarded.

## Checkout failure simulations

Open **Checkout preview settings** below either phone to test unavailable delivery, a selected out-of-stock item, expired quotes, rejected orders, verification requirements, Android location permission denial or a lost confirmation response. Pending confirmation locks cart and fulfillment edits; Retry confirmation retrieves the same simulated order once. Failed orders retain the bag and require a fresh availability check/review. Expire quote now also exercises passive expiry. Reset scenario allows recovery. Scenarios are independent per device, translated into Arabic, and issue no customer, payment, inventory or draft writes.

## Saved preview addresses and wishlist

Account provides an address book with validated add/edit/delete, default selection, and an explicit Clear saved preview data action. Checkout selects the default saved address and supports choosing another. Native address dialogs save coordinates and address details to the same profile. Older saved addresses require completing a delivery pin before checkout. Product details expose a wishlist toggle; the Account link opens saved products with view and remove actions. Purchase actions run through product details so stock, variants and delivery checks remain in one place. When available, current catalog data takes precedence over saved product snapshots. Out-of-stock and cart currency/quantity restrictions still apply.

Saved data lives only in sessionStorage for the current browser tab, keyed by merchant UUID and simulated platform. It survives reloads and returning to that merchant, remains isolated between merchants and iOS/Android, and is hidden while signed out of the simulated account. Closing the tab or explicitly clearing saved preview data removes it; storage failures fall back to memory. No customer account, address, wishlist, draft or order API writes are made.

### Test order history and tracking

Successful native preview checkout saves an immutable snapshot of the purchased items, quantities, totals, delivery address or pickup branch, and requested schedule. Account → Your orders lists newest orders first and opens their details. Failed or unresolved confirmations do not create orders; confirmation retries retain a single reference.

Tracking is explicitly simulated with **Simulate next status**: placed → confirmed → preparing → shipped → out for delivery → delivered, or ready for pickup → picked up for collection. The timeline shows completed timestamps and upcoming stages, stops at completion, and supports English/Arabic. It does not request carrier updates or create real orders.

Order history uses `sessionStorage` under `rocento:preview-orders:v1:<merchant>:<platform>`, surviving reloads, merchant switches, and demo sign-out within the tab. Each merchant and preview device has separate history. **Clear saved preview data** clears orders along with saved addresses and wishlist. Blocked storage falls back to memory; malformed saved orders are ignored.

### Preview cancellations, refunds, and buy again

Orders can be cancelled while placed, confirmed, or preparing, with a required reason and explicit confirmation. Shipment and pickup readiness close cancellation. Cancellation stops tracking and persists with the order. Cash on delivery requires no refund. An explicit paid-order simulation enables pending → refunded or failed → retry → pending refund testing; no payments are collected or refunded.

Buy again reads fresh, membership-scoped catalog pages and matches immutable product IDs, including renamed products. It presents previous/current prices and requested quantities before the user adds eligible items. Missing/unverified products, invalid prices, unavailable stock, and incompatible cart currencies are skipped. Incoming quantities merge with the cart, capped at 99, and refresh the matched product's price. The original order remains unchanged. Reviews expire after 60 seconds; lookups stop at 50 pages or 30 seconds, with unverified products never added. Catalog failure leaves the cart unchanged. Pending checkout confirmation blocks reorder/cancellation controls. All changes remain in the tab's merchant/device preview state.

### Preview promo codes

The cart supports one demo promo at a time: `SAVE10` takes 10% off products, `SAVE5` takes 5 in the cart currency capped at the subtotal, and `FREESHIP` removes the demo delivery fee. `MIN50` tests a 50 minimum product subtotal for a fixed 5 discount; `FULLPRICE10` excludes products whose original price exceeds the current price; `EXPIRED` and unknown codes test errors. Codes are trimmed and case-insensitive. Invalid attempts preserve any currently selected valid code.

Totals use currency minor-unit rounding. Cart edits and fulfillment changes recalculate eligibility and invalidate quotes. Ineligible selected codes must be removed or made eligible before checkout. Pending confirmation locks promo edits. Confirmed orders snapshot their promo code, product discount, net delivery charge, delivery savings, and net total. Full simulated refunds use that net total. Successful checkout clears the promo; Buy again does not restore historical codes. Promo state is isolated by merchant/device and remains preview-only; production promotion APIs are never called.

### Native account preview

Account preview follows SwiftUI `CommerceView.signIn` and Android `AccountView.kt`: Sign in, Create account, Verify account, Forgot password, Reset password, and code resend. iOS uses rounded fields and a shield icon on recovery screens; Android uses outlined fields, Material buttons and its account icon. The signed-in identity uses the entered demo identifier and the checkout verification state. Existing saved addresses, wishlist and test-order history remain available.

The local `AccountForm` rules match both native apps: a nonblank identifier, a password for sign-in, 12–128 UTF-8 bytes plus matching confirmation for registration/reset, and a nonblank verification code where required. Switching modes retains the identifier and clears passwords, confirmation, codes, visibility and validation. Success follows registration → verification → sign-in and forgot-password → reset-password → sign-in. Resend is disabled without an identifier. English/Arabic, RTL and both phone widths are supported; the current palette limitation above still applies.

All account actions remain explicitly simulated: use demo credentials and any nonempty demo verification code. No customer is created, no password is changed, and no email/SMS or authentication request is sent. Native success wording is shown with a preview-only clarification. Passwords and codes are held only in the mounted form, never saved in sessionStorage, and are cleared on navigation or successful sign-in.

### Native category and product layouts

The Categories preview follows the native category rows and two-column product grid: iOS has forward chevrons and 16-point row padding; Android has Material cards with 20-point padding. Product artwork uses a 150-pixel area. Collection selection retains Back and Filter & sort as preview browsing conveniences, including empty/error/retry handling.

Product sheets follow `StorefrontView.swift` and Android `MainActivity.kt`: 220-pixel contained artwork, 34/32-point titles, price, optional catalog description, availability and Add to bag. iOS places Done in the toolbar; Android places it below the content in its bottom sheet. Closing restores focus and the originating category. The existing wishlist and simulated cart actions remain available. The Choose delivery address action leads to Account; preview shopping continues to use catalog snapshots and simulated availability. Address-specific variant inventory still requires the installed app.

The read-only mobile catalog projection includes nullable `description` from the existing localized search response. The preview renders it as plain text and omits it when absent; it does not fabricate product copy. Deploy the gateway update with the frontend to display descriptions.


## Runtime 1.1 tab icon controls

Navigation includes a per-tab icon selector with home, categories, cart, account,
wishlist and location choices. Saving an override sets both minimum runtimes to
1.1.0. Tab destinations and accessible labels are unchanged; launcher icons still
require a new binary. Later Deals navigation uses runtime 1.2. Use the canonical schema and minimum runtime validation for the edited feature; the [commerce history](history/commerce-2026-10-12.md) records the prior rollout.


### Published-version rendering comparison

`Preview source` selects the current draft or an immutable published version. Published previews disable section-edit controls and never copy the release into the draft. This keeps comparison with installed native apps meaningful while a newer design is being edited.

For runtime 1.1 home components, preview uses the same ordered sections, navigation icon tokens, 0/8/18/28 corner tokens, compact/comfortable 12/20 spacing, 96-point hero artwork, and 150-point rounded product artwork as native. Preview-only discovery shortcuts and header wishlist controls are excluded from this surface. Unresolved configured category IDs are omitted consistently. System font rendering and native navigation chrome remain platform-specific. Image completion must be checked separately from catalog-request completion before capturing comparison evidence.


### Native wishlist and matching preview

SwiftUI and Compose implement customer wishlists using the existing authenticated `GET /v1/customer/wishlist`, `PUT /v1/customer/wishlist/{id}`, and `DELETE /v1/customer/wishlist/{id}` endpoints. The feature flag controls the account entry and product save action. Configured wishlist tabs also render saved products. Account-backed native saves survive relaunch and sign-in on another device; logout and expired sessions clear in-memory saved-product state.

The native screens show Saved products, an empty-state Explore products action, 80-point artwork, current catalog price/currency and availability, View product, and Remove from wishlist. The list resolves 24 products at a time, supports more results, handles unavailable catalog items, and preserves the list on request failures with retry. Opening product details uses the normal purchase checks. Android system Back returns from wishlist to Account; iOS uses its navigation stack.

The builder follows this layout, with iOS text actions and Android Material buttons, plus Arabic/RTL; the current palette limitation above still applies. Its saved products remain simulated and scoped to merchant and preview device in session storage; it does not call customer wishlist APIs. Native source must be rebuilt and distributed separately from the App Builder web deployment.


### Native order history and tracking preview

The Account preview follows SwiftUI `orderDetail` and Compose `OrderDetailView`: plain order links show number/status, localized creation date and total/currency. The inline detail shows the current status and only recorded history entries, with Refresh status. Native screens do not show the preview's large progress hero, thumbnail receipt cards or predicted future stages.

Refresh status in the browser reports the existing simulated status without advancing delivery. The expandable Order preview tools panel retains explicit stage advancement, delivery/receipt details, cancellation/refund scenarios and reorder checks. These are preview utilities, not claims of equivalent native features. Real customer orders, payments and delivery status are never changed by these controls.



### Native notifications and settings

Account opens Notifications and App settings on iOS and Android. The inbox fetches authenticated order history on entry and Refresh updates, offers All/Unread and Mark all read, and opens an order detail with a return path to the inbox. Read IDs persist per customer on that installation; cached inbox data is cleared at logout/session expiry. Disabling Show order updates hides the inbox without changing order status. This is an in-app inbox, not push delivery.

Settings offers English/Arabic, System/Light/Dark appearance, order updates, and existing anonymous analytics consent. Native preferences survive restart. Preview controls follow SwiftUI picker/switch and Material chip/radio/switch layouts. Preview notification/read, appearance, and simulated analytics preferences persist per merchant and device within the browser tab. Preview analytics controls send no telemetry and preview orders remain simulated.



### Coordinated native header preview

The preview uses the native header arrangement: a 72×36 logo, saved delivery-location menu, compact assistant/language controls, and a search field beneath. The repeated body logo is removed. Navigation remains configuration-driven, including runtime-1.2 Deals and its icon. Deals browses catalog pages and shows discounted products, with retry, empty and pagination states. The assistant preview link opens the merchant’s HTTPS web assistant in a new tab and says so in its accessible hint. Existing radius controls are preserved.
