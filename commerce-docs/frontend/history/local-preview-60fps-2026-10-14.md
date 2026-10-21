# Local native preview 60 FPS benchmark — 2026-10-14

Host: Apple M4 Pro, 24 GiB RAM. Real signed RocentoStudio SwiftUI app on iOS 26.2 / iPhone 17 Pro, and real signed Kotlin and React Native apps on an Android 36 ARM64 emulator with SwiftShader. Each implementation ran separately. Chromium was headless; the production `NativePreviewVideo` component decoded and painted actual captured native frames.

The local gateway fixture failed with a database connection timeout. This benchmark therefore connects native capture to the production browser component through a loopback test server, bypassing the gateway, authentication, and Builder revision synchronization. Apps use bundled home content; the React Native Studio app reports that a trusted preview session is required. This is a capture/transport benchmark, not complete Apps Builder acceptance or cloud validation.

## Changes

Both workers accept the operator option `--fps 60`, bounded to integer targets 1 through 60. Existing defaults remain 30 for iOS and 24 for Android. The browser cannot choose this worker setting.

Android now paces captures against monotonic deadlines. Previously, timer oversleep accumulated on every frame, producing about 52 FPS at a requested 60 on this Mac. The updated pacing compensates for oversleep and drops missed deadlines without building a historical-frame queue. Capture dimensions, JPEG quality, input validation, signing gates, and session handling are unchanged.

Run the existing worker setup with `--fps 60` appended to `worker.py` or `android_worker.py`. A target is not a delivered-FPS guarantee.

## Initial measurements

Each number below averages three 10-second samples of browser canvas frame-counter deltas. Browser timing and sample boundaries can put an individual sample slightly above 60.

| Implementation | Capture size | Previous pacing at target 60 | Updated target 60, static screen |
| --- | --- | --- | --- |
| iOS SwiftUI | 604 × 1312 | Not applicable; prior capture target fixed at 30 | 59.86 FPS |
| Android Kotlin | 432 × 960 | 52.00 FPS | 60.02 FPS |
| Android React Native | 432 × 960 | 51.99 FPS | 59.59 FPS |

The iOS 30 FPS baseline averaged 30.02 FPS. Android's original 24 FPS pacing delivered about 22.2 FPS; deadline pacing delivers about 24 FPS. With repeated native swipes at target 60, iOS averaged 59.96 FPS, Kotlin 59.96 FPS, and React Native 59.73 FPS.

Static-screen JPEG payload bandwidth was approximately 46 Mbps for iOS and 15–16 Mbps for Android at target 60. These are different resolutions/quality settings, so these figures do not establish relative framework efficiency. Network/protocol overhead is excluded.

## Evidence and limitations

- [Combined measured data](../../platform/evidence/README.md#evidence-5b410c88c6b26727) (`output/ios-fps-20261014/summary.json`)
- [iOS native home at target 60](../../platform/evidence/README.md#evidence-841bf04a92b71a95) (`output/ios-fps-20261014/ios-60.png`)
- [Android Kotlin at target 60](../../platform/evidence/README.md#evidence-4ab2ad30c7ecf6c2) (`output/ios-fps-20261014/android-paced-kotlin-60.png`)
- [Android React Native at target 60](../../platform/evidence/README.md#evidence-97b5c7390ed80ea6) (`output/ios-fps-20261014/android-paced-react-native-60.png`)

Browser-painted FPS measures transport presentation, including repeated static frames. It does not establish 60 distinct app-rendered frames per second, physical display presentation, input latency, or cloud performance. The scrolling tests send native swipe gestures but do not measure unique rendered-frame cadence.

The iOS static and swipe benchmarks initially used a test override of the exact idb FPS argument; the same option is now supported by the worker and covered by a forwarding test. Android's final measurements use the updated production `AndroidInput` capture loop. A separate old capture adapter remains at 1 FPS to keep the disposable test emulator alive during the Android pacing comparison.

The worker suite passes 28 tests, including FPS validation, iOS idb argument forwarding, Android deadline pacing and oversleep compensation, framing, input validation, and existing worker authorization checks. No cloud deployment was made.
