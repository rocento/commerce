# Android native preview worker

This pilot runs the actual opt-in Android Compose app in an isolated disposable
AVD and streams JPEG frames into Apps Builder. It supports taps, completed swipe
gestures, printable English keyboard input, reconnect and stop. Capture uses
authenticated emulator RGB capture over a persistent loopback gRPC connection,
with a default target of 24 fps. Pass `--fps 60` to `android_worker.py` to request
60 fps for either Kotlin or React Native. Integer targets from 1 through 60 are
accepted; capture and browser delivery must be measured on the intended host.

## Build and operator manifest

Use JDK 21, SDK Build Tools 35.0.1, platform-tools and a matching installed system
image. Build a trusted Studio APK with the real HTTPS gateway origin:

```sh
JAVA_HOME=/path/to/jdk21 commerce-mobile-apps/android/gradlew -p commerce-mobile-apps/android \
  -PappBuilder=true -PpreviewOrigin=https://grocery.rocento.com/api \
  :app:assembleRocentoDebug
```

Do not deploy an acceptance APK with a local origin or a local test certificate.
The worker needs a debuggable Studio APK for its private-file bootstrap. Production
customer APKs and their enrollment/Keystore data are not used or modified.
Follow [Android signing requirements](../../../commerce-mobile-apps/android/SIGNING_AND_KEYSTORE.md).

Prepare a private operator manifest; use the artifact SHA-256 and the intended
existing signing-certificate SHA-256 from the signing checker. The operator must
verify the APK's merchant, environment and trusted builder origin before adding it.
The native adapter independently enforces merchant/environment on every request.

```json
{
  "312f9ac8-4888-4d35-92a0-e5fdb3bf59b8:production": {
    "apk": "/opt/rocento-preview/artifacts/grocery-studio.apk",
    "packageId": "com.rocento.grocery",
    "sha256": "REPLACE_WITH_APK_SHA256",
    "certificateSha256": "REPLACE_WITH_EXISTING_SIGNER_SHA256"
  }
}
```

The worker validates APK integrity and signing at startup, then runs the mandatory
signing/destination gate before each installation. It passes the capability through
stdin into the app's private storage with mode 600. The app consumes and removes
that file; the capability remains in memory, separate from enrollment and commerce
credentials. Missing/invalid bootstrap cannot enroll an app or enable published
configuration access.

## Run

Create a dedicated Python virtual environment with
`pip install -r commerce-ops/deploy/native-preview/requirements-android.txt`. Use a dedicated
host account and owner-only state directory. Set a random token of at least 32
characters in private service configuration, not shell history:

- Gateway: `MOBILE_ANDROID_PREVIEW_WORKER_URL` and `MOBILE_ANDROID_PREVIEW_WORKER_TOKEN`.
- Worker: the same `MOBILE_ANDROID_PREVIEW_WORKER_TOKEN`.

```sh
/path/to/venv/bin/python commerce-ops/deploy/native-preview/android_worker.py \
  --artifacts /private/android-artifacts.json \
  --state /private/android-preview-state \
  --sdk /opt/android-sdk \
  --system-image /opt/android-sdk/system-images/android-36/google_apis/x86_64 \
  --signing-check commerce-mobile-apps/tools/check_android_signing.py
```

Default capacity is one. The worker binds `127.0.0.1:19096`, uses private ADB server
port 5038 and owned emulator ports starting at 5580. These must be unused and must
not be exposed publicly. The device data is private per session; normal stop,
expiry, browser lease expiry and service termination stop owned processes and
remove that data. A crash leaving session directories fails closed on restart:
verify the old worker/emulator processes have stopped before removing their
private residue. Do not delete a user's personal AVDs or kill unrelated ADB servers.

The gateway uses persisted session platform to route frame/video/input/stop to the
correct worker. Apply `20261013020000_android_preview_platform.sql` with the normal
migration runner before starting the new gateway. Existing sessions default to iOS.
Existing iOS worker environment variables remain valid. The browser cannot choose
worker URLs, artifact paths, device serials or shell commands.

Remote workers require a private authenticated HTTPS endpoint or an SSH tunnel
whose loopback endpoint is reachable **inside the gateway's network namespace**.
A Docker gateway's loopback is not the host's loopback. Configure the two gateway
environment values through the deployment's compose/service configuration and
verify streaming proxy buffering is disabled. Keep worker/ADB/emulator ports closed
to the public internet. This repository does not provision an EC2 worker automatically.

## EC2 release gate

The production host checked on 2026-10-13 was ARM64, had no `/dev/kvm` and no SDK
emulator/ADB binaries. No production configuration was changed. It cannot run this
worker in its inspected state. Use a compatible host and verify the installed
emulator's `-accel-check` passes as the service account. On Linux, verify `/dev/kvm`
exists and is accessible. AWS documents supported nested-virtualization instance
types and the enablement procedure in
[its EC2 guide](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html).
Do not assume that an arbitrary virtual EC2 instance supports acceleration.

Before releasing to apps.rocento.com, prove remote boot, HTTPS draft fetch and ACK,
visible saved edits, native input, disconnect/reconnect, creator/tenant isolation,
revocation, expiry and device cleanup on the selected host. Measure frame rate and
startup time under intended capacity. Local acceptance alone does not establish
remote readiness. The screenshot transport is a low-frame-rate pilot.

## Tests

```sh
/path/to/venv/bin/python -m unittest discover -s commerce-ops/deploy/native-preview -v
python3 commerce-mobile-apps/tools/check_boundaries.py
# JDK 21 / Android SDK:
commerce-mobile-apps/android/gradlew -p commerce-mobile-apps/android -PappBuilder=true :app-builder:testDebugUnitTest
# With isolated gateway/worker/Builder and PREVIEW_FIXTURE_STATE configured:
node commerce-web/e2e/mobile-studio/android-preview-interactive.mjs
```

The browser acceptance uses the local native preview gateway fixture and the
HTTPS bridge in `commerce-ops/scripts/local/native-preview-local-proxy.py`. Local TLS trust is injected
only into a separate acceptance APK using temporary debug resources and a Gradle
init script; no trust-all TLS client or production trust change is added.

### Fast capture transport

The worker starts a per-session, token-authenticated emulator gRPC endpoint at
`127.0.0.1:19500` (one consecutive port per capacity slot). Discovery and its token
live under the mode-700 session runtime directory and are removed with the AVD.
Never expose this endpoint through nginx or a security group. The browser continues
to receive the authenticated bounded JPEG protocol; touch and keyboard input use the same private authenticated gRPC channel.

Capture requests RGB888 pixels at 432×960 through one persistent channel with a
2-second deadline, encodes JPEG at quality 60, and retains only the latest frame.
A maximum of one capture request is in flight, at the configured target (24 fps by default, up to 60). Invalid frames fail
closed; three transient RPC failures end the session. Fresh captures of static
screens preserve the existing liveness checks. No per-frame shell process or PNG
compression remains.

Install `requirements-android.txt` before deploying `android_capture.py`,
`android_capture_pb2.py`, `android_avd.py` and `android_worker.py`. The checked-in protobuf code is
generated from the narrow wire-compatible `android_capture.proto` subset using
`grpcio-tools==1.78.0`: `python -m grpc_tools.protoc -I commerce-ops/deploy/native-preview
--python_out=commerce-ops/deploy/native-preview commerce-ops/deploy/native-preview/android_capture.proto`.

### Faster isolated startup

`prepare_android_seed.py` creates a brand-new AVD while holding the worker lock.
Stop the worker only after its authenticated health endpoint reports zero active
sessions. Run the builder with the worker SDK/system image/state and a new private
output directory. It installs no APK and refuses any third-party package. After
Android finishes first boot, it shuts the emulator down and seals both userdata
and the matching encryption metadata into raw images. It never uses a merchant
session as its source.

Set `MOBILE_ANDROID_PREVIEW_SEED=/private/seed/manifest.json` (or `--seed`) before
starting the worker. Startup verifies the system-image, seed and encryption-image
SHA-256 hashes and device geometry. Each preview clones the OS template into its
own disposable AVD and private encryption-key file, then runs the existing signing
and install gate and injects its capability. Normal cleanup removes all session
state. Rebuild the template for any system-image or incompatible geometry change. Omitting the
setting retains the original unseeded startup path.

Input is transported as protobuf values, so quotes, percent signs and shell syntax
remain literal text. Touch release runs even when a swipe is interrupted. Existing
input validation, monotonic sequences, tenant authorization and lease expiry are
unchanged. The capture loop defaults to 24 fps; only measured browser results establish
actual smoothness on the deployed instance.

The emulator now renders at 432×960 / 168 dpi instead of 540×1200 / 210 dpi.
Both have the same logical dp layout; the smaller framebuffer reduces software-GPU
work on the existing two-core EC2 host. OS-only templates from either geometry are
accepted because they contain no saved RAM or GPU state. Session userdata copies
preserve sparse holes (`cp --sparse=always --reflink=auto`) rather than expanding
the image through the emulator's `-initdata` path.

The browser drains incoming complete frames without waiting for JPEG decoding. It
keeps one newest JPEG and one pending bitmap, closes superseded bitmaps, and paints
on animation frames. This avoids replaying old frames after a network/decoder stall.
The displayed fps counter and canvas frame count now count paints. Regression:
`cd frontend && node e2e/mobile-studio/native-video-latest-frame.mjs`.

Android JPEG frames carry a small standard JPEG comment with capture time. The
browser compares capture-time progress with its monotonic elapsed time, so wall
clock skew does not affect the freshness check. More than 1.2 seconds of additional
transport delay drops the stale frame and reconnects to the worker's latest frame.
This measures delay accumulated since connection, not absolute end-to-end latency.
Legacy untagged iOS frames remain supported. Video sockets use a 64 KiB send buffer
and a two-second write timeout; JPEG quality 60 reduces bandwidth.

The worker and seed builder use the supported `swiftshader` renderer. The current
OS-only template is built at the runtime display geometry and settles for 60 seconds
before sealing; any `am_anr` event rejects the template. At runtime, boot completion
is followed by an explicit SystemUIService startup-completion check before APK
installation. A startup ANR fails the session instead of exposing a blocked app.
The previous template and worker files are retained for operator rollback.
