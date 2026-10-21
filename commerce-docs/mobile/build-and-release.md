# Native build and release boundaries

## Implemented build inputs and tools

Merchant identity, environment, source revision, runtime compatibility and native assets are build inputs. Runtime configuration remains a separate versioned contract. Build manifests and queue APIs are implemented; a queued build does not imply a signed artifact or store submission.

The repository provides Xcode project generation, canonical Swift merchant schemes with legacy Studio aliases and local fixture schemes, Android variants, React Native build scripts and CI definitions. Use [development guide](development.md) and the [React Native guide](react-native.md) for current commands. A CI definition is not evidence that remote CI has passed.

## Runtime versus binary changes

Supported palettes, sections, copy and navigation can be delivered as validated compatible configuration. Native code, dependencies, permissions, entitlements, app identity and bundled icons require a new binary. Published configuration rollback does not roll back an installed binary.

## Signing and installation

Follow the [iOS signing/Keychain guide](../../commerce-mobile-apps/ios/SIGNING_AND_KEYCHAIN.md) and [Android signing/Keystore guide](../../commerce-mobile-apps/android/SIGNING_AND_KEYSTORE.md). Build helpers verify signed artifacts and installed identity before replacement. Standalone and Studio updates must preserve package/bundle identity and secure-storage access. Never uninstall or clear app data to bypass a mismatch.

Store signing secrets are separate from manifests and runtime definitions. Unsigned compilation and JavaScript bundle export do not establish credential continuity or signed physical-device acceptance. Existing preparation evidence is maintained in the [device-signing guide](device-signing.md).

## Release status boundary

Merchant-owned signing, physical-device acceptance, hosted release automation and store distribution have independent completion gates in the [roadmap](plans/native-preview-and-release.md). The current architecture does not depend on cloud provisioning or store-account automation. Push integration is prepared but disabled by default; activation follows the [push guide](order-push.md).
