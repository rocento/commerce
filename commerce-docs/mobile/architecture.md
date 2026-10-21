# Mobile architecture and state ownership

This guide owns native module boundaries and feature state for SwiftUI, Kotlin/Compose and React Native. See [capability status](README.md), [development](development.md), [configuration contract](configuration-contract.md), and [native preview](native-preview.md).

## Editor dependency boundary

Swift, Kotlin and React Native apps must never depend on the Apps Builder editor
implementation. Versioned definitions, native runtime components and authorized
configuration delivery are the integration boundary. `RocentoAppBuilder` is the default Swift merchant delivery adapter; Android
`app-builder` remains optional. Neither contains editor implementation.

The 2026-10-13 source and manifest audit found no editor dependencies: Swift
packages point to native core, Gradle includes the delivery adapter only by opt-in,
and React Native has its own dependencies and Metro configuration. Contract models
originate in `commerce-api/rocento-api/crates/domain-mobile/contract/v1`; map sources originate in
`commerce-mobile-apps/shared/maps`. Generators also write editor copies, but do not read editor
implementation to produce native resources.

Run `python3 commerce-mobile-apps/tools/check_boundaries.py` and
`python3 -m unittest discover -s commerce-mobile-apps/tools/tests -v`. The editor guard covers
all three platforms, shared resources, optional adapters, manifests, lockfiles,
bundler configuration and Xcode generation. It rejects frontend implementation
references, known editor package/module names and symlinks outside mobile.
Generated build output and vendor trees are excluded; their dependency manifests
remain checked. This is a static source/build-input guard, not a proof about
arbitrary dynamically constructed paths or third-party package contents. Existing
standalone artifact checks separately reject linked configuration adapters.

## Checkout state ownership

All three implementations use a core-owned `CheckoutFlow`:
[Swift](../../commerce-mobile-apps/ios/RocentoCore/Sources/RocentoCore/CheckoutFlow.swift),
[Kotlin](../../commerce-mobile-apps/android/core/src/main/java/com/rocento/mobile/CheckoutFlow.kt), and
[TypeScript](../../commerce-mobile-apps/react-native/src/core/checkout.ts). It owns delivery options, selected
slots, the reviewed quote and transitions through editing, loading options,
quoting, ready, submitting, uncertain and completed. Native shopping models forward
its state to their screens; Kotlin exposes immutable snapshots through `StateFlow`,
and React Native subscribes with `useSyncExternalStore`.

Use flow actions to invalidate a review or select a slot; do not write quote and
uncertainty flags independently. Session changes reset in-memory state and invalidate
outstanding responses. Cart/delivery edits cannot clear a submitting or uncertain
checkout. Duplicate submissions are rejected, and a storage-read failure preserves
the unresolved quote. Only an explicit confirmation can retry an interrupted order.
`CommerceClient` continues to own persisted attempts and idempotency keys; their
storage format and signing identities are unchanged. Cart/history refreshes occur
after checkout completes and cannot turn a confirmed order into an uncertain one.

Each platform now composes these core features in `ShoppingSession`:

- `DeliveryForm` owns the address draft, saved locations and fulfillment selection.
  Coverage validation and edits invalidate the reviewed quote when editing is safe.
- `OperationCoordinator` serializes commerce actions in arrival order. Callers must
  not await another queued action from inside an active action. Public catalog
  discovery keeps its separate cancellation path.
- `AccountStore` owns customer identity and account operations.
- `OrderStore` owns order history, paging, detail selection and request status.
- `NavigationStore` owns tabs, account destinations, cart panels and back behavior.
- `CartStore` owns cart snapshots and mutations, invalidating the quote before a
  mutation and rejecting edits while checkout is unresolved.

Customer changes clear in-memory feature state, discard stale responses and cancel
queued actions from the previous session. Persisted checkout attempts remain owned
by `CommerceClient`; reload restores an unresolved attempt before delivery or
history requests can fail. Native shopping models forward store state to screens;
React Native subscribes to the stores with `useSyncExternalStore`.

Core feature tests cover queue ordering, cancellation, stale responses, failed
mutations, delivery edits, account reset and interrupted-checkout recovery.
`npm run test:checkout-ui` in `react-native` exercises review, edit and confirmation
in English and Arabic using isolated fixtures.

## Catalog and assistant state ownership

All three platforms use core-owned `CatalogStore` and `AssistantStore` features.
Native storefront models and React Native screens forward actions and observe
their state; navigation, focus, sheet visibility and layout remain in the UI.

- `CatalogStore` owns catalog results, filters, paging and product/variant data.
  New selections and locale changes invalidate earlier responses. Dismissal also
  invalidates an in-flight product request. Paging advances by raw result count
  while visible products are deduplicated, so hidden or repeated hits do not stall
  pagination. Failed next-page reads preserve already loaded results.
- `AssistantStore` owns conversation identity, bounded turn history, drafts,
  streaming progress, interruption and sign-in state. Customer changes reset the
  conversation and reject late events. A stopped stream refreshes the bag without
  replaying the request; new sends stay blocked until that refresh finishes.
  Checkout navigation requires a successfully completed, validated command.
- `AssistantProposalStore` owns proposal loading, approval eligibility and an
  unresolved approval outcome. Further attempts check status while unresolved;
  proposal approval continues to use the shared commerce queue and stable key.
- `ProductPromptStore` owns assistant search results and comparison selections,
  discarding late results and clearing selections when the search changes.

`DiscoveryStoreTests` (Swift/Kotlin) and `discoveryState.test.ts` cover stale
responses, raw paging offsets, cancellation, account reset and proposal recovery.
React Native's `test:discovery-ui` covers product discovery, assistant streaming
and explicit proposal approval against isolated fixtures.

## Wishlist and notification state ownership

`ShoppingSession` composes `WishlistStore` and `NotificationsStore` on all three
platforms and resets both when customer identity changes.

- `WishlistStore` owns saved IDs, resolved product data, paging, loading and failure
  state. Missing or inactive products remain removable entries. Reads commit a
  complete page; failed refreshes or removals preserve the last successful state.
  Locale changes clear old product translations. Product saves, cart save-for-later
  and assistant refreshes use this shared store through the commerce queue.
- `NotificationsStore` builds the in-app inbox from authenticated order history.
  It owns paging, deduplicated events, read markers, the unread filter and the
  order-updates preference. Read markers are scoped to the customer. A failed
  detail read preserves the previous inbox and paging offset; a session reset
  rejects late responses. Pausing updates prevents further inbox fetches.

Native preference adapters retain the existing UserDefaults/SharedPreferences
keys. React Native adds an account inbox with a separate, merchant-scoped native
notification preference store; browser fixtures keep preferences in memory.
APNs/FCM registration, OS permission handling and push delivery remain in platform
adapters. No credential-storage keys or signing identities change.

`SavedStateTests` (Swift/Kotlin) and `savedState.test.ts` cover unavailable products,
failed mutations, paging, account resets and read-marker restoration. React
Native discovery tests exercise wishlist actions and the English/Arabic inbox.

## Authentication form and app settings state ownership

`AuthenticationFormState` in Swift/Kotlin and `AuthenticationForm` in React Native
own authentication fields, local validation, password visibility, secret clearing,
and successful mode transitions. Screens retain focus and translated messages.
The state is memory-only; never use saved-instance state or preference storage for
passwords, confirmations, or verification codes. Closing a form or changing modes
invalidates its submission snapshot so late success cannot advance a newer form.
Account requests continue through `AccountStore` and the shared operation gate.

`AppSettingsStore` owns language and, on native apps, analytics consent state.
Platform composition supplies persisted language and storage callbacks; analytics
is published only after the existing consent service succeeds. Settings survive
customer changes. Notification preferences remain owned by `NotificationsStore`,
and OS push permissions remain in the platform adapters.

Existing native language and analytics storage keys are preserved. React Native
persists language in a separate merchant-scoped settings SecureStore service;
web fixtures use memory storage. React Native does not add an analytics service.
Core tests cover secret clearing, stale completion, preference restoration and
failed consent/storage writes. Browser tests exercise form mode changes and
navigation without sending live authentication requests.

## Navigation and order history state ownership

`ShoppingSession` composes `NavigationStore` and `OrderStore` in Swift, Kotlin and
React Native. Navigation holds transient destinations; catalog/product data remains
in `CatalogStore`, and order payloads never become route parameters. Native facades
forward tab, assistant, account and cart-panel state; React Native subscribes to
navigation snapshots. Platform presentation, animations, focus and OS push parsing
remain in the UI/platform layer.

Order history and details no longer live in `AccountStore`. `OrderStore` owns
loading, failure, paging offsets, end-of-list status, selected order ID and detail
snapshots. Pagination advances by the raw response length while displayed IDs are
deduplicated. An empty page ends pagination. Failed refreshes retain the last good
history; selecting a different order clears the previous detail and supports retry.
History and detail revisions are independent so a slow request cannot replace a
newer selection, a checkout result, or a new customer's state.

Back from order details returns to the history/inbox entry point. Leaving details
invalidates outstanding detail reads. Customer changes clear order data and private
routes, and tab changes dismiss panels. Cart routing does not reset checkout
recovery or its persisted attempt. Native push notifications retain their existing
customer checks before opening order details.

Regression tests cover duplicate-page offsets, failures and retry, late responses,
checkout detail replacement, customer resets and back navigation. Local browser
fixtures cover history/detail/back/sign-out in English and Arabic, alongside the
existing notification and checkout journeys.

## Error feedback and operation loading ownership

`FeedbackStore` owns shared error and notice state in all three cores. `AppFailure`
(`mapFailure` in TypeScript) maps commerce validation, authentication, permission,
conflict, rate-limit and server failures into typed presentation data. Cancellation
is silent; unknown errors use a localized fallback rather than raw diagnostics.
Existing commerce messages remain intact. Error and notice dismissal are separate,
so a failed follow-up read can coexist with a confirmed checkout notice.

`ShoppingSession.perform` composes feedback, the existing operation gate and the
platform's established expired-session policy. Messages clear when an action starts,
not when it enters the queue. Customer changes clear feedback. A 401 error is
published after the account reset so it remains visible. The store never retains
exceptions, credentials or retry closures and never retries an action automatically.
Assistant streaming and feature-specific failures continue to belong to their stores.

`OperationCoordinator` owns typed `OperationLoadingState`: active work, queued work,
and an initial-load, refresh or mutation kind. UI busy state and accessible progress
labels consume that snapshot. Success, error and cancellation release loading state;
cancelling queued work does not clear feedback from the active operation. Feature
stores retain their own initial/refresh/paging state and last good content, while
checkout retains its submission and uncertainty rules. Native configuration loading
remains part of the build-selected configuration composition.

Regression tests cover failure categories, safe fallback messages, silent cancellation,
queued-message timing, loading cleanup, identity reset, explicit dismissal and
confirmation followed by a failed refresh. English/Arabic browser tests also verify
that an isolated coupon network failure keeps the previous cart and re-enables actions.

### App orchestration

Swift, Kotlin, and React Native compose `ShoppingWorkflows` in `ShoppingSession`.
The workflow receives account recovery, checkout/delivery/cart/order refreshes,
identity revision, and cart/wishlist actions as dependencies. Screens invoke
`workflows.recover()` inside the existing operation gate. Guest recovery stops
before authenticated content reads; signed-in recovery restores pending checkout
before optional delivery, cart, and history requests. Failures stop the sequence
and remain retryable. Identity changes cancel subsequent recovery and save-for-later
follow-ups. Workflows do not acquire the gate themselves, avoiding nested waits.

React Native's platform `createShoppingRuntime` composes settings preferences,
notification preferences, and the shopping session. Startup restores preferences
before account recovery, tolerates preference failure, and cancels pending startup
continuation when the runtime is disposed. Platform credential storage and native
composition follow the platform rules in the development guide.

`ShoppingActions` now owns checkout completion, saved/guest delivery updates,
assistant proposal/product mutations, assistant refreshes, and authentication
transitions on all three platforms. The existing operation gate wraps actions
once at the UI adapter. Successful checkout publishes the order and invokes the
confirmation callback before optional cart/history reads. Follow-up errors are
reported without retrying placement or removing the confirmation notice.
Identity checks separate each awaited cross-feature step. Delivery validation
and quote locking remain in `DeliveryForm`/`CheckoutFlow`; guest addresses skip
customer cart reads. Login and verification reuse checkout-first recovery;
logout runs the platform push-unregister hook before account cleanup. UI adapters
retain localized feedback, analytics, navigation, and authentication form edits.

### State ownership after composition cleanup

Each app enters shopping through `ShoppingRuntime`. Native app composition supplies
its commerce client, catalog provider, settings persistence, notification adapter,
and (Android) lifecycle scope. SwiftUI/Compose models adapt the runtime's stores
for rendering; they do not construct another shopping session or reset assistant
state. The iOS session resets its assistant; the Android runtime owns and resets
its scope-bound assistant. Native runtime wiring also dismisses catalog selection
on identity changes. Settings survive account resets.

React Native's platform factory injects persistence into the core runtime. That
runtime owns the session, settings, authentication form, locale propagation, and
navigation/identity subscriptions. Disposal disconnects these subscriptions and
clears transient state; restart reconnects once. Form-secret clearing is idempotent.
Cart mutations and delivery edits own quote invalidation; views retain only explicit
review editing and refresh invalidation. Order state resets once per identity change,
without a second reset from navigation leaving the order panel.

Native render-revision counters remain observation bridges, not competing domain
state. RN product quantity/variant selections, filter-results presentation, and
retry triggers remain screen-local because their lifetime and meaning differ from
persisted feature state. Native configuration loading remains independent of
customer operation loading.

## Definition and editor boundary

### Architectural decisions

Standalone apps must build without Studio or enrollment. Dependencies point from app to core, optionally through a native delivery adapter; core never imports the editor or builder adapter. Merchant identity, signing, runtime compatibility and tenant authorization remain mandatory. Configuration is data and allowlisted behavior, never remotely supplied executable code.

### Ownership and entry points

- **Builder:** `commerce-web/apps/mobile-studio/src/main.tsx` mounts `MobileStudio`, which owns configuration authoring, conditional autosave and draft/published selection. `MobilePreview` owns the browser simulation; all four target choices use this one DOM renderer. Native-looking browser component names do not make them native code.
- **Contract:** `commerce-api/rocento-api/crates/domain-mobile/contract/v1/schema.json` is authoritative. `commerce-mobile-apps/tools/generate_contract.py` produces Swift/Kotlin models and copied schemas; the API-client generator produces browser validation. Schema version and minimum runtime capability version are distinct.
- **Native core and rendering:** `RocentoCore` and Android `core` own configuration/presentation and commerce models. SwiftUI `Storefront` and Compose app screens consume the core-owned `StorefrontConfiguration` boundary. Standalone apps use bundled configuration; Studio composition optionally supplies configuration delivery. React Native's `index.ts` → `App.tsx` selects its independent live/demo storefront and development-only QA hosts. Optional `index.studio.ts` selects the draft adapter in `src/integrations/appBuilder`; the shared native renderer remains independent of Studio transport.
- **Delivery:** iOS `RocentoAppBuilder` and Android `app-builder` remain valid native adapters. They do not import the React editor. Published enrollment/cache/asset delivery is distinct from memory-only draft overlays. Standalone builds exclude builder implementation at compile time.
- **Preview infrastructure:** SwiftUI, Kotlin and React Native Studio builds connect to explicitly authorized sessions. `DraftPreviewRuntime` polls full snapshots every four seconds, applies validated revisions, then ACKs revision/checksum; failures retain the last valid design and back off. The builder polls session status every three seconds. These are complementary data/control-plane reads, not competing revision authorities. No WebSocket or JSON patch transport is currently required.

### Compatibility and isolation

Draft revision belongs to the server draft sequence. `configVersion` belongs to publication. Neither browser rendering nor successful saving means native application; ACK does not mean frame visibility. Published caches, enrollment credentials, customer sessions and preview bearer capabilities remain separate. A late published refresh cannot overwrite an applied draft.

The supported browser preview must remain until a replacement covers its authoring and simulated shopping behavior. Catalog retry/manual refresh fetches catalog data; published refresh fetches published configuration. These refresh operations are independent of draft synchronization.

Token semantics currently use the canonical brand palettes, radius token and density. Browser preview selects `brand.light`; platform-native light/dark rendering exists.
