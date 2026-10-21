# Mandatory Android coding standard

The Android storefront MUST remain a complete native application that can build
and run independently of App Studio. This standard applies to Kotlin code,
Gradle modules, source sets, resources, generators, and tests. **MUST** and
**MUST NOT** are requirements for every change. The commerce backend remains
necessary for live shopping; builder availability and enrollment MUST NOT be
prerequisites.

## Dependency direction and ownership

Allowed dependencies are `:app → :core` and, for explicit builder builds,
`:app → :app-builder → :core`.

| Location | Required responsibility |
| --- | --- |
| `core` | Commerce, catalog, native presentation models, local validation, bundled design and provider interfaces |
| `app/src/main` | Shared Compose screens, platform credential storage and shopping behavior consuming core APIs |
| `app/src/standalone` | Composition using `BundledConfiguration`; no builder connection UI |
| `app-builder` | Enrollment, builder identity/origin, published configuration transport/cache and private builder assets |
| `app/src/appBuilder` | Optional adapter wiring, builder credential provisioning and connection UI |
| `app/src/appBuilderAndroidTest` | Instrumented tests that explicitly need builder enrollment |

1. `:core` MUST NOT depend on `:app-builder` or a builder SDK. Core, shared screens,
   and standalone composition MUST NOT import builder types, call `/v1/mobile/*`
   builder routes, or inspect enrollment state.
2. Configuration sources MUST implement the core-owned
   `StorefrontConfiguration` interface and return native `ConfigSnapshot` data.
   Builder types and transport details MUST NOT appear in core API signatures.
   A shared screen may host the build-selected `StorefrontSettings` composable;
   its builder UI implementation MUST remain in `app/src/appBuilder`.
3. Catalog, account, cart, delivery, checkout, and orders MUST use the commerce
   APIs directly. Their behavior MUST NOT depend on a builder connection.

## Build and runtime rules

- Normal Gradle builds MUST remain standalone. Only explicit `-PappBuilder=true`
  builds may include `:app-builder`, its dependency, or its source sets.
  `settings.gradle.kts` and `app/build.gradle.kts` MUST use the same opt-in
  selection. Linking the builder and disabling it with a runtime flag is
  insufficient; do not rely on shrinking to remove it.
- Standalone startup and refresh MUST use validated bundled design/assets and
  ignore persisted builder configuration and enrollment. Switching build modes
  MUST NOT delete customer sessions or enrollment data.
- Builder errors MUST be handled inside the optional adapter, preserving a
  validated cached or bundled design so commerce can proceed. Preserve coroutine
  cancellation.
  Failed session/config requests MUST NOT trigger further requests for optional
  artwork during the same refresh. Stop artwork requests after the first failure.
  Cancellation MUST propagate without replacing credentials or becoming a
  successful fallback.
- Merchant, environment, and commerce origin MUST be trusted build-time values.
  The builder origin belongs to `AppBuilderIdentity`; downloaded configuration
  MUST NOT change either origin or merchant. Builder and customer credentials
  MUST stay separate and MUST NOT be sent to each other's APIs.
- Shared presentation schemas are allowed as local, validated data. Native
  models and assets MUST be checked in: normal builds MUST NOT require a running
  builder, builder publication, Node build, or contract generation. Keep bundled
  assets in `core/src/main/assets`; the app consumes the library's merged assets.
  Generate model/resource updates with [the contract generator](../tools/generate_contract.py)
  rather than hand-editing generated copies.
- Public catalog feeds may use the merchant commerce API's existing
  `/v1/theme/storefront` route. This MUST NOT introduce enrollment or an App Studio
  service dependency into core.

## Signing and saved credentials

All builds and installations MUST follow the
[signing and Keystore requirements](SIGNING_AND_KEYSTORE.md).
Updates MUST preserve the application ID, signing certificate and credential
storage contract in both standalone and builder modes. Gradle install/connected
test tasks and scripted APK delivery MUST pass the automated signing gate before
installation. Release signing MUST compare the final APK against a known-good
prior APK, or require an explicit first installation and intended certificate pin.
Signature/identity failures MUST NOT trigger uninstall, clear-data or downgrade
fallbacks. A successful assembly alone does not verify credential continuity.

## Required verification

Run commands from the repository root with JDK 21 and the Android SDK. Core tests
MUST run without the builder module; adapter tests belong in `app-builder/src/test`.
Shared instrumented tests MUST compile in standalone mode. Read-only catalog
tests MUST NOT enroll an installation.

```sh
python3 commerce-mobile-apps/tools/check_boundaries.py
python3 -m unittest discover -s commerce-mobile-apps/tools/tests -v
commerce-mobile-apps/android/gradlew -p commerce-mobile-apps/android :core:testDebugUnitTest
# When the adapter, shared provider contract, or composition changes:
commerce-mobile-apps/android/gradlew -p commerce-mobile-apps/android -PappBuilder=true :app-builder:testDebugUnitTest
# When schema or bundled resources change:
python3 commerce-mobile-apps/tools/generate_contract.py --check
```

For changes to native code, dependencies, or build composition, verify the
affected merchant's standalone and opt-in builds, instrumented-test compilation,
and lint using the [build guide](../../commerce-docs/mobile/development.md#standalone-apps-and-optional-app-studio).
For changes that affect the dependency boundary, inspect the standalone APK
before an opt-in build overwrites the same output path:

```sh
python3 commerce-mobile-apps/tools/check_boundaries.py \
  --android-apk commerce-mobile-apps/android/app/build/outputs/apk/rocento/debug/app-rocento-debug.apk
```

Preserve regression coverage for local startup/refresh/restart, ignoring a prior
builder cache, merchant isolation, and unavailable/revoked builder access.
The guard scans Java/Kotlin in all shared source sets, including flavor and test
directories, and checks that builder wiring remains conditional. Extend checks
for new shared source roots. A boundary failure MUST be fixed by
restoring the architecture, not by disabling or bypassing the guard.
