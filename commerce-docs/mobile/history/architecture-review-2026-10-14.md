# Mobile architecture and code review — 2026-10-14

Historical source review, 2026-10-14. Use the [current architecture](../architecture.md) for ownership and the [plans](../plans/README.md) for remaining acceptance.

This review covers the SwiftUI, Kotlin/Compose and React Native apps under
`mobile/`. It examines composition, feature state, identity transitions,
credential persistence, HTTP transport, checkout recovery, optional Studio
boundaries and build/test configuration. It is a focused engineering review,
not a line-by-line security certification or production acceptance. Existing
workspace changes were preserved. Follow-up verification uses disposable
simulators/emulators and isolated fixtures; no production mutations were performed.

## Assessment

Keep the existing architecture: platform UI → feature state and workflows →
commerce client → injected transport/storage. Optional Studio adapters supply
presentation configuration through core-owned interfaces. They must remain
excluded from standalone builds. The server continues to own commercial facts,
authorization and idempotent mutations.

The foundations are sound: feature stores already exist on all three platforms,
checkout recovery is persistent, identity changes invalidate private state, and
source/artifact boundary checks protect standalone builds. The largest maintenance
costs are oversized screen coordinators, duplicate observation mechanisms and
three independently maintained API/model implementations.

## Corrections made

| Priority | Finding and consequence | Change and evidence |
| --- | --- | --- |
| P1 | Swift `SecureSession.save` deleted the old Keychain item before adding its replacement. An unsuccessful add could lose a refresh credential or pending checkout record. Delete status and logout persistence failures were also ignored. | Reuse update-before-add for all purposes, add only when the item is absent, check deletion status, and propagate logout storage failures into action feedback. Four Keychain fault-injection tests cover update failure, replacement, insertion and deletion; a commerce test checks logout failure propagation. Service, account derivation, purposes and accessibility are unchanged. |
| P2 | Swift and Kotlin password reset logged out inside `CommerceClient.authAction` and then again in `AccountStore.auth`. This repeated a network mutation and credential cleanup. | The client retains logout ownership; the account store only resets presentation state afterward. Both regression tests reproduced two logout requests before the correction and now require exactly one. |
| P2 | React Native used `response.text()` before checking length. This buffered an unbounded response and counted UTF-16 units instead of transferred UTF-8 bytes. | Read response chunks with a 2,000,000-byte cap, decode incrementally, cancel oversized/failed reads and release the reader. Tests cover oversized multibyte bodies and characters split across chunks. |
| P3 | React Native had unused imports, address setters, a catalog binding and a test parameter. | Removed the eight compiler-reported unused bindings and enabled `noUnusedLocals` and `noUnusedParameters` in its existing typecheck/CI path. |

Primary implementation files:
[Swift storage](../../../commerce-mobile-apps/ios/RocentoCore/Sources/RocentoCore/SecureSession.swift),
[Swift account](../../../commerce-mobile-apps/ios/RocentoCore/Sources/RocentoCore/AccountStore.swift),
[Kotlin account](../../../commerce-mobile-apps/android/core/src/main/java/com/rocento/mobile/AccountStore.kt),
[React Native client](../../../commerce-mobile-apps/react-native/src/core/commerce.ts), and
[TypeScript configuration](../../../commerce-mobile-apps/react-native/tsconfig.json).

## Architecture recommendations implemented

- **Swift:** Extracted the shopping model and account/address, image, product,
  wishlist and preferences screens from `CommerceView`. Account, cart, checkout
  and order stores now consume narrow `Sendable` protocols; `CommerceClient`
  retains transport, authentication and durable checkout ownership. Location
  callbacks carry typed values through a nonisolated delegate and reject stale
  request IDs. Notifications use a separate nonisolated delegate. Workflow
  callbacks declare main-actor ownership. Complete concurrency checking is
  enabled in the Xcode generator and both Swift packages.
- **Kotlin:** Split the activity, model, storefront/catalog composition and
  account/address/preferences/wishlist screens. Compose reads immutable feature
  snapshots with `collectAsStateWithLifecycle`; manual revision counters and the
  unused session change-forwarding graph are removed. Async workflows wait for
  operation-state changes instead of polling captured UI values. Account, cart,
  checkout and order stores consume feature interfaces. Modifier ordering,
  preference helpers and map event dispatch/accessibility were corrected.
- **React Native:** Checkout, authentication, addresses and orders have separate
  subscriber components with shared presentation helpers. Critical HTTP payloads
  are validated before entering stores or persisted sessions. Saved checkout
  attempts are validated against their customer and retained on corruption.
  Streaming responses stay bounded; buffered injected responses also enforce
  the UTF-8 byte limit. Three circular runtime imports now use a dependency-free
  error module.
- **Shared safety:** Swift and Kotlin restoration, assistant session checks and
  pending checkout reads propagate storage-access errors. Android decryption
  never creates a replacement key when a saved credential's key is missing.
  Storage names, identities and signing contracts remain unchanged. Shared
  malformed response fixtures exercise all three implementations, alongside
  storage-failure and checkout-retry regression tests.

### Dependency remediation

The `xcode` dependency now uses CommonJS-compatible `uuid@11.1.1`, removing the
seven moderate audit entries. Two advisories currently lack published fixed
releases: [braces nesting](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
and [node-forge signature parsing](https://github.com/advisories/GHSA-86w9-cpqp-85rv).
The project applies temporary, exact-source-hash-checked patches during
`npm ci`/`npm install`. Braces parsing and AST traversal reject excessive nesting;
forge validates the nested DigestAlgorithm element count, following the
[upstream proposed fix](https://github.com/digitalbazaar/forge/pull/1152).
Regression tests exercise ordinary and malicious inputs, real RSA verification
and Xcode UUID generation. CI runs these tests explicitly.

The patches fail installation when upstream source changes, requiring review
rather than silently applying to a new version. Remove them after adopting
verified upstream fixes and rerunning the regression suites. Package versions
are not falsified: npm's version-based audit still reports **15 high entries**
associated with the two patched dependency chains. This is a documented local
mitigation, not a claim of an advisory-free upstream dependency tree.

Android's upgrade notices are resolved. The native stack now uses compile SDK
37.1 / target API 37, AGP 9.4.1, checksum-pinned Gradle 9.8.1, Kotlin 2.3.20,
Compose BOM 2026.09.00, Activity 1.13.0, Lifecycle 2.11.0, Firebase BOM 35.0.0,
OkHttp 5.5.0 and kotlinx coroutines/serialization 1.11.0. AGP built-in Kotlin,
its variant resource API, generated merchant resource values and Compose v2 test
rules replace the older build/test APIs. Espresso 3.7.0 is explicitly selected
because Compose 1.12.1 otherwise resolves 3.5.0, whose input injection fails on
API 37; see the [upstream resolution](https://github.com/android/android-test/issues/2507). Standalone, core and Studio lint report
“No issues found”; no lint suppressions or baselines hide the upgrade notices.
The signing tools now consistently use Build Tools 36.0.0.

Firebase's existing registration-token API remains intentionally used because
the commerce backend targets registration tokens. Its new installation-ID API
requires a coordinated server migration. This compatibility choice has a narrow
source annotation, not a global warning suppression. See the
[Firebase registration API](https://firebase.google.com/docs/reference/android/com/google/firebase/messaging/FirebaseMessaging).
AGP 9.4.1's use of Gradle's deprecated configuration visibility API still produces an
upstream build-tool notice; it does not affect the clean Android lint reports.

The dependency audit is still transparent: `npm run audit:dependencies` checks
registry advisories and exact patched file hashes, rejects new/unmitigated
advisories, and reports the 15 upstream high entries. Both vulnerable packages
remain at their latest published versions, with no upstream patched release.
Removing them requires replacing Expo/Metro tooling; npm's suggested old-major
downgrades are not compatible fixes. CI runs the audit gate and exploit tests.

## Architecture approach

Use feature-oriented modular architecture with unidirectional state flow. Avoid
adding another global state framework or moving commercial authority into the
apps. Preserve FIFO mutation coordination, explicit confirmation and persisted
idempotency keys. Public read concurrency can remain separate from serialized
customer mutations.

Platform-specific direction:

| Platform | Foundation | Applied improvements |
| --- | --- | --- |
| Swift | Core package, main-actor stores, commerce actor, injected transports, separate builder package | Narrow feature protocols, smaller SwiftUI composition, explicit delegate isolation, checked storage failures |
| Kotlin | Core and optional adapter modules, ViewModel-owned scope, feature `StateFlow`, cancellation propagation | Lifecycle-aware state collection, remove revision bridges, smaller Compose screens and client interfaces |
| React Native | Core stores, `useSyncExternalStore`, native/web platform adapters, separate Studio entry | Smaller subscriber components, response validation, compatible dependency remediation |

This direction follows the relevant primary guidance on
[Swift concurrency and isolation](https://docs.swift.org/swift-book/LanguageGuide/Concurrency.html),
[Android architecture and state flow](https://developer.android.com/topic/architecture/recommendations),
and [React Native platform-specific modules](https://reactnative.dev/docs/platform-specific-code).
It adapts those principles to the existing code rather than prescribing a rewrite.

Maintaining three complete implementations has an ongoing parity/testing cost.
Choose their long-term product roles deliberately. Until that decision is made,
share wire contracts, fixtures and behavioral expectations; keep native lifecycle,
UI and secure storage in their platform implementations. None of the apps,
fixtures, compatibility paths, migrations or operational scripts were deleted
merely because they overlap in purpose.

## Verification and limits

Checks run on the local working tree on 2026-10-14:

| Check | Result |
| --- | --- |
| Swift core unit suite | 132 passed with complete concurrency checking |
| Swift builder unit suite | 17 passed |
| Kotlin core unit suite | 134 passed |
| Kotlin builder unit suite | 14 passed |
| React Native typecheck and unit suite | Passed; final rerun: 184 tests in 24 files |
| Dependency security regression suite | 5 passed: 3 exploit/compatibility checks and 2 fail-closed audit policy checks |
| React Native iOS/Android Hermes export | Both passed |
| React Native isolated browser suites | 30 passed: 2 demo, 3 live browsing, 16 checkout/community/support/memory, 9 discovery |
| Android standalone and Studio | Lint, app assembly and instrumented-test compilation passed |
| iOS Rocento and RocentoStudio | Complete concurrency compilation passed; signed standalone build and identity gate passed |
| Swift real Keychain upgrade acceptance | 6 signed stages passed, no skips; Studio → standalone → Studio, checkout/reorder/session and enrollment verified |
| iOS native UI suite | 29 passed, 5 opt-in checks skipped; 3 final signed-build checks passed |
| Android native UI suites | API 36 and API 37: standalone 29 passed / 7 opt-in skips; Studio 29 passed / 10 opt-in skips on each OS |
| Android real Keystore acceptance | Login, standalone → Studio signed update, restore and rotated-session restart passed |
| React Native signed iOS and Android acceptance | Both pass: session and pending order survive signed reinstall and process restart; same-key recovery and logout pass |
| Mobile source and standalone artifact boundaries | Passed for iOS and Android |
| Shared generated contract and React Native catalog checks | Passed |
| Mobile tooling suite | 67 passed |

Verification used local fixture commerce and disposable devices. React Native native
acceptance used existing signed iOS/Android shells with the current JavaScript;
both platform Hermes exports also passed. The full Swift UI suite preceded the
final notification-delegate isolation cleanup; a focused final signed-build rerun
covers account, notification preferences and checkout recovery.

Physical-device testing, live APNs/FCM delivery, real payment processing, store
submission and remote CI were not performed. Native Swift signed simulator Keychain upgrade acceptance now passes all six
stages, covering legacy storage format, refresh rotation, pending checkout and
reorder retention, and Studio enrollment/publication across both mode switches.
Owner-signed physical-device Keychain acceptance remains a release check. Optional live
merchant/enrollment tests require their dedicated environment. No production
customer data or credentials were used.

Local verification evidence is retained under `/tmp/mobile-architecture-*`:
`ios-ui.xcresult`, `ios-final-ui.xcresult`, `android-final-ui.log`, the three
`android-restart-*.log` phase results, `rn-ios-stage*.png`,
`rn-android-stage*.xml`, and the per-install signing reports. The Android full
suite used a preserved architecture build; the final import/state-allocation
cleanup was then compiled, linted and installed for Keystore acceptance. Android
UI tests ran on an isolated ADB connection after an unrelated workspace install
interrupted the first run; the uninterrupted rerun is the result reported above.

Follow-up upgrade verification (same date): Android app/core/adapter lint all
report no issues; core 134 and adapter 14 tests pass. The standalone UI rerun
passes 29 checks with 7 explicit opt-in skips using Compose's v2 rules; Studio
passes 29 checks with 10 opt-in skips. Both suites were repeated successfully on
Android 17 / API 37 after explicitly selecting Espresso 3.7.0. A real
Keystore credential seeded by the previous APK restores after the SDK/library
upgrade and again after the Studio switch. Release R8 assembly and standalone
DEX isolation pass. Swift's six signed Keychain stages and three ordinary
account/checkout/notification UI checks pass. React Native's 184 unit tests,
typecheck, five dependency security tests and patched-source audit gate pass. Evidence for
this follow-up is under `/tmp/mobile-upgrades-*`, including the structured
`keychain-results/results.json` and per-stage signing reports/xcresults.

The local Android Studio installation was upgraded to Rabbit 1 / 2026.2.1
(build AI-262.9437.185.2621.16467767). The official ARM installer matched Google's
SHA-256 and passed Apple signature/notarization verification. IDE Gradle import
and a second explicit sync after restart succeeded with AGP 9.4.1 / Gradle 9.8.1;
the IDE's Boutique debug assembly also succeeded. Java 21 was preserved separately
from the IDE's bundled Java 25, and both Gradle and the project SDK use Java 21.
Standalone and App Studio-enabled Rocento debug assembly, instrumented-test
compilation and lint passed after installation. Fresh core (134) and adapter (14)
unit tests passed without failures or skips. All 158 recorded Android project
source/build files remained unchanged; only local IDE/JDK settings and setup
documentation changed. Runtime UI tests were not repeated for this IDE-only
upgrade; the Android 16/17 results above apply to the unchanged app code.
Evidence is under `/tmp/android-studio-upgrade-evidence`; prior IDE settings and
the old application bundle were retained for rollback. The existing upstream
AGP Gradle-deprecation notice remains separate from the clean lint results.

CI now selects API 37.0 and runs the signed Swift Keychain
upgrade sequence. Remote CI and owner-signed physical-device acceptance remain
unrun; local fixture testing does not certify live push or payment services.
