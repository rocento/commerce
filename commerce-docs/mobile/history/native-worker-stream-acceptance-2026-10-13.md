# Local native worker and browser stream acceptance — 2026-10-13

Historical checkpoint. Later records may supersede these deployment statements; see the [mobile status](../../frontend/README.md) and [history index](README.md).

Status: **locally verified; remote cloud preview is not complete**. No AWS resources
or remote Mac were provisioned. EC2 Mac preparation consists of a signed artifact
package, configurable worker launcher, verified-host SSH tunnel, and runbook.

## Real native result

The Apps Builder's **Open iOS Preview** action started an authenticated session and
a dedicated iPhone 17 Pro / iOS 26.2 simulator in a private worker device set. The
worker installed the signed RocentoStudio app only after inspecting the actual
destination with the existing signature/Keychain gate. The generated app and
preview continue to share the Storefront SwiftUI renderer.

The actual app display was captured as PNG on the simulator and delivered through
the creator/tenant-authorized gateway endpoint into an image in Apps Builder.
No browser-rendered phone was used as native evidence.

The final run applied revisions **12 → 13 → 14**:

- Changed the primary color from purple to blue and density from compact to comfortable.
- Changed section text to “Native SwiftUI stream updated from the builder”.
- Observed native revision/checksum acknowledgements after autosave.
- Inspected streamed native images: the color, text and spacing changed.
- Interrupted browser frame requests: the image disappeared with a disconnected status.
- Restored requests: actual simulator frames returned without restarting the native app.
- Stopped the session: the browser cleared the image and the worker's private device list became empty.

The earlier local-sync acceptance separately covers native draft transport outage,
full-snapshot reconnect, stale revision rejection and runtime compatibility.
Frames and ACKs remain separate signals; there is no claim that an individual PNG
is cryptographically tied to a draft revision.

## Evidence

- [Builder containing the real simulator stream](../../platform/evidence/README.md#evidence-306a03360f92b7c0) (`output/native-worker-stream-20261013/builder-stream.png`)
- [Native before](../../platform/evidence/README.md#evidence-36dd421234aea601) (`output/native-worker-stream-20261013/native-before.png`)
- [Native after](../../platform/evidence/README.md#evidence-57ae6c78f96494a7) (`output/native-worker-stream-20261013/native-after.png`)
- [Machine-readable result](../../platform/evidence/README.md#evidence-b75cf5435dced7b4) (`output/native-worker-stream-20261013/result.json`)

Evidence contains synthetic fixture content; session tokens, cookies, keys and
worker credentials are excluded.

## Checks

- Gateway `cargo check -p api-gateway --offline`: passed.
- Worker frame endpoint tenant/creator/expiry test: passed.
- Native session tenant/revision/expiry and capability/asset/issuer tests: 2 passed.
- Worker validation/capacity/staleness/HTTP bearer tests: 4 passed.
- Mobile tooling tests, including private-device-set signing checks: 67 passed.
- Native boundary guard: passed.
- Builder TypeScript and production Vite build: passed (bundle-size advisory remains).
- Signed deployment package generation and content inspection: passed.
- API documentation inventory still fails on 8 pre-existing unclassified catalog,
  delivery-fee and customer-push routes. Both new worker routes are classified.

An intermediate browser rerun was interrupted by a Vite reload while generated
build files changed; the final run was performed after builds finished and passed.
The temporary Docker outage was recovered without deleting database volumes.

## Limits

This is a single configured macOS worker with bounded capacity and a read-only
PNG stream refreshing every four seconds. No remote deployment, fleet scheduler,
autoscaling, WebRTC video, browser touch input or physical-iPhone acceptance is
claimed. Worker process/device isolation requires a dedicated host account; it
is not a per-tenant macOS virtual-machine boundary.

Use the [worker runbook](../../../commerce-ops/deploy/native-preview/README.md) for local setup
and later existing-host deployment. Remote completion requires running the worker
on that remote Mac and verifying its real output inside Apps Builder.
