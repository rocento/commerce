# Rocento React Native

The third mobile implementation alongside SwiftUI and Kotlin/Compose. Expo SDK
57, React Native 0.86 and TypeScript now connect directly to the live Grocery
commerce API at `https://grocery.rocento.com/api`.

## Included

- Live categories, search, product images/details and delivery-aware variants.
- Native customer sign-in, registration, verification and password-reset forms.
- Secure session restoration, server cart and quantity controls.
- Saved addresses, coverage checks, delivery/pickup, ASAP/scheduled fulfillment.
- Server quotes, explicit order confirmation and persistent retry keys for an
  interrupted checkout; order history/details and manual status refresh.
- English/Arabic, system/light/dark appearance and responsive layouts.

Choose an address before checking stock or adding variants. The backend remains
responsible for pricing, availability, coverage and checkout validation. A quote
never places an order; the customer must press **Place order**. If its response is
lost, **Retry confirmation** uses the saved quote and the same order key.

Browser builds support public browsing. Customer authentication and shopping
require the native app, where refresh credentials can be stored securely. This implementation does not provide push notifications. Optional Studio builds
render all six home section types and private banner assets; full navigation and dark-theme parity remain open. Physical-device and store-distribution acceptance remain separate work.

## iOS visual alignment

The live Grocery UI uses the bundled SwiftUI Grocery palette, 8-point corner
radius, 20-point content spacing, delivery/search header, editorial hero and
outline navigation. `assets/grocery-logo.png` and `assets/grocery-hero.png` are
copies of the iOS bundled logo and hero assets (`b96b0c84-4d96-4df0-8718-5a8c44b1b119`
and `2c0ac9ca-43c0-4fd2-86f8-9a08a0ccadef`). Product columns collapse at large
font sizes and narrow widths; Arabic reverses the header, grid and navigation.
The five React Native destinations are Home, Categories, Deals, Account and Cart.
Account now uses the native guest welcome, signed-in overview, preferences,
address list/form and order list/tracking structure. Authentication, product
options and checkout use a shared sheet header with a Done action; cart and
checkout use the native warm surface, quantity controls, total rows and checkout
dock. Sheet transitions reset scroll position and render only one modal.
Deals scans the catalog for validated offers and shows original prices and savings.
Wishlist supports saved products, removal, unavailable products, pagination and
save-for-later from the bag. The shopping assistant streams responses, displays
product recommendations/comparisons, handles clarification, and reviews basket
proposals before explicit approval. Interrupted responses are never replayed;
cart and wishlist are refreshed before further actions. Conversations persist
when reopening the sheet and reset when the customer changes.
Optional Studio builds now supply all six configurable home section types; the [worker runbook](../../commerce-ops/deploy/native-preview/REACT_NATIVE.md) owns the supported rendering limits.

`npm run test:discovery-ui` checks deals, wishlist and assistant journeys with
isolated fixtures, including Arabic/narrow layout and interrupted responses.
Native screenshots for these screens are in
`output/react-native-discovery-20261013` at repository root.

For isolated native visual checks, start Metro with
`EXPO_PUBLIC_VISUAL_QA=1 EXPO_PUBLIC_DEMO=0 EXPO_PUBLIC_ACCEPTANCE=0 npm start`.
The development-only toolbar selects guest, customer, empty and unverified
fixtures. Transport and storage stay in memory, with no live network fallback or
production credentials. Set `EXPO_PUBLIC_VISUAL_QA=0` to return to live browsing.
Native screenshots from the 2026-10-13 iOS 26.2 and Android API 36 pass are under
`output/react-native-screen-parity-20261013` at repository root. Customer checkout
and order confirmation were exercised with fixtures, not production purchases.

## Run and build

Use Node.js 24.3+ and npm; dependencies are independent of the frontend workspace.
Native builds require Xcode/CocoaPods and the [shared Android SDK/JDK 21 prerequisites](development.md#prerequisites).

```sh
cd commerce-mobile-apps/react-native
npm ci
npm run prebuild -- --no-install
(cd ios && pod install)
NODE_OPTIONS=--dns-result-order=ipv4first npm start -- --port 8081 --localhost
```

In another terminal, run the signing-checked build/install scripts. Replace device
IDs and output directories with your own; each output directory must be new and
absolute. Android defaults to arm64 for Apple Silicon emulators; pass
`--architectures x86_64` where appropriate.

```sh
npm run ios -- --simulator YOUR_SIMULATOR_UDID --output /absolute/new/ios-build --install
export JAVA_HOME="$(/usr/libexec/java_home -v 21)"
export ANDROID_HOME="$HOME/Library/Android/sdk"
npm run android -- --serial YOUR_EMULATOR_SERIAL --output /absolute/new/android-build --install

xcrun simctl launch YOUR_SIMULATOR_UDID com.rocento.preview.reactnative -RCT_jsLocation localhost:8081
"$ANDROID_HOME/platform-tools/adb" -s YOUR_EMULATOR_SERIAL reverse tcp:8081 tcp:8081
"$ANDROID_HOME/platform-tools/adb" -s YOUR_EMULATOR_SERIAL shell am start -n com.rocento.preview.reactnative/.MainActivity
```

Keep Metro running for these Debug builds. `npm run web` opens public browsing.
`npm run bundle` exports JavaScript/Hermes bundles; it does not create an APK/IPA.
Generated native projects are ignored; preserve native settings in Expo config
and plugins. Use the checked build scripts for installations, including upgrades.

## Credential and signing contract

The bundle/application ID remains **`com.rocento.preview.reactnative`**, distinct
from the Swift/Kotlin apps. Follow the parent [iOS](../../commerce-mobile-apps/ios/SIGNING_AND_KEYCHAIN.md)
and [Android](../../commerce-mobile-apps/android/SIGNING_AND_KEYSTORE.md) contracts. The scripts compare
installed identity before installation and never uninstall or clear user data.
The iOS script creates signed simulator builds; release provisioning needs its
own approved identity. Retain the Android signing key for subsequent updates.

The native adapter uses Expo SecureStore with service
`com.rocento.reactnative.commerce.v1`, `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, and
merchant-scoped keys beginning `rocento.rn.v1.production.`. Only the refresh
credential and per-customer pending checkout are persisted; access tokens remain
in memory. Logout removes the session while retaining an unresolved order attempt
for the same customer to recover later. Tokens never enter image requests, logs,
URLs or browser storage. Requests stay on the fixed merchant API origin, reject
redirects, and do not use a shared cookie jar.

## Architecture and optional demos

`App.tsx → src/ui → src/core`; screens receive a core-owned
`StorefrontConfiguration`. `src/platform/commerce.ts` provides native transport
and secure storage, while `.web.ts` exposes public browsing only. Core and screens
need no App Studio server, enrollment, adapter or remote builder configuration.
The repository boundary guard scans this app’s TypeScript/JavaScript sources.

`ShoppingSession` composes `CheckoutFlow`, `DeliveryForm`, `AccountStore`,
`CartStore`, `OrderStore`, `NavigationStore` and a FIFO `OperationCoordinator`. Screens subscribe to feature
snapshots through `useSyncExternalStore`; customer changes reset in-memory state
and invalidate queued work. Cart and delivery mutations respect unresolved
checkout recovery. Persisted attempts and credentials remain in `CommerceClient`
and the platform storage adapter. `CatalogStore` owns search, paging and product
details; `AssistantStore`, `AssistantProposalStore` and `ProductPromptStore` own
conversation streaming, proposal recovery and assistant product searches. See the
[state ownership guide](architecture.md#checkout-state-ownership) and
[catalog/assistant guide](architecture.md#catalog-and-assistant-state-ownership).
`WishlistStore` and `NotificationsStore` share the session lifecycle and commerce
queue. The account inbox supports order-history updates, read/unread filtering and
pausing updates. Native read markers use the separate
`com.rocento.reactnative.notifications.v1` SecureStore service with merchant and
customer scoping; web fixtures keep these preferences in memory. See the
[wishlist/inbox guide](architecture.md#wishlist-and-notification-state-ownership).

`EXPO_PUBLIC_DEMO=1 npm start` enables the retained offline Market/Boutique preview.
Demo catalog copies in `src/core/data` and the isolated acceptance fixture in
`src/testing` are synchronized from `../shared` by `npm run catalog:sync`;
`catalog:check` detects drift. Metro separates live/demo/acceptance cache entries.

## Verify

```sh
npm run catalog:check
npm run typecheck
npm test
npm run bundle
npx playwright install chromium --only-shell
npm run test:ui
npm run test:live-ui
python3 ../tools/check_boundaries.py
python3 -m unittest discover -s ../tools/tests -v
```

Unit tests cover refresh races, logout, cart validation, fulfillment/quote,
checkout persistence/deduplication and storage failures. Browser tests cover both
demo and live screens using isolated responses. They never create live orders.

For native storage acceptance, run a second Metro server with
`NODE_OPTIONS=--dns-result-order=ipv4first EXPO_PUBLIC_ACCEPTANCE=1 EXPO_PUBLIC_DEMO=0 npm start -- --port 8096 --localhost`.
Launch iOS with `-RCT_jsLocation localhost:8096`. For Android, stop the live
Metro server and run the same acceptance command on port 8081 (the emulator’s
default host is `10.0.2.2:8081`; reversing ports alone does not change that). Stage 1 saves a fixture session and interrupted checkout.
Terminate and relaunch the app: stage 2 restores both, recovers the order using
the saved key, then verifies logout. This development-only harness has no network
fallback and uses a separate SecureStore service and keys. Restore port 8081 and
the live launch afterward. The acceptance entrypoint is disabled in release mode.

Dated local process-restart and live guest checks are recorded in [React Native acceptance history](history/react-native-2026-10-12.md).

## Dependency mitigations

Dependency mitigation (2026-10-14): `xcode` uses `uuid@11.1.1`. Two currently
unpatched upstream advisories in `braces@3.0.3` and `node-forge@1.4.0` are mitigated
by `scripts/patch-dependencies.cjs` during installation. Exact before/after source
hashes reject unexpected dependency drift. Run `npm run test:dependencies` after
any dependency change; CI also runs it. Do not skip installation scripts.

Braces parsing and AST traversal have bounded nesting. The forge patch checks
nested DigestAlgorithm length using the [upstream proposed correction](https://github.com/digitalbazaar/forge/pull/1152).
Replace these temporary patches with verified upstream releases when available.
`npm audit` still reports 15 high package entries because its advisory matching
uses package versions, not the patched source. See the
[mobile review](history/architecture-review-2026-10-14.md)
for details and current verification results.

`npm run audit:dependencies` retrieves the unfiltered upstream audit, rejects any
advisory outside the two documented local mitigations, and verifies every patched
source file's exact hash. CI runs it alongside the exploit regression tests.
It prints the upstream counts explicitly: 15 high transitive entries remain until
braces and node-forge publish reviewed fixes. Expo/Metro require these chains;
downgrading Expo/React Native to npm audit's suggested older major versions would
break this app's supported stack. No advisory exclusions or falsified versions
are used to claim a clean dependency tree.


State and lifecycle ownership is documented in [architecture](architecture.md), including authentication forms, settings, orders, navigation, feedback and operation loading.

## Optional local Apps Builder preview

The separately selected Studio build receives saved draft updates while running
as a real iOS or Android app. Local acceptance and the shared Android EC2 deployment
are recorded in the [mobile history](history/README.md); intermittent Android stalls remain open. See [the React Native worker runbook](../../commerce-ops/deploy/native-preview/REACT_NATIVE.md)
for build commands, worker configuration, authentication and current rendering limitations.
Normal builds keep the standalone entry and do not include the Studio transport.
