# Mobile documentation

Current repository guidance for SwiftUI, Kotlin/Compose, React Native and Apps Builder. Reviewed against source and retained evidence on 2026-10-14. The recorded deployment checkpoints below are not a fresh live-service check.

## Capability and acceptance status

| Capability | Implementation | Recorded verification / remaining gate |
| --- | --- | --- |
| Standalone storefronts | Three independent native implementations; Swift published settings with bundled fallback, optional Studio delivery elsewhere | Local commerce and fixture checks exist; signed physical-device release acceptance remains open |
| Studio authoring and publication | Production drafts, validation, owner publication and immutable releases | Enrollment/publication evidence from 2026-10-12; later preview records refer to published v6; inspect the target before relying on a version |
| SwiftUI native preview | Authorized draft snapshots, ACK, local worker frames and input | Signed local simulator acceptance recorded 2026-10-13; hosted iOS is disabled in the 2026-10-14 Android deployment |
| Kotlin/Compose native preview | Authorized draft adapter and Android worker | Local acceptance and 2026-10-14 EC2/App Studio acceptance recorded; later Kotlin input run encountered an app stall |
| React Native preview | Optional native Studio entry, draft snapshots, private assets and all six home section types | Local iOS/Android section acceptance and Android EC2 functional acceptance recorded; full navigation/dark-theme parity remains open |
| Shared Android hosting | Kotlin and React Native share one operator-controlled worker slot | EC2 pilot deployed and tested on 2026-10-14; intermittent System UI/app stalls remain a reliability limit |
| Push and store distribution | Native APNs/FCM integration prepared and disabled by default | Owner deferred provider activation; signed-device delivery and store distribution remain separate gates |

Implementation, local verification, deployment and production acceptance are separate states. Draft ACK confirms application of a revision; it does not identify the revision visible in a frame or prove successful commerce requests. The [history index](history/README.md) links the evidence and its limits.

## Current guides

| Guide | Owns |
| --- | --- |
| [Architecture and state ownership](architecture.md) | Native modules, editor isolation, runtime composition and feature state |
| [Development and verification](development.md) | JDK 21, native build modes, safe install boundaries and checks |
| [React Native](react-native.md) | Independent Expo setup, storage, native builds and isolated acceptance |
| [Commerce](commerce.md) | Customer sessions, delivery, reviewed checkout and optional Studio enrollment |
| [App Studio](app-studio.md) | Browser authoring, simulation, permissions and publishing |
| [Configuration contract](configuration-contract.md) | Schema ownership, token compatibility and generated resources |
| [API and security](api-and-security.md) | Control plane, draft/published delivery and trust boundaries |
| [Native preview](native-preview.md) | Native consumers, connection modes, recorded acceptance and worker runbooks |
| [Build and release](build-and-release.md) | Binary/config changes, signing and distribution boundaries |
| [Device signing](device-signing.md) | Owner inputs and physical-device acceptance procedure |
| [Order push](order-push.md) | Disabled integration, provider configuration and activation gates |
| [Plans](plans/README.md) | Remaining preview, parity and release acceptance |
| [History](history/README.md) | Dated implementation, deployment and validation records |

## Source-adjacent requirements

[Mobile contributor instructions](../../commerce-mobile-apps/AGENTS.md), [iOS](../../commerce-mobile-apps/ios/CODING_STANDARDS.md) and [Android](../../commerce-mobile-apps/android/CODING_STANDARDS.md) standards, [iOS signing](../../commerce-mobile-apps/ios/SIGNING_AND_KEYCHAIN.md), [Android signing](../../commerce-mobile-apps/android/SIGNING_AND_KEYSTORE.md), [performance safeguards](../../commerce-mobile-apps/PERFORMANCE.md), [backend mobile APIs](../backend/mobile-experience.md), and [preview deployment runbooks](../../commerce-ops/deploy/native-preview/README.md) retain ownership of their specialized contracts.
