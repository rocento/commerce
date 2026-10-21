# Native preview

This guide owns draft delivery and connection modes. Capability rows are based on source and the linked dated records, not a fresh live-service check.

## Capability status

| Capability | Implementation | Verification boundary |
| --- | --- | --- |
| Browser simulation | One React DOM renderer with four target selections | Supports authoring and simulated shopping; does not execute native UI |
| Local iOS draft synchronization | Signed Debug merchant app, authorized full snapshots, native application and revision/checksum ACK | Local signed simulator acceptance is recorded separately |
| iOS worker/frame pilot | Single configured macOS worker, private simulator device set, gateway video proxy and browser controls | Implemented pilot; remote/cloud deployment acceptance is not established |
| Android draft synchronization | Optional `app-builder` consumer, Android worker and shared EC2 pilot | Local and deployed acceptance recorded; later Kotlin input regression remains open |
| React Native draft synchronization | Optional Studio entry on iOS/Android, six home sections and private preview assets | Local section acceptance and Android EC2 functional acceptance recorded; full parity and intermittent stalls remain open |

## Native snapshot runtimes

Apps Builder autosaves a validated draft. An owner/designer starts a 30-minute session. The matching SwiftUI merchant app in Debug consumes complete snapshots through `HTTPDraftPreviewTransport` and `DraftPreviewRuntime` in `RocentoAppBuilder`. Release excludes draft transport, runtime and controls; both configurations share the native renderer and published-settings adapter. Legacy Studio scheme names forward to the same app target.

The runtime fetches every four seconds, validates and applies a revision on the main actor, then acknowledges revision/checksum. Failed transport retains the last valid design and backs off to 30 seconds. Full snapshots recover missed revisions. Older revisions and equal revisions with conflicting checksums are rejected.

Draft state and bearer capability remain in memory. They do not replace published caches, `configVersion`, enrollment credentials or customer sessions. A late published refresh cannot overwrite an applied draft. Tenant and builder origin are trusted build-time settings.

Android uses the optional `app-builder` draft runtime. React Native uses `index.studio.ts` and `src/integrations/appBuilder`, sharing the native `LiveStorefront` renderer. Both preserve independent preview capabilities, commerce sessions and published state. React Native ACK follows the React commit and validated private-asset loading; it does not prove completion of asynchronous commerce reads. See the [Android worker runbook](../../commerce-ops/deploy/native-preview/ANDROID.md) and [React Native worker runbook](../../commerce-ops/deploy/native-preview/REACT_NATIVE.md).

## Connection modes

**Manual local connection:** Studio exposes a session code through “Connect local app manually.” Open the matching signed Debug merchant app and enter the code under App settings → Live native preview. Restart requires reconnecting. Stop revokes the session; otherwise it expires.

**Worker pilot:** “Open iOS Preview” starts a session through the gateway and a configured macOS worker. The worker selects an operator-allowlisted signed Debug merchant artifact, creates a simulator in its private device set and captures continuous Motion JPEG video through a private idb companion. The browser decodes native frames through the authorized gateway and sends bounded tap, swipe, wheel and English keyboard inputs. It receives no native bearer capability in worker mode. Setup, signing checks, capacity, leases and cleanup are maintained in the [worker runbook](../../commerce-ops/deploy/native-preview/README.md).

The local pilot supports continuous Motion JPEG capture and native interaction. It has one configured worker and bounded capacity. A pointer drag sends a swipe on release; multi-touch, continuous finger tracking, IME/Arabic keyboard input and clipboard paste remain unsupported. Fleet scheduling, autoscaling, H.264/WebRTC delivery and hosted iOS deployment acceptance remain in the [roadmap](plans/native-preview-and-release.md).

The recorded 2026-10-14 deployment enables Kotlin and React Native Android at apps.rocento.com through the same operator-controlled EC2 worker, with capacity one across both implementations. Owner server controls and native session lifecycle are separate. Recorded functional acceptance does not remove intermittent Android System UI/app stalls. Hosted iOS remains disabled in that deployment. Check operator health and the latest evidence before a demonstration; no fresh live state is claimed here.

## Session security and status

- Merchant control plane creates, inspects and revokes sessions under `/v1/merchants/{merchant}/app-preview/sessions`.
- Native snapshot, ACK and asset requests use `/v1/mobile/preview/{session}` and its child routes, checking issuer access, tenant/environment, expiry and revocation.
- Worker start and frame delivery use merchant-scoped gateway routes; frame access checks session authorization and expiry. The worker is configured by the operator.
- The server hashes native capabilities; definitions and logs must not contain credentials.
- Browser status polling observes native ACK separately from frame delivery. Saving a draft is not native application; an ACK does not establish which revision a captured frame shows.
- Manual sessions survive closing the editor until stop/expiry. Worker sessions additionally use a browser lease and simulator cleanup, as specified in the worker runbook.

## Local acceptance setup

Use a disposable Postgres database named `commerce_native_preview`, bound to localhost. Run `cargo run -p api-gateway --example native_preview_fixture --offline` from `commerce-api/rocento-api`, with `DATABASE_URL` and `PREVIEW_FIXTURE_STATE` pointing to a private temporary JSON file. This fixture refuses non-loopback or differently named databases; it seeds synthetic data only. Its state file contains a temporary test admin cookie: do not publish it.

Run the mobile-admin Vite server with `API_PROXY_TARGET=http://127.0.0.1:18094`. Run `commerce-ops/scripts/local/native-preview-local-proxy.py --cert <local-test-cert> --key <local-test-key> --offline-marker <temporary-marker-path>` to expose only the native preview routes over loopback HTTPS on port 18443. The certificate must cover localhost and be trusted by the selected simulator. Keep its private key outside the repository.

Build and install using the existing signing gate:

```sh
python3 commerce-mobile-apps/tools/build_ios_simulator.py \
  --scheme Rocento --simulator YOUR_SIMULATOR_UDID \
  --builder-origin https://localhost:18443/api \
  --output /absolute/new/build-directory --install
```

The helper preserves the installed bundle/signing/Keychain identity. It only accepts HTTPS builder-origin overrides for merchant schemes. Never substitute an unsigned app or erase simulator credentials.

Run `commerce-web/e2e/mobile-studio/native-preview-sync.mjs` with `PREVIEW_SIMULATOR`, `PREVIEW_FIXTURE_STATE`, `PREVIEW_EVIDENCE_DIR`, and optionally `PREVIEW_OFFLINE_MARKER` set. The test uses the real builder editor and autosave, starts the signed SwiftUI app, checks native ACKs and captures simulator screenshots. The optional marker causes a controlled transport outage and verifies recovery. The debug worker supplies the short-lived capability via the child process environment; it never logs it. Release builds retain published App connection enrollment but exclude live draft preview.

## Validation references

[Local signed simulator acceptance](history/native-preview-acceptance-2026-10-13.md) records edit, outage and recovery evidence. [Cleanup validation](history/mobile-preview-cleanup-2026-10-13.md) records a separate test/build checkpoint. Neither record establishes current remote deployment, physical-device acceptance or frame-to-revision correlation.

[Local worker and browser stream acceptance](history/native-worker-stream-acceptance-2026-10-13.md) records real SwiftUI frames in Apps Builder, token/section changes, reconnect and simulator cleanup. Hosted iOS acceptance remains pending.

[Interactive local acceptance](history/native-interactive-preview-acceptance-2026-10-13.md) records approximately 30 fps, native input, reconnect and server revocation with browser video evidence.


The later [Android EC2 record](history/android-ec2-preview-acceptance-2026-10-14.md) and [React Native Android EC2 record](history/react-native-android-ec2-preview-acceptance-2026-10-14.md) supersede the earlier Android deployment status. The [React Native worker runbook](../../commerce-ops/deploy/native-preview/REACT_NATIVE.md#all-section-acceptance-2026-10-14) records local all-section acceptance. Further gates are in the [preview/release plan](plans/native-preview-and-release.md).
