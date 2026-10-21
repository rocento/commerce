# Local React Native preview pilot

React Native previews use the existing simulator/emulator capture and input workers.
They execute signed native React Native apps, not React Native Web or a browser imitation.
Sessions persist both OS (`ios` or `android`) and implementation (`native` or
`react-native`); frame, video, input and stop routing uses that stored selection.
The browser cannot supply worker addresses, binaries, package IDs or commands.

## Current rendering scope

The optional Studio entry (`commerce-mobile-apps/react-native/index.studio.ts`) renders the same
`LiveStorefront` as the standalone application. A core-owned design model supplies
light colors, corner radius, spacing, bilingual copy and all six Builder home
section types: hero banners, product grids, product carousels, category grids,
rich text and spacers. Section order, grid columns, product limits, category
list/tiles and editorial/campaign copy are applied by the shared native renderer.
Home composition replaces the bundled home sections when a design is supplied.
Product/category/tab actions and supported storefront destinations use native
shopping navigation. Collections resolve category IDs/slugs or enabled merchant
storefront feeds through the commerce API, separately from Builder credentials.

Private banner images are fetched by the optional adapter, with per-image and
aggregate size limits and SHA-256 verification, before acknowledging the draft.
The core renderer receives image data URIs and never receives preview credentials.
Unchanged revisions reuse their decoded images; conflicting revision checksums
are rejected. Invalid section types, destinations and translations fail visibly.
This does not claim complete navigation, dark-theme or visual parity with the
SwiftUI/Kotlin applications; the shared light-theme tokens are supported.

The adapter verifies merchant/schema, response session, revision, SHA-256 checksum,
and supported presentation data. It polls full snapshots every four seconds,
retries failed reads, and acknowledges after React commits the shared renderer.
Credentials stay in memory and are kept separate from commerce credentials.
Android consumes/deletes the private worker bootstrap file. iOS consumes a launch
environment variable. Neither platform puts the capability into a URL.

## Build

Use the existing signed React Native bundle/package identity
`com.rocento.preview.reactnative`. Do not replace merchant SwiftUI/Kotlin apps.

- iOS: `python3 commerce-mobile-apps/react-native/scripts/build_ios.py --simulator UUID --output /absolute/new/output --studio-origin https://trusted-gateway/api`
- Android: `python3 commerce-mobile-apps/react-native/scripts/build_android.py --serial SERIAL --output /absolute/new/output --studio-origin https://trusted-gateway/api`

The iOS Studio build embeds a production-mode JS bundle; Android Studio also
embeds its bundle and disables the Metro connection. Default builds retain the
standalone entry and exclude the optional bootstrap implementation. Local TLS
trust must be installed only in disposable test devices/test builds; never
turn off certificate validation or ship acceptance certificates.

## Workers and gateway

Android can share a single worker with Kotlin. Keep `--capacity 1` and point both
Android gateway configurations at the same controller URL and token. The controller
then counts both frameworks for stop protection and automatic idle shutdown.
The gateway includes the implementation in Android React Native start requests;
the worker selects only from its operator allowlist. Use manifest key
`<merchant>:<environment>:react-native` for React Native and retain
`<merchant>:<environment>` for Kotlin. Missing React Native artifacts fail closed.

For a separate iOS React Native worker, use a separate state directory and port
(e.g. 19097) with the existing iOS worker script. Its manifest remains scoped by
`<merchant>:<environment>`.

Configure gateway secrets outside source control:

- `MOBILE_RN_IOS_PREVIEW_WORKER_URL` and `MOBILE_RN_IOS_PREVIEW_WORKER_TOKEN`
- `MOBILE_RN_ANDROID_PREVIEW_WORKER_URL` and `MOBILE_RN_ANDROID_PREVIEW_WORKER_TOKEN`

The iOS worker instance receives its token as `MOBILE_PREVIEW_WORKER_TOKEN`;
Android receives `MOBILE_ANDROID_PREVIEW_WORKER_TOKEN`. Existing native worker
configuration stays unchanged. Apply database migrations before restarting the gateway.

The iOS manifest uses the signed Studio app; its embedded tenant/environment is
checked. Android manifest pins APK checksum, signing certificate and package, plus
`"activity": "com.rocento.preview.reactnative.MainActivity"`. Only operators can
set this manifest. Android's launch activity defaults to the existing Kotlin app
when omitted, preserving its current deployment.

For Android-only deployment, set `VITE_RN_ANDROID_PREVIEW_ENABLED=true` and
`VITE_IOS_PREVIEW_ENABLED=false`. Both Android choices show the same server controls.
After validating both OS workers, `VITE_RN_PREVIEW_ENABLED=true` enables both in the
local Builder. The selector sends `implementation=react-native` with the OS. Stop an
active session before switching. Without this flag, RN choices remain unavailable.

Local acceptance requires actual frames and revision acknowledgements on both
OSes, plus input and reconnect checks. A successful build alone is not acceptance.
The shared EC2 Android pilot is deployed at apps.rocento.com for Grocery production.
Live rendering, draft acknowledgement, shared capacity, visible input and
reconnection checks passed. Intermittent Android System UI startup stalls remain;
acceptance evidence and limitations are tracked in
[the EC2 acceptance report](../../../commerce-docs/mobile/history/react-native-android-ec2-preview-acceptance-2026-10-14.md).
iOS cloud hosting remains disabled.

## Local acceptance, 2026-10-13

Both signed Studio apps produced native frames and acknowledged draft updates.
The gateway acceptance exercised text/color edits, swipe/tap/typing requests,
two video connections per session, and explicit stop. The original draft was
restored. Captured native screenshots show the new text/color and `milk` entered
into the real search field on each OS. Evidence:
[acceptance results](../../../commerce-docs/platform/evidence/README.md#evidence-54c76a0fa72984c5) (`output/react-native-builder-preview-20261013/acceptance.json`),
[iOS text/color](../../../commerce-docs/platform/evidence/README.md#evidence-7c59c469d8e72e10) (`output/react-native-builder-preview-20261013/ios-edited.jpg`),
[iOS typing](../../../commerce-docs/platform/evidence/README.md#evidence-aa17f5612219a120) (`output/react-native-builder-preview-20261013/ios-input.jpg`),
[Android text/color](../../../commerce-docs/platform/evidence/README.md#evidence-9fd262919c8405d3) (`output/react-native-builder-preview-20261013/android-edited.jpg`),
[Android typing](../../../commerce-docs/platform/evidence/README.md#evidence-c801451125cb935f) (`output/react-native-builder-preview-20261013/android-input.jpg`).

These checks exercised the same authenticated gateway video/input endpoints used
by Builder. A new interactive browser UI acceptance was not performed in this
turn; browser automation access was previously blocked. No remote/cloud validation
was performed. Android retains the existing screenshot-based capture (up to 5 fps).

Validation passed: 152 React Native tests; seven gateway preview integration tests
(serial execution); 11 worker tests; 67 mobile tooling tests; architecture guard;
TypeScript checks and Builder production build. Both Studio and standalone native
apps build successfully, and standalone exported JS bundles contain no Studio
preview route. iOS signing checks passed for both builds; Android Studio APK
signature and checksum were verified before worker installation.


## All-section acceptance, 2026-10-14

The local Studio builds render all six section types using the shared React Native
screen. Native iOS and Android captures verified an uploaded private banner,
editorial text, spacing, category tiles, product grids and horizontal carousels.
Live text/color edits and reversing section order produced revision acknowledgements.
The acceptance draft was restored after testing. Product feeds remain live commerce
requests; a draft acknowledgement confirms presentation application, not completion
of every asynchronous commerce/image request.

The local fixture gateway now optionally accepts loopback S3 storage via
`S3_ENDPOINT`, `S3_ACCESS_KEY` and `S3_SECRET_KEY`. This enables authenticated image
upload and delivery in local acceptance without embedding storage credentials.

Validation: 160 React Native tests, TypeScript checks, 67 mobile tooling tests,
the architecture guard, Builder production build, signed Studio and standalone
iOS/Android builds, and standalone bundle inspection for excluded preview routes.
No new interactive browser acceptance or cloud simulator validation is claimed.

Evidence: [results](../../../commerce-docs/platform/evidence/README.md#evidence-fa18b5655013722f) (`output/react-native-builder-sections-20261014/acceptance.json`),
[iOS banner](../../../commerce-docs/platform/evidence/README.md#evidence-0d682718b454f338) (`output/react-native-builder-sections-20261014/ios-sections-top.jpg`),
[iOS products](../../../commerce-docs/platform/evidence/README.md#evidence-5c161d2ac75d5916) (`output/react-native-builder-sections-20261014/ios-sections-scroll-3.jpg`),
[Android banner](../../../commerce-docs/platform/evidence/README.md#evidence-557d2f47913976e5) (`output/react-native-builder-sections-20261014/android-sections-top.jpg`),
[Android collection](../../../commerce-docs/platform/evidence/README.md#evidence-65d8208e3a2ba335) (`output/react-native-builder-sections-20261014/android-sections-scroll-4.jpg`).
The final builds also acknowledged an unchanged revision after another polling
cycle. An isolated iOS worker slot needed restart recovery between runs; the
fresh worker subsequently passed the complete acceptance.

A follow-up Android run exposed an unreadable screenshot ending capture. The
worker now retries at most two unreadable frames and fails closed on the third,
without publishing invalid bytes or weakening frame-size/input checks. Regression
tests cover transient recovery and persistent failure. Category IDs are no longer
shown while category names load.

The final Android run passed after capture recovery was enabled: real frames,
swipes, live edits and revision acknowledgements. All 13 worker tests passed.
