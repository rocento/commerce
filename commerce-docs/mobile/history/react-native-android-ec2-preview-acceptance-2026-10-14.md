# React Native Android on the shared EC2 preview worker — 2026-10-14

Historical checkpoint. Later records may supersede these deployment statements; see the [mobile status](../../frontend/README.md) and [history index](README.md).

## Deployment

App Studio at https://apps.rocento.com now offers Android · React Native alongside Android · Kotlin / Compose. Both use the existing Frankfurt Android instance `i-0af639278db7286a9`, with one active session across both frameworks. iOS remains disabled.

The worker validates an optional implementation field, resolves React Native to an operator-controlled `merchant:environment:react-native` artifact entry, and preserves the existing Kotlin entry. Capacity exhaustion returns HTTP 409. The preview gateway sends the implementation only for React Native Android, using the same controller URL and token as Kotlin. No additional EC2 instance was created.

- Frontend release: `/var/www/rocento/releases/apps-rn-android-20261014`.
- Preview gateway image initially activated: `sha256:2873641e123a0b6a7b3e5d91fb6be9159c86a12cc2053af5bf13327a2a6a40e5`.
- Coordinated gateway replacement: `sha256:e1da2c6853e6812b2c12337f09f805a19696e61d62df6a52a5061a43974fc9fc`, preserving React Native support and adding the shared long-session polling fix.
- Worker rollback files: `/var/backups/rocento/rn-preview-20261014` on the Android host.
- Gateway rollback container: `rocento-mobile-preview-gateway-before-rn-20261014`.
- Supported pilot scope: Grocery production, merchant `312f9ac8-4888-4d35-92a0-e5fdb3bf59b8`.

## Artifact and checks

The Studio x86_64 APK contains its JavaScript bundle and uses `https://grocery.rocento.com/api`. It does not require a Metro development server.

- Package: `com.rocento.preview.reactnative`, activity `.MainActivity`.
- APK SHA-256: `c769903a3e98d2dc18d88cca1aa1a84894bb2668decea9287eb7a69bd6995b24`.
- Certificate SHA-256: `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`.
- Signing identity was checked locally against the existing baseline and at worker installation.
- Anonymous React Native session creation and server-control requests returned HTTP 401.
- Five worker tests passed locally and on EC2, including framework allowlisting, shared capacity, and HTTP 409 when occupied.
- Thirteen frontend tests, TypeScript checks, production build, and mobile architecture boundary checks passed.

The first browser attempt collided with another authorized Kotlin acceptance session. That attempt was rejected, and the two chats subsequently reserved the shared slot before continuing. A busy slot must never be counted as successful live acceptance.

## Live acceptance

The first complete React Native launch reached a native frame and draft acknowledgement in 83.87 seconds. Both duplicate Kotlin and duplicate React Native starts returned HTTP 409; stopping the instance while the preview was active also returned 409. Saving a temporary primary color produced draft r68 and a matching native acknowledgement. The original color was restored through the authenticated draft API (HTTP 200), without publishing.

Input requests returned 204, but the actual search-text check failed because a System UI ANR dialog covered the app. This is not counted as successful input acceptance. The session was revoked and the worker returned to zero sessions. A subsequent retry was intentionally stopped to hand the shared slot to the Android performance diagnosis. No emulator geometry, seed, or capture configuration was changed by this React Native deployment.

This failed attempt did not establish input/reconnection acceptance. The subsequent functional run below passed, while the intermittent startup risk remains. Evidence: `output/react-native-ec2-20261014/live-anr-attempt.json`, `rn-systemui-anr.png`, and signing/build reports in the same directory.


## Final React Native functional acceptance

The final run on the coordinated `apps-preview-performance-v3-20261014` frontend and `e1da2c...` gateway passed. No additional production code change was made between the failed ANR run and this successful run, so the earlier startup stalls remain an intermittent reliability risk.

- Preview opened and acknowledged draft r78 in 76.064 seconds after session creation. Starting the stopped EC2 host required additional readiness time and two retried transient status failures.
- Browser screenshot and Android UI hierarchy both show `milk` in the search field; a direct Android screenshot shows the corresponding search results.
- Five input requests returned HTTP 204, with no browser JavaScript errors.
- Reload reconnected to the same session.
- Five-second frame sample: 23.8 FPS, under the shared 24 FPS cap. This is not a sustained 30 FPS claim.
- Duplicate Kotlin and React Native starts were both rejected with 409; stopping the host while active returned 409.
- Session cleanup completed. This final run made no draft changes.
- `dumpsys activity lastanr` reported no ANR since boot. No Wait-button recovery was used.

Evidence: `output/react-native-ec2-20261014/live-final-acceptance.json`, `rn-input.png`, `rn-device-input.png`, and `last-anr-live.txt`.


## Kotlin regression and handoff

A subsequent Kotlin session on the same worker opened and acknowledged r78 in 66.895 seconds. Its pre-input UI hierarchy was normal; after tap/typing, the native device displayed “Rocento isn't responding” and the browser showed a black screen. This regression attempt did not pass input acceptance. Both framework capacity checks and the active-session shutdown guard returned 409. No draft edits were made.

The Kotlin session was revoked and controller health independently confirmed running, ready, zero active sessions. The shared instance was left running for the coordinated Android reliability task, which owns further emulator remediation. No additional hardware, instance, or iOS hosting was provisioned.

Kotlin evidence: `output/react-native-ec2-20261014/kotlin-final/live-final-acceptance.json`, `rn-before.xml`, `rn-input.xml`, and `rn-device-input.png`. The test harness was reused and retains an internal `rn` result key in this separate Kotlin directory; the selected target was Kotlin/Compose.

The current result is an enabled, functionally tested React Native Android pilot with known intermittent Android System UI/app stalls. It must not be presented as a fully reliable client demo service yet.
