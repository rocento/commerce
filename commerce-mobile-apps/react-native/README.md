# Rocento React Native

Independent Expo/TypeScript storefront with application ID `com.rocento.preview.reactnative`. Normal native builds use the Grocery commerce API; optional Studio builds receive authorized draft designs.

The [React Native guide](../../commerce-docs/mobile/react-native.md) owns setup, builds, secure storage, fixtures and verification. Use the shared [JDK 21 prerequisites](../../commerce-docs/mobile/development.md#prerequisites) for Android builds.

- [Architecture and feature state](../../commerce-docs/mobile/architecture.md)
- [Current capabilities and acceptance limits](../../commerce-docs/mobile/README.md)
- [Native preview](../../commerce-docs/mobile/native-preview.md) and [worker runbook](../../commerce-ops/deploy/native-preview/REACT_NATIVE.md)
- [Contributor requirements](../AGENTS.md), [iOS signing](../ios/SIGNING_AND_KEYCHAIN.md) and [Android signing](../android/SIGNING_AND_KEYSTORE.md)

Dependencies remain independent of the frontend workspace. Run React Native commands from this directory and use the checked build/install scripts described in the guide.
