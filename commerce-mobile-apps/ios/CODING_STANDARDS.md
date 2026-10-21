# Mandatory iOS coding standard

The iOS storefront MUST remain a complete native application that can build and
run independently of App Studio. This standard applies to Swift code, Swift
packages, Xcode targets, resources, generators, and tests. **MUST** and **MUST NOT**
are requirements for every change. The commerce backend remains necessary for
live shopping; builder availability and enrollment MUST NOT be prerequisites.

## Dependency direction and ownership

Allowed dependencies are `Storefront → RocentoCore` and, for merchant apps, `Storefront → RocentoAppBuilder → RocentoCore`.

| Location | Required responsibility |
| --- | --- |
| `RocentoCore` | Commerce, customer sessions, catalog, native presentation models, local validation, bundled design and provider interfaces |
| `Storefront` | Shared SwiftUI screens and shopping behavior consuming core APIs |
| `Integrations/Standalone` | Local Market/Boutique fixtures using `BundledConfiguration` |
| `RocentoAppBuilder` | Enrollment, builder identity/origin, published configuration transport/cache and private builder assets |
| `Integrations/AppBuilder` | Published-settings wiring, credential provisioning and connection UI |

1. `RocentoCore/Package.swift` MUST NOT depend on `RocentoAppBuilder` or a builder
   SDK. Core, shared screens, and standalone composition MUST NOT import builder
   types, call `/v1/mobile/*` builder routes, or inspect enrollment state.
2. Configuration sources MUST implement the core-owned
   `StorefrontConfiguration` protocol and return native `ConfigSnapshot` data.
   Builder types and transport details MUST NOT appear in core API signatures.
   A shared screen may host the build-selected `StorefrontSettings` component;
   its builder UI implementation MUST remain in `Integrations/AppBuilder`.
3. Catalog, account, cart, delivery, checkout, and orders MUST use the commerce
   APIs directly. Their behavior MUST NOT depend on a builder connection.

## Build and runtime rules

- Normal merchant schemes MUST link `RocentoAppBuilder` and use published
  configuration with validated cached/bundled fallback. There MUST be one app
  target per merchant. Legacy `*Studio` schemes are forwarding aliases only.
  Draft preview UI, runtime and transport MUST be compiled only under `DEBUG`;
  Release apps MUST NOT contain draft session routes or preview controls.
- Keep target selection in [the project generator](../tools/generate_xcode_project.py).
  Regenerate and check in project/scheme changes; do not maintain conflicting
  hand-edited target wiring.
- Merchant startup and refresh MUST reuse existing enrollment and fetch published
  settings when authorized. Missing enrollment or unavailable service MUST fall
  back to validated cached/bundled settings without blocking commerce. Market
  and Boutique fixture apps use bundled settings only. Updates MUST NOT delete
  customer sessions or enrollment data.
- Builder errors MUST be handled inside the delivery adapter, preserving a
  validated cached or bundled design so commerce can proceed. Preserve cancellation.
  Failed session/config requests MUST NOT trigger further requests for optional
  artwork during the same refresh. Stop artwork requests after the first failure.
  Cancellation (including URLSession cancellation) MUST propagate without
  replacing credentials or becoming a successful fallback.
- Merchant, environment, and commerce origin MUST be trusted build-time values.
  The builder origin belongs to `AppBuilderIdentity`; downloaded configuration
  MUST NOT change either origin or merchant. Builder and customer credentials
  MUST stay separate and MUST NOT be sent to each other's APIs.
- Shared presentation schemas are allowed as local, validated data. Native
  models and resources MUST be checked in: normal builds MUST NOT require a
  running builder, builder publication, Node build, or contract generation.
  Generate model/resource updates with [the contract generator](../tools/generate_contract.py)
  rather than hand-editing generated copies.
- Public catalog feeds may use the merchant commerce API's existing
  `/v1/theme/storefront` route. This MUST NOT introduce enrollment or an App Studio
  service dependency into core.

## Signing and saved credentials

All contributors MUST follow the [signing and Keychain guide](SIGNING_AND_KEYCHAIN.md)
when building, installing, or changing credential storage.

- Every installed app used for customer-session or Studio-enrollment acceptance
  MUST have a valid signature and the established Keychain entitlements. An
  unsigned build or a successful compile MUST NOT count as credential acceptance.
- Updates from legacy standalone/Studio apps MUST retain the merchant's bundle ID,
  application-identifier prefix, and existing Keychain access groups. Preserve
  the default group when adding groups; keep different merchants isolated.
- The Keychain service, account-key derivation, credential purpose names, and
  accessibility class MUST remain compatible with installed data. Any intended
  change needs an explicit migration and upgrade/restoration verification.
- Simulator builds MUST use the per-merchant simulator entitlements and ad hoc
  signing described in the guide. Physical-device builds MUST use the owner's
  matching Apple certificate/profile and authorized entitlements; simulator
  identities MUST NOT be used for physical-device distribution.
- Inspect the signature and entitlements of the final `.app` being installed,
  including after `build-for-testing`. Verify saved customer credentials survive
  an update and process restart; merchant builds must also restore existing
  enrollment and fetch published configuration without a new connection code.
- Build scripts MUST run [the signing checker](../tools/check_ios_signing.py)
  before installing an app or starting UI tests that can install it. Use
  [the checked simulator builder](../tools/build_ios_simulator.py); it stops on
  signature/entitlement incompatibility or failed installed-app lookup. Device
  scripts MUST check both the archive and exported IPA against a known-good
  identity, with an explicit new-installation option only for first installs.
- Missing credential access MUST first be investigated as a possible signing,
  entitlement, or storage-key mismatch. Do not uninstall, erase app/Keychain
  data, or replace enrollment to conceal a compatibility failure. Diagnostics
  MUST NOT log credentials, connection codes, or response bodies.

## Required verification

Run commands from the repository root. Core tests MUST run without importing the
builder package; builder integration tests belong in `RocentoAppBuilder/Tests`.

```sh
python3 commerce-mobile-apps/tools/check_boundaries.py
python3 -m unittest discover -s commerce-mobile-apps/tools/tests -v
swift test --package-path commerce-mobile-apps/ios/RocentoCore
# When the adapter, shared provider contract, or composition changes:
swift test --package-path commerce-mobile-apps/ios/RocentoAppBuilder
# When schema or bundled resources change:
python3 commerce-mobile-apps/tools/generate_contract.py --check
```

For changes to native code, dependencies, or build composition, verify the
canonical merchant Debug and Release configurations and affected fixture schemes compile using the commands in the
[build guide](../../commerce-docs/mobile/development.md#standalone-apps-and-optional-app-studio). For changes
that affect the dependency boundary, inspect standalone fixture binaries and published Release binaries as well:

```sh
python3 commerce-mobile-apps/tools/check_boundaries.py --ios-app /absolute/path/to/Market.app
python3 commerce-mobile-apps/tools/check_boundaries.py --ios-published-app /absolute/path/to/Release/Rocento.app
```

Preserve regression coverage for local startup/refresh/restart, fixture isolation from a prior
builder cache, merchant isolation, and unavailable/revoked builder access.
The guard checks generated Xcode wiring, shared source roots and optional Android
wiring; its source and artifact checks MUST remain enabled. Extend checks for
new shared source roots. A boundary failure MUST be fixed by
restoring the architecture, not by disabling or bypassing the guard.
