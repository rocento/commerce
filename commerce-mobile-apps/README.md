# Rocento native storefronts

SwiftUI, Kotlin/Compose and React Native storefronts live here. Swift merchant apps read published App Studio settings with cached/bundled fallback; draft preview is Debug-only. Android and React Native keep optional Studio adapters.

Start with the [mobile documentation index](../commerce-docs/mobile/README.md) for current capabilities and verification limits.

- [Development, JDK 21 setup and builds](../commerce-docs/mobile/development.md)
- [Architecture and state ownership](../commerce-docs/mobile/architecture.md)
- [React Native development](../commerce-docs/mobile/react-native.md)
- [Native preview and worker modes](../commerce-docs/mobile/native-preview.md)
- [Plans and acceptance gates](../commerce-docs/mobile/plans/README.md)
- [Dated implementation and release history](../commerce-docs/mobile/history/README.md)
- [Performance safeguards](PERFORMANCE.md)

All native changes must follow [AGENTS.md](AGENTS.md), the applicable [iOS](ios/CODING_STANDARDS.md) and [Android](android/CODING_STANDARDS.md) standards, and the [iOS Keychain](ios/SIGNING_AND_KEYCHAIN.md) / [Android Keystore](android/SIGNING_AND_KEYSTORE.md) signing contracts. These source-adjacent requirements remain authoritative.

From the repository root, verify documentation changes with:

```sh
python3 commerce-ops/scripts/check-documentation.py
python3 commerce-mobile-apps/tools/check_boundaries.py
```
