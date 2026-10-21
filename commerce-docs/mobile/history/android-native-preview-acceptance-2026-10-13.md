# Android native preview acceptance — 2026-10-13

Historical checkpoint. Later records may supersede these deployment statements; see the [mobile status](../../frontend/README.md) and [history index](README.md).

Status: implemented and locally validated. **Not deployed to apps.rocento.com or EC2.**

Apps Builder can select Android and open the real Kotlin/Compose Studio app in a
worker-owned Android 36 emulator. Native draft access remains separate from
published enrollment and customer credentials. Platform is persisted on the
server session and selects the correct worker for video, input and stop.
The gateway checks Android runtime compatibility for Android sessions; existing
sessions retain iOS behavior.

## Final local acceptance

The final fixed-frontend browser run passed at **4.796 fps** over five seconds,
using 540 × 1200 native emulator pixels and a 5 fps screenshot capture cap.
This is a low-frame-rate pilot, not a 30 fps streaming release.

- Opened a signed Studio APK through the gateway and Android worker.
- Saved a changed section and observed native acknowledgement of revision 4.
- Verified the changed text in Android's accessibility hierarchy and screenshot.
- Browser tap focused the native search field; typing produced native text `milk`.
- Browser wheel input delivered an Android swipe.
- Browser disconnect cleared the preview; reconnect restored fresh frames.
- Stop removed the browser preview and the disposable AVD. The worker state
  directory contained only its lock file after cleanup.

Evidence:

- [Builder with Android preview](../../platform/evidence/README.md#evidence-e1cb30739587d15a) (`output/android-native-preview-20261013/builder-android.png`)
- [Native edited section](../../platform/evidence/README.md#evidence-d29a5e2adb7ffa45) (`output/android-native-preview-20261013/android-draft-updated.png`)
- [Native keyboard input](../../platform/evidence/README.md#evidence-02503fed3fa1dc41) (`output/android-native-preview-20261013/android-keyboard.png`)
- [Measured result](../../platform/evidence/README.md#evidence-1de79e3ce5369ea1) (`output/android-native-preview-20261013/result.json`)

The isolated fixture has no working commerce catalog connection; the native
screen's store-loading error remains visible. This validates native preview,
editing and input, not live shopping, checkout or production catalog readiness.
No purchase or assistant message was submitted.

## Checks

- Gateway compilation and six preview integration tests passed, including Android
  platform/runtime persistence, tenant/creator isolation and expiry/revocation.
- Eleven worker tests passed for authentication, framing, input bounds, sequence
  handling, Android coordinate mapping, shell quoting and JPEG capture.
- Android adapter unit tests passed, including draft checksum validation,
  apply-before-ACK, unauthorized-response handling and cancellation.
- Standalone core tests, standalone/Studio APK assembly, instrumented-test
  compilation and lint passed. The standalone APK passed the dependency guard.
- Native boundary guard and 67 native tooling/signing tests passed.
- Builder TypeScript and production Vite build passed.
- Every disposable installation passed the signing/destination gate with the
  existing debug certificate. No user installation was removed or cleared.

A first run exposed an ADB stdin bootstrap problem, corrected by using non-PTY
shell stdin and an app-private mode-600 file. A repeat was interrupted by frontend
hot reload while UI edits were occurring; final acceptance used a fixed frontend
build. The final browser harness also verifies the exact saved revision and native
text rather than relying only on an earlier acknowledgement.

Local test TLS resources and a local HTTPS origin were injected into a separate
acceptance APK with a temporary Gradle init script. Production TLS validation was
not weakened, and the normal Studio output was rebuilt without those resources.
The native credential storage contract and standalone default remain unchanged.

## EC2 gate

A read-only inspection of the documented production EC2 host found `aarch64`, no
`/dev/kvm`, and no emulator/ADB tools. It had 15 GiB RAM with roughly 5.4 GiB available
at inspection. No production files, processes, services or infrastructure were
changed. This host is not ready to run the inspected Android emulator worker.

Provision/configure a compatible accelerated worker separately, then perform the
same acceptance remotely before enabling it at apps.rocento.com. Local acceptance
does not demonstrate remote capacity, latency or isolation. See the
[Android setup and release gates](../../../commerce-ops/deploy/native-preview/ANDROID.md).
