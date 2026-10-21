# Mandatory native mobile standard

These instructions apply to all files under `commerce-mobile-apps/`, including native source,
build configuration, shared resources, generators, and tests.

Read and follow the relevant platform standard before changing native code:

- [iOS coding standard](ios/CODING_STANDARDS.md)
- [Android coding standard](android/CODING_STANDARDS.md)

For shared resources, generators, or changes affecting both platforms, follow
both standards. **MUST** and **MUST NOT** are requirements for all contributors
and coding agents, not optional recommendations.

## Required architecture

- Native apps MUST build and run without an available App Studio service,
  enrollment, or published configuration. Swift merchant apps MUST use the
  published-settings adapter by default, with validated cached/bundled fallback.
  Android and React Native retain their standalone defaults. Live
  commerce may depend on the merchant commerce backend.
- Dependencies MUST point from the app to core, and from the app to the
  delivery adapter to core (default on Swift merchant apps; opt-in on Android
  and React Native). Core MUST NOT depend on the builder adapter.
- Builder transport, enrollment, configuration cache, credentials, private asset
  delivery, and connection UI MUST stay in the designated integration locations
  listed in each platform standard.
- Shared screens and core MUST use native models and the core-owned
  `StorefrontConfiguration` interface. They MUST NOT import builder types or
  require builder state to perform shopping operations.
- Standalone fixture builds and standalone Android/React Native builds MUST
  exclude builder implementation code at build time;
  disabling linked builder code with a runtime flag is insufficient.
- Swift merchant schemes MUST produce one app per merchant; legacy `*Studio`
  schemes may only forward to that same target. Draft preview UI and transport
  MUST compile only in Debug. Changes MUST preserve local fixture builds and
  Android/React Native standalone and Studio build paths. Do not weaken
  isolation checks or move prohibited dependencies outside scanned directories
  to make validation pass. Include new core or shared source roots in the guard.
- iOS builds installed over an existing app MUST preserve its signed app identity
  and Keychain access groups. Follow the mandatory
  [signing and Keychain requirements](ios/SIGNING_AND_KEYCHAIN.md); unsigned
  compilation does not verify saved-credential access.
- Android updates MUST preserve the installed package/signing identity and
  Keystore storage contract. Follow the mandatory
  [signing and Keystore requirements](android/SIGNING_AND_KEYSTORE.md), including
  the pre-install gate; never uninstall or clear data to bypass a mismatch.

## Verification

Run `python3 commerce-mobile-apps/tools/check_boundaries.py` from the repository root after
changes here. Apply the platform-specific tests and build checks when code,
dependencies, resources, or composition change. Documentation-only edits require
checking links and the boundary guard, not rebuilding unchanged apps.
