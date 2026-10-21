# Native preview and release plan

Owner: mobile maintainers and the operator of the target deployment. Status: implementation continues; production release acceptance remains open. Reviewed: 2026-10-14. Current behavior is owned by [native preview](../native-preview.md) and [mobile status](../README.md).

## Implemented baseline

SwiftUI, Kotlin and React Native have optional draft-session consumers. Full snapshots, revision/checksum validation, ACK, and isolation from published caches are implemented. Local workers execute real native apps. Android Kotlin and React Native share a single EC2 slot in the recorded 2026-10-14 deployment. The React Native shared renderer supports all six home section types and private preview banners. These capabilities do not need to be reimplemented.

## Remaining work and acceptance

| Work | Implementation / local state | Deployment / production acceptance gate |
| --- | --- | --- |
| Android pilot reliability | Functional RN input/reconnect run passed; intermittent System UI and Kotlin app stalls recorded | Repeat cold-start, long-session, input and cleanup checks for both frameworks; record failure frequency and sustained frame performance before claiming demo reliability |
| Hosted iOS | Local signed SwiftUI/RN worker paths exist | Provision authorized remote macOS worker, validate private transport, actual native frames, edits/ACK, input, signing, expiry and cleanup; hosted iOS remained disabled in the recorded Android release |
| Hosted isolation and capacity | One shared Android session slot and duplicate-start/active-stop guards tested | Measure quotas, tenant/session isolation, lease cleanup, failed-device recovery and secret handling before adding capacity |
| Physical-device preview and release | Build/signing helpers and local simulator/emulator checks exist | Merchant-signed devices, upgrade credential continuity, commerce/accessibility E2E and store release checks |
| Cross-platform design parity | All six RN home sections implemented; full navigation and dark-theme parity incomplete | Test every supported section/action, loading/error state, RTL, token mode, large text and native screenshots; use [parity plan](storefront-parity.md) |
| Frame/revision correlation | ACK and frame delivery are separate observations | Associate displayed frames with applied revisions and expose stale/unavailable frame state independently |
| Extended interaction/media | Current bounded taps, swipes and keyboard controls exist | Continuous finger tracking, multi-touch, IME/Arabic input, clipboard and production H.264/WebRTC require implementation and acceptance |
| Fleet and release automation | Operator allowlists, build manifests and queue APIs exist | Queued allocation/autoscaling, signing isolation, reproducible jobs, artifact tracking and authorized store submission remain unfinished |
| Push activation | APNs/FCM integration prepared, default off | Remains owner-deferred; follow [order push](../order-push.md) only when resumed |

## Completion rules

Keep browser authoring and simulated shopping until a replacement passes equivalent acceptance. Preserve published definitions, customer credentials and native/editor boundaries. Measure native ACK latency separately from frame visibility. Test tenant isolation, expiry, reconnect and unsupported definitions. A successful build, local fixture run or historical deployment does not close a production acceptance gate.

Arbitrary token references or capability metadata require a compatible schema extension and migration fixtures. Introduce patch/streaming synchronization only for a demonstrated requirement; preserve atomic validation, base-revision recovery, authorization and last-known-good state.

## Evidence

Use the [history index](../history/README.md), especially [Android EC2 acceptance](../history/android-ec2-preview-acceptance-2026-10-14.md) and [React Native EC2 acceptance and Kotlin regression](../history/react-native-android-ec2-preview-acceptance-2026-10-14.md). These records describe their checkpoint and do not establish the current host power state.
