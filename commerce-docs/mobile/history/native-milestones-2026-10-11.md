# Native milestones — 2026-10-11 and 2026-10-12

Historical Milestone 2 and builder-isolation records. Statements about unimplemented commerce, enrollment and publishing describe those checkpoints and are superseded by the [current mobile status](../../README.md), [development guide](../development.md) and [commerce guide](../commerce.md). Commands below are retained evidence; use the current development/signing procedures for new runs.

Current builds default to standalone native apps. App Studio integration is an optional Swift package/Android module; see the [standalone build and module guide](../development.md#standalone-apps-and-optional-app-studio). The configuration delivery/cache behavior recorded below applies to Studio builds. Core commerce and bundled presentation work without enrollment or an App Studio service.

The dependency boundary applies to Swift, Kotlin and React Native applications: native apps must never depend on the Rocento Apps Builder editor implementation. They consume versioned app definitions through native runtime components and authorized configuration delivery. The optional builder modules listed below are configuration-delivery clients, not editor dependencies; native builds and runtime operation must remain independent of editor source, UI, state, internal models and availability. See the [architectural decisions](../architecture.md#architectural-decisions).

Production Rocento Grocery commerce is covered separately in the [Milestone 4 implementation guide](../commerce.md). The preview-specific behavior and earlier evidence below describe Milestone 2.

Milestone 2 adds shared SwiftUI and Jetpack Compose engines under [mobile](../README.md), with distinct Demo Market and Demo Boutique app identities. The two backend merchant fixtures are rendered on both platforms. This is local proof-of-concept acceptance; device enrollment, production endpoints, image delivery, customer authentication, checkout and signed store distribution remain future work.

## Source map

| Source | Responsibility |
| --- | --- |
| [Canonical contract](../../../commerce-api/rocento-api/crates/domain-mobile/contract/v1/schema.json) | Closed schema shared with backend validation |
| [Generator](../../../commerce-mobile-apps/tools/generate_contract.py) | Deterministic Swift Codable/Kotlin serialization models and bundled schema/fixture copies |
| [Swift core](../../../commerce-mobile-apps/ios/RocentoCore) | Local presentation validation, bounded transport, Keychain sessions and commerce/catalog clients |
| [Optional Swift builder](../../../commerce-mobile-apps/ios/RocentoAppBuilder) | Enrollment, published configuration cache and private asset delivery |
| [SwiftUI app](../../../commerce-mobile-apps/ios/Storefront) | Shared native views and typed navigation |
| [Xcode project generator](../../../commerce-mobile-apps/tools/generate_xcode_project.py) | Two app targets and two UI-test targets from identical source files |
| [Android core](../../../commerce-mobile-apps/android/core) | Commerce/catalog clients, local presentation and bounded transport |
| [Optional Android builder](../../../commerce-mobile-apps/android/app-builder) | Enrollment, published configuration cache and private asset delivery |
| [Android app](../../../commerce-mobile-apps/android/app) | Compose renderer, Keystore sessions and build-selected integration |
| [Shared demo catalogs](../../../commerce-mobile-apps/shared/catalog) | Merchant-bound English/Arabic product fixtures |
| [Native CI workflow](../../../.github/workflows/mobile.yml) | Contract drift, unit tests, builds, lint and simulator/emulator navigation tests |

## Implemented behavior

The compiled identity fixes merchant, environment, platform, runtime and HTTPS config/commerce origins. Remote configuration cannot change an endpoint or merchant. Every config is checked against the bundled closed schema, tenant identity, native runtime, contrast rules, required navigation, translation keys and RTL constraints before use. Unsupported section/action types fail validation; there is no web view or executable configuration.

Native switches register `heroBanner`, `productCarousel`, `productGrid`, `categoryGrid`, `richText` and `spacer`. The two milestone fixtures exercise hero and carousel rendering. Theme tokens control palettes, system typography, corner radius and density. System dark appearance selects the dark palette. Arabic uses native RTL layout, with decorative art excluded from accessibility and descriptive product/action labels. Large text changes product grid/carousel sizing. Screen-reader interaction and real-device accessibility review are still required.

Startup uses a valid last-known-good snapshot or a validated bundled config. A session enables conditional config requests with `If-None-Match`; a successful response must match the exact raw-body SHA-256 and ETag before an atomic cache write. Cache identity includes merchant, environment, platform and config origin. Cached bytes are revalidated after restart. Older versions and changed bytes under an existing version are rejected; backend rollback must publish a new version, as in Milestone 1. Missing auth skips the network, unauthorized responses surface a reconnect error, and invalid/offline/incompatible responses preserve the last good config. `ConfigSnapshot.source` identifies `bundled`, `cache` or `network`; there is no remote telemetry in this preview.

Config bodies are capped at 128 KiB, cache envelopes at 200 KB, and catalog responses at 2 MB. Default HTTP transports reject redirects and have a 15-second request/call timeout. Config tokens use iOS Keychain or Android Keystore AES-GCM encryption, with Android backup/transfer exclusions. No session or signing secrets are embedded.

`CommerceCatalog` calls the existing `/v1/catalog/categories`, `/v1/search` and `/v1/catalog/products/{id}` routes through the immutable merchant installation URL. Category slugs resolve to category IDs. Public catalog requests set `X-Storefront-Locale` and never receive the config enrollment bearer. Isolation still depends on selecting the correct trusted installation at build time and enforcing ownership at the server. The runnable targets deliberately select `FixtureCatalog`, using distinct merchant catalogs with product-detail lookup. Adapter request construction and credential separation are unit tested; live catalog integration is not accepted yet.

## Run and verify

### Admin design parity — runtime 1.1

`apps.rocento.com` uses the canonical mobile configuration for its editable light/dark colors, corner radius, density, registered home components and tab order. The browser preview reads the current draft; native apps read the published configuration on config refresh. SwiftUI and Compose retain platform-native typography, controls and icon shapes, so the browser previews are approximations of the operating-system rendering.

Navigation now exposes a per-tab icon selector. Optional `navigation.icons` maps tab identifiers to the registered `home`, `categories`, `cart`, `account`, `wishlist` or `location` icon. Omitted entries keep the original tab icon. The selection changes presentation only; tab destinations and accessible labels remain unchanged. Unknown tabs and icon identifiers are rejected by the canonical schema.

Saving an icon choice sets both minimum runtimes to `1.1.0`. Deploy the updated gateway and Studio together, and distribute native runtime 1.1 before publishing icon choices. The gateway rejects icon configurations missing that minimum and does not serve them to runtime 1.0. Existing installations retain their last valid configuration; existing releases without icon overrides continue to work. Launcher icons and launch splash artwork still require a native build.

Local validation on 2026-10-12: admin typecheck/build; 21 admin/preview tests, including English/Arabic and light/dark token/component/icon reflection; 3 Rust validation tests; 26 Swift core tests and an iOS simulator build; 26 Android core tests and debug APK build; a browser test verifies icon editing, both previews, autosave and reload persistence. Production deployment and simulator/emulator acceptance subsequently passed; saved draft revision 35 is live as v5. See the runtime 1.1 follow-up in [mobile commerce](../commerce.md). Fresh native verification on 2026-10-12 passed again on both platforms, with both complete configuration caches matching v5; the newer deployed Studio bundle retains the icon controls. No additional rollout is pending for these controls.

From the repository root:

```sh
python3 mobile/tools/generate_contract.py --check
swift test --package-path mobile/ios/RocentoCore
xcrun simctl list devices available
xcodebuild -project mobile/ios/RocentoMobile.xcodeproj -scheme Market \
  -destination 'platform=iOS Simulator,name=YOUR_AVAILABLE_IPHONE' \
  -derivedDataPath mobile/ios/DerivedData CODE_SIGNING_ALLOWED=NO test
xcodebuild -project mobile/ios/RocentoMobile.xcodeproj -scheme Boutique \
  -destination 'platform=iOS Simulator,name=YOUR_AVAILABLE_IPHONE' \
  -derivedDataPath mobile/ios/DerivedData CODE_SIGNING_ALLOWED=NO test
```

These unsigned Market/Boutique commands cover fixture tests on an isolated test
simulator. They do not verify Keychain persistence and MUST NOT be reused to
replace an enrolled or signed-in merchant app. For credential acceptance, use
the [mandatory signed simulator build and Keychain checks](../../../commerce-mobile-apps/ios/SIGNING_AND_KEYCHAIN.md).

Use the same available simulator name in both commands. Xcode 26.2 with an iOS 26.2 iPhone 17 Pro simulator was used locally; deployment minimum is iOS 17. `python3 mobile/tools/generate_xcode_project.py` regenerates the checked-in project and schemes when target settings change.

Set `JAVA_HOME` to a JDK 21 installation and `ANDROID_HOME` to the Android SDK, then run:

```sh
mobile/android/gradlew -p mobile/android \
  :core:testDebugUnitTest \
  lintMarketDebug lintBoutiqueDebug \
  assembleMarketDebug assembleBoutiqueDebug
mobile/android/gradlew -p mobile/android \
  connectedMarketDebugAndroidTest connectedBoutiqueDebugAndroidTest
```

Start an emulator or attach a test device before the connected tests. Local checks used an API 36 ARM64 emulator, compile SDK 35, Gradle 8.14.3 and JDK 21. Debug APKs are in `mobile/android/app/build/outputs/apk/{market,boutique}/debug/`. Android lint reports are under `app/build/reports`; Xcode test results are under `mobile/ios/DerivedData/Logs/Test`.

## Local acceptance — 2026-10-11

- Shared generated contract/resources match the canonical schema and fixture bytes.
- Swift core: 5 passing tests covering both merchants, strict validation, config compatibility, checksum/ETag, cached/offline recovery, restart, corruption, version replay, merchant/environment isolation and commerce credential separation.
- Android: 6 core tests per flavor covering equivalent cases plus redirect rejection and a real bounded HTTP response using MockWebServer.
- iOS: 2 passing UI tests per merchant for catalog → product detail → dismiss → Arabic category navigation, plus Arabic launch at accessibility text size.
- Android: native catalog → product detail → dismiss → Arabic category navigation passes for both flavors.
- Both iOS targets and Android debug variants build locally. Android lint has no errors; dependency-update and style suggestions remain informational.
- Visual review covered both merchants in English/light appearance, Arabic/dark appearance, iOS accessibility XXXL text and Android font scale 1.6. Emulator appearance settings were restored after review.
- Simulator screenshots and command logs are retained locally under `output/rocento-mobile-m2-20261011/`. CI is configured but has not been run remotely.

## Remaining boundaries

The previews use reserved `.example.test` endpoints, illustrative native hero/product artwork and bundled catalogs. Asset IDs are contract-validated, but actual merchant image resolution/downloads and build-time app icon/splash provisioning are not implemented. Device enrollment must provision a short-lived config session before remote config delivery can run. Production builds must supply verified merchant-specific HTTPS origins and select the live commerce adapter; remote config must never choose those origins.

Cart, account and optional wishlist tabs are placeholders. Payment, customer sessions, orders, delivery, reviews, deep links, push, analytics, release signing and store submission belong to later milestones. Full live commerce E2E, small-device/tablet/landscape checks, VoiceOver/TalkBack review and real-device acceptance remain required before production. The next roadmap milestone is the merchant dashboard editor and publish workflow.


### Preserve installed production test-app data

For an already enrolled Rocento emulator, build with `assembleRocentoDebug` and
`assembleRocentoDebugAndroidTest`, install both APKs using `adb install -r`, and
invoke the opt-in test class using `adb shell am instrument`. Do not run Gradle's
`connectedRocentoDebugAndroidTest` against that installation: its test runner uses
`uninstall_after_test`, which removes enrollment and customer-session data.
`CategoryLiveTests` accepts `rocentoLiveReadOnly=true` and verifies category
navigation, minimum-price filtering, and reset against the public catalog.

## Builder isolation verification — 2026-10-12

The default Rocento iOS simulator build and Android Rocento/Market debug builds
passed after the separation. The optional RocentoStudio iOS simulator build and
Android `-PappBuilder=true` build also passed. Android instrumentation sources
compile in both modes; standalone Rocento lint passed. Swift ran 27 core and 7
builder tests, and Android ran 30 core and 7 builder tests, all passing.
Regression tests cover standalone refresh/restart, rejection of foreign merchants,
builder outages/revocation, and ignoring a valid prior builder cache.

The built standalone APK and iOS executable were checked for builder classes,
module symbols and mobile configuration/enrollment/session routes; none were
present. `mobile/tools/check_boundaries.py` and CI preserve this boundary. These
checks did not install apps, change enrolled devices, publish designs, sign a
release, or run new simulator UI flows. The concurrent runtime 1.2 merchant work
owns its separate final UI and publication verification.

The old optional reconnect-file behavior has moved out of the read-only Android
catalog test. With `-PappBuilder=true`, explicitly opt into
`BuilderEnrollmentLiveTests` with `rocentoLiveEnrollment=true` to consume a supplied
`category-reconnect` code file. `CategoryLiveTests` only reads public catalog data.
