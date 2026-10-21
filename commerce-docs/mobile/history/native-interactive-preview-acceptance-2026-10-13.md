# Local interactive SwiftUI preview acceptance — 2026-10-13

Historical checkpoint. Later records may supersede these deployment statements; see the [mobile status](../../frontend/README.md) and [history index](README.md).

Status: **implemented and locally validated**. Cloud hosting was not provisioned
or validated.

## Delivered behavior

Apps Builder opens a dedicated signed RocentoStudio application in a worker-owned
iOS 26.2 simulator. The existing shared SwiftUI renderer remains unchanged.
Continuous native Motion JPEG capture replaces the four-second PNG polling UI.
The browser canvas decodes simulator frames; it does not emulate native screens.

The worker runs Meta idb client 1.7.0 and companion build 64. Capture requests 30 fps
at half native pixel dimensions (604 × 1312 in this test). The final browser run
measured **29.976 fps** over five seconds. An earlier run with another simulator
and capture probe active measured approximately 15 fps; performance depends on
host capacity and concurrent workloads. This measurement is not a latency SLA.

Browser controls validated against the actual native application:

- Click/tap focused the SwiftUI search field.
- Browser wheel events scrolled real native content; before/after images were inspected.
- Browser pointer drags delivered native swipe gestures.
- English keyboard entry reached the native field; its accessibility value was `Milk`.
- Backspace changed the native value to `Mil`.
- Browser offline handling cleared video and disabled controls; reconnect resumed video.
- Typing after reconnect restored `Milk`, without resetting/replaying input sequence numbers.
- Revoking the session through the API terminated an independently opened video response.
- The browser removed the preview; the worker's private simulator device set was empty afterwards.

The synthetic fixture has no live catalog connection, so its native commerce
loading error is not a preview transport failure. No purchase or assistant message
was submitted during validation.

## Evidence

- [Recorded native interaction](../../platform/evidence/README.md#evidence-01d90e95d4f4eb15) (`output/native-interactive-preview-20261013/native-interaction.webm`)
- [Apps Builder with interactive native video](../../platform/evidence/README.md#evidence-5a359649d8b77ab3) (`output/native-interactive-preview-20261013/builder-video.png`)
- [Native home](../../platform/evidence/README.md#evidence-b35dfa8ef5ab6a8a) (`output/native-interactive-preview-20261013/native-home.png`)
- [Native scroll](../../platform/evidence/README.md#evidence-a107458a6dc6e310) (`output/native-interactive-preview-20261013/native-scrolled.png`)
- [Native keyboard value](../../platform/evidence/README.md#evidence-bd837157806a2ac7) (`output/native-interactive-preview-20261013/native-keyboard.png`)
- [Measured acceptance result](../../platform/evidence/README.md#evidence-3a1684ea65c9b289) (`output/native-interactive-preview-20261013/result.json`)

The recording is produced from the browser's decoded simulator video, including
native interactions and the disconnect/reconnect interval. Evidence excludes
session cookies, worker tokens and private signing/TLS material.

## Security and verification

Video and input routes enforce tenant, creator, active membership and session
expiry/revocation. Video rechecks authorization while delivering bytes. Input
requires the existing CSRF header, bounded request size, normalized coordinates,
an allowed operation/key, a separate rate budget and a strictly increasing sequence.
The worker consumes the sequence before execution so lost responses cannot replay
input. Browser queues are bounded and discarded on disconnect. Stale video is
rejected, and idb listens only on a private Unix socket inside worker state.

Checks passed:

- Signed Studio build and destination signature/Keychain gate.
- Gateway build and input validation unit test.
- Video/input tenant, creator and revocation integration test.
- Eight worker protocol, authentication, framing, sequence and coordinate tests.
- Builder TypeScript and production Vite build.
- Native dependency boundary guard.
- Real simulator/browser interaction, video-rate and revocation test.
- Deployment package generation with the new capture/input adapter included.

Existing limitations: the API documentation inventory still reports eight
unclassified routes outside this change; both new routes are classified. Vite
still reports the existing large-chunk advisory.

## Scope limits

This is local Motion JPEG, not cloud WebRTC or H.264 streaming. Drag gestures are
sent as swipes on release; continuous finger tracking, multi-touch, clipboard
paste and IME/Arabic keyboard input are not implemented. English text and the
allowed editing/navigation keys are supported. Remote capacity, isolation and
streaming acceptance remain future work.

Reproduce with `commerce-web/e2e/mobile-studio/native-preview-interactive.mjs` and the
[worker setup](../../../commerce-ops/deploy/native-preview/README.md). The previous PNG pilot
acceptance remains a separate historical record.

## Streaming draft regression and local setup note

The existing Builder-edit regression was adapted to decoded video and passed:
revisions **15 → 16 → 17**, primary-color/density and section edits visibly reflected
in the native app, followed by stream reconnect and stop. See
[the result](../../platform/evidence/README.md#evidence-27176a5a23ab963f) (`output/native-interactive-preview-20261013/theme-sync/result.json`).

Homebrew installed functional idb binaries but reported unsuccessful post-install
steps for ca-certificates, openssl@3 and python@3.14. Retrying those steps did not
resolve the warnings. The native/browser tests passed with the installed client
and companion; these warnings remain an operator setup issue and are not evidence
of complete host package health. No cloud host was modified.
