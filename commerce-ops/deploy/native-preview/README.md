# Native simulator worker pilot

The [Android EC2 controller](../aws-automation/README.md) owns Android worker instance
and session lifecycle control, IAM policies and service installation. Its
canonical source is `commerce-ops/deploy/aws-automation/`. The macOS worker described below has its own deployment
and acceptance scope.

This worker runs the **signed RocentoStudio SwiftUI application**, using the same
Storefront rendering implementation as the generated standalone app. It owns a
separate CoreSimulator device set, creates a new device for each session, and
captures continuous native Motion JPEG video through an idb companion. The browser
decodes those frames and forwards taps, completed drag gestures, wheel scrolling,
and English keyboard input to that same simulator. It does not draw SwiftUI screens.
Capture defaults to 30 fps; pass `--fps 60` to `worker.py` for a 60 fps target.
The operator can select an integer target from 1 through 60. Delivered rate depends on the simulator and is measured
in the browser. This is not a WebRTC/H.264 media relay.

The implementation supports one configured macOS worker with bounded capacity.
It does not yet include a fleet scheduler, queued allocation, autoscaling,
a production media relay. Capacity exhaustion returns 503.
No cloud infrastructure has been provisioned or remotely validated.

## Local validation

Use Xcode with an installed iOS runtime and Meta idb 1.7.0 (client) / companion build 64,
validated locally with Xcode 26.2. Install using the [official idb instructions](https://fbidb.io/idb/installation/).
The worker fails closed if the companion or its native capture is unavailable.

Use Xcode with an installed iOS runtime. Build each merchant's Studio scheme with
`commerce-mobile-apps/tools/build_ios_simulator.py`, including the trusted HTTPS builder origin.
The worker uses the existing **Debug Studio** preview bootstrap; standalone and
release customer apps are not modified. Follow the signing guide before building.

Create a private operator manifest (the browser cannot supply artifact paths):

```json
{
  "312f9ac8-4888-4d35-92a0-e5fdb3bf59b8:production": {
    "app": "/absolute/path/Rocento.app",
    "bundleId": "com.rocento.grocery"
  }
}
```

The worker verifies the signed artifact and its embedded tenant/environment.
Provide a random >=32-character `MOBILE_PREVIEW_WORKER_TOKEN` to both gateway and
worker through private environment configuration. Set the gateway's
`MOBILE_PREVIEW_WORKER_URL=http://127.0.0.1:19095` and run:

```sh
python3 commerce-ops/deploy/native-preview/worker.py \
  --artifacts /absolute/path/artifacts.json \
  --state /absolute/private/worker-state \
  --signing-check commerce-mobile-apps/tools/check_ios_signing.py \
  --runtime com.apple.CoreSimulator.SimRuntime.iOS-26-2
```

Use `--trust-cert /path/local-ca.pem` only for a local HTTPS test gateway. A cloud
artifact must be built with the real reachable HTTPS gateway origin. The worker
binds only to loopback. Start the Builder and select **Open iOS Preview**. No native
capability is sent to the browser in worker mode. Local manual pairing remains
available separately.

## Existing AWS EC2 Mac host (later)

Use an already provisioned compatible Mac with Xcode, the matching simulator
runtime, Python 3 and an authenticated SSH account. Provisioning/billing is outside
these scripts. Prepare a package on the build Mac:

```sh
python3 commerce-ops/deploy/native-preview/package.py --artifacts /private/artifacts.json --output /tmp/native-preview.tar.gz
```

Transfer and unpack this operator-generated archive into a dedicated deployment
directory on the Mac using your approved SSH deployment mechanism. It contains
signed apps, worker code, the input/capture adapter and an allowlist; no session or worker credentials.
Configure a restricted service account and an owner-only token file. Run
`launch.py` under your service supervisor with:

- `MOBILE_PREVIEW_STATE`: absolute private writable state directory.
- `MOBILE_PREVIEW_WORKER_TOKEN_FILE`: owner-only token file, shared with gateway configuration.
- `MOBILE_PREVIEW_RUNTIME`: installed CoreSimulator runtime identifier.
- `MOBILE_PREVIEW_CAPACITY`: measured safe capacity, initially `1`.
- `MOBILE_PREVIEW_FPS`: requested capture rate, from 1 to 60; defaults to `30`.

On the gateway host, configure `MOBILE_PREVIEW_SSH_HOST` and
`MOBILE_PREVIEW_SSH_USER`, pre-verify the SSH host key, then supervise
`python3 commerce-ops/deploy/native-preview/tunnel.py`. Authentication uses the configured SSH
agent/identity. No insecure host-key bypass is provided. Configure the gateway
worker URL to its loopback forwarded port and the same worker bearer secret.
Neither simulator nor worker port needs public inbound access. macOS worker needs
outbound HTTPS to the configured draft/commerce gateway.

## Security and lifecycle

Every browser video connection and input request checks the admin cookie, active owner/designer role,
merchant, session creator, expiry and revocation. Start/stop use existing CSRF
controls. Worker URLs are operator-only, HTTPS or loopback; redirects are refused.
Session capabilities live in memory/process environment, never in URLs or logs.
Frames are bounded, private and no-store. Video rechecks the administrator cookie,
membership and session every two seconds while delivering chunks. Worker heartbeats
keep startup connections alive. The private idb companion binds to a Unix socket
inside the owner-only worker directory, never a public TCP port. A missing stream clears the displayed
frame rather than implying the screen is still live. ACKs and frame delivery are
separate: an ACK does not prove a particular captured image shows that revision.

A session expires after 30 minutes; loss of browser polling releases its device
after a 45-second lease (initial startup allowance 180 seconds). Stop revokes the
capability before worker cleanup. A crash loses all sessions; restart removes only
worker-named devices in this worker's private device set. Failed deletion
quarantines capacity until restart/recovery. A file lock prevents two processes
from managing the same set. Operators must use a dedicated host account and not
share its files/process access with tenants. This is process/device isolation,
not a separate macOS VM security boundary for each customer.

Remote completion requires evidence of a simulator running **on the remote Mac**,
its output displayed inside Apps Builder, tenant/expiry tests, and an edit followed
by both native ACK and visibly updated streamed output. Local evidence is not
cloud acceptance.

## Acceptance recorded on 2026-10-13

Local browser acceptance passed with actual signed SwiftUI frames, shared color
and spacing token updates, section edits, revision acknowledgements, stream
interruption/recovery and explicit stop. Evidence is recorded in
[the acceptance report](../../../commerce-docs/mobile/history/native-worker-stream-acceptance-2026-10-13.md).
This does not establish cloud deployment readiness or remote hosting acceptance.

## Interactive transport

`GET .../sessions/{session}/video` delivers `application/x-rocento-mjpeg` as a
little-endian uint32 frame length followed by JPEG bytes. Zero length is a
heartbeat. Each JPEG is limited to 2 MiB. The capture process is continuous,
independent of browser connection count; slow viewers receive the latest frame
without an unbounded worker frame queue. Two video connections per session allow
reconnect overlap. The browser bounds buffering, detects stalled video, clears
old pixels and disables input during disconnect, then reconnects.

`POST .../sessions/{session}/input` uses the existing admin-cookie/CSRF policy.
Allowed inputs are `tap`, `swipe`, `text`, and a fixed set of editing/navigation
keys. Coordinates are normalized to the displayed native image and converted to
integer simulator points from idb's reported dimensions. A pointer drag sends a
native swipe when released; this is not continuous finger tracking or multi-touch.
Wheel events send bounded native swipes. The canvas takes keyboard focus on click;
Tab leaves it. Text currently supports printable English characters; IME, Arabic
text and clipboard paste are not implemented. Native autocapitalization still applies.

Each input carries a monotonically increasing sequence number, consumed before
execution. Duplicate input is rejected and failed requests are never replayed.
Browser input is serialized with a bounded queue and discarded on disconnect.
The gateway has a separate input rate limit and a 2 KiB request-body limit. Neither
input nor video can choose a device, app, process, URL or shell command.

Capture and companion processes are stopped before the simulator is deleted.
If a process stalls during termination, the worker kills only that owned child.
Run `python3 -m unittest discover -s commerce-ops/deploy/native-preview` for protocol/input tests.
The real browser acceptance script is
`commerce-web/e2e/mobile-studio/native-preview-interactive.mjs` (local fixture setup).

[Interactive local acceptance](../../../commerce-docs/mobile/history/native-interactive-preview-acceptance-2026-10-13.md) records approximately 30 fps, native input, reconnect and server revocation with browser video evidence.

## Android pilot

Apps Builder also supports a separate real Android emulator worker. See
[Android setup, isolation and EC2 release gates](ANDROID.md). iOS and Android
sessions share the authenticated browser video/input protocol, but run on
independently configured workers. Android currently uses a bounded screenshot
capture transport rather than the iOS idb stream.
