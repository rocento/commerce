# Mobile development and verification

Run commands from the repository root unless a guide says otherwise. Native source and composition changes must follow the [mobile contributor instructions](../../commerce-mobile-apps/AGENTS.md), [iOS standard](../../commerce-mobile-apps/ios/CODING_STANDARDS.md) and [Android standard](../../commerce-mobile-apps/android/CODING_STANDARDS.md). Documentation-only changes require link checks and the boundary guard.

## Prerequisites

Use Xcode and an installed iOS 17+ simulator for Swift builds. For Android, use **JDK 21** for Gradle and an installed Android SDK. Android Studio's bundled Java is not the project Gradle toolchain; select JDK 21 in Settings → Build Tools → Gradle. The checked-in native project currently uses AGP 9.4.1, Gradle 9.8.1, compile SDK 37.1, target API 37 and Build Tools 36.0.0; the Gradle files are authoritative.

On macOS, after installing JDK 21:

```sh
export JAVA_HOME="$(/usr/libexec/java_home -v 21)"
export ANDROID_HOME="$HOME/Library/Android/sdk"
java -version
```

React Native has independent Node/npm, Expo and generated native projects; follow [its development guide](react-native.md#run-and-build) with the same JDK 21 selection. Deployment workers have their own pinned images in the [native-preview runbooks](../../commerce-ops/deploy/native-preview/README.md).

## Standalone apps and optional App Studio

Swift merchant apps load published App Studio settings, with cached/bundled fallback.
Android and React Native remain standalone by default. Open `commerce-mobile-apps/ios/RocentoMobile.xcodeproj` and
run **Rocento**, **Electronics**, **Jewelry**, or **Pharmacy**; on Android, build the
matching `rocento`, `electronics`, `jewelry`, or `pharmacy` flavor. Swift merchant apps use the published-settings adapter; Android standalone apps
use checked-in design and artwork. All call the merchant commerce API directly.
They need no App Studio server, enrollment, published design, Node build, or
contract generator to compile and run. Live shopping still requires the commerce
backend. **Market** and **Boutique** remain local catalog previews.

The dependency direction is `native app → core`, with the delivery path
`native app → AppBuilder → core` (default for Swift merchants, opt-in elsewhere). Core never imports AppBuilder.

| Layer | iOS | Android |
| --- | --- | --- |
| Commerce, sessions, catalog, presentation models and bundled design | `commerce-mobile-apps/ios/RocentoCore` | `commerce-mobile-apps/android/core` |
| Enrollment, published-config cache/transport and private brand assets | `commerce-mobile-apps/ios/RocentoAppBuilder` | `commerce-mobile-apps/android/app-builder` |
| Connection UI and composition | `commerce-mobile-apps/ios/Integrations/AppBuilder` | `commerce-mobile-apps/android/app/src/appBuilder` |
| Local fixture / standalone composition | `commerce-mobile-apps/ios/Integrations/Standalone` | `commerce-mobile-apps/android/app/src/standalone` |
| Native screens | `commerce-mobile-apps/ios/Storefront` | `commerce-mobile-apps/android/app/src/main` |

Run **Rocento** in Xcode. The other Swift merchant schemes follow the same
composition. Legacy `*Studio` schemes forward to the canonical target and app
product; there is no separate Studio binary. Existing enrollment is reused.
New installations connect through **Account → App connection** using an owner-issued
code; until then, validated cached or bundled settings remain available. Published
settings refresh on load/pull-to-refresh. Only Debug builds include live draft
preview controls and transport; Release builds consume published settings only.
Settings come from the trusted central Grocery API; shopping uses each merchant's
own origin. Android enables its adapter with `-PappBuilder=true`.
iOS updates must preserve the established signing/Keychain identity. Follow the mandatory [signing and Keychain guide](../../commerce-mobile-apps/ios/SIGNING_AND_KEYCHAIN.md)
before installing a build. The unsigned iOS commands below verify compilation
only; their outputs MUST NOT replace an enrolled or signed-in installation.

```sh
# Canonical Swift app (compile-only; do not install this unsigned commerce-output)
xcodebuild -project commerce-mobile-apps/ios/RocentoMobile.xcodeproj -scheme Rocento \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
commerce-mobile-apps/android/gradlew -p commerce-mobile-apps/android :app:assembleRocentoDebug

# Published-only Release (iOS: compile-only)
xcodebuild -project commerce-mobile-apps/ios/RocentoMobile.xcodeproj -scheme Rocento -configuration Release \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
commerce-mobile-apps/android/gradlew -p commerce-mobile-apps/android -PappBuilder=true :app:assembleRocentoDebug

# Independent core and integration checks
swift test --package-path commerce-mobile-apps/ios/RocentoCore
swift test --package-path commerce-mobile-apps/ios/RocentoAppBuilder
commerce-mobile-apps/android/gradlew -p commerce-mobile-apps/android :core:testDebugUnitTest
commerce-mobile-apps/android/gradlew -p commerce-mobile-apps/android -PappBuilder=true :app-builder:testDebugUnitTest
python3 commerce-mobile-apps/tools/check_boundaries.py
```

For installable iOS simulator builds and credential acceptance, use the guide's
[signed simulator commands](../../commerce-mobile-apps/ios/SIGNING_AND_KEYCHAIN.md#signed-simulator-build)
and [verification procedure](../../commerce-mobile-apps/ios/SIGNING_AND_KEYCHAIN.md#verify-before-installing-and-after-upgrading).
Use the same signing settings for `build-for-testing`; it can replace the app
artifact later used by the test runner.
The [checked simulator builder](../../commerce-mobile-apps/tools/build_ios_simulator.py) signs and verifies
the final app against the installed identity and only installs with `--install`.
The [device signing script](../../commerce-mobile-apps/tools/sign_ios_device.sh) verifies the archive and
exported IPA; an upgrade requires a prior signed app as the compatibility baseline.

Android Gradle install/connected-test tasks also verify signing against the
installed APK before installation. For manual APK updates, use
`python3 commerce-mobile-apps/tools/check_android_signing.py APK --flavor rocento --serial SERIAL --install`.
The [Android signing and Keystore guide](../../commerce-mobile-apps/android/SIGNING_AND_KEYSTORE.md) defines
the mandatory identity/storage contract, release baseline inputs and failure
handling. Assembly alone does not verify access to saved credentials.

Customize the bundled native design under `commerce-mobile-apps/shared/production`, then run
`python3 commerce-mobile-apps/tools/generate_contract.py` in the full repository to synchronize
checked-in native resources. The typed presentation schema is shared with Studio
for compatibility; it is local data, not a builder runtime dependency. Public
catalog collections currently also use the commerce API's `/v1/theme/storefront`
route for demo-feed selection. This does not require App Studio enrollment.
`BundledConfiguration` can instead be supplied directly with local configuration
and assets. `StorefrontConfiguration` is the small provider interface for another
configuration source.

`check_boundaries.py` rejects builder imports/routes in core and shared screens.
Its `--android-apk PATH` and `--ios-app PATH` options inspect standalone
binaries (iOS: Market/Boutique fixtures). `--ios-published-app PATH` verifies
that merchant Release binaries exclude draft preview. CI checks these boundaries. Historical builder rollout
and acceptance records live in [mobile history](history/README.md).

## Preserve installed app data during tests

Use a disposable simulator/emulator for tests that reinstall applications. For an already enrolled Rocento Android emulator, assemble the app and instrumentation APKs, install with `adb install -r` after the required signing gate, then invoke the intended opt-in test class with `adb shell am instrument`. Do not use `connectedRocentoDebugAndroidTest` on that installation: the runner can uninstall afterward, removing enrollment and customer-session data.

`CategoryLiveTests` accepts `rocentoLiveReadOnly=true` and reads public catalog/category/filter behavior. With `-PappBuilder=true`, `BuilderEnrollmentLiveTests` separately requires `rocentoLiveEnrollment=true` to consume a supplied reconnect-code file. Read-only catalog tests do not enroll devices.

Contract/schema changes require `python3 commerce-mobile-apps/tools/generate_contract.py --check`; regenerate with the same command without `--check` after editing the authoritative inputs. Use [isolated commerce fixtures](commerce.md#development-and-acceptance) for checkout acceptance; a build or quote does not authorize a production order.
