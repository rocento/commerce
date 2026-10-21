# Native runtime and build preparation — 2026-10-12

Historical record migrated from the source README. Use [mobile status](../README.md), [commerce](../commerce.md) and [device signing](../device-signing.md) for current guidance. Dated results do not establish current deployment or signed physical-device acceptance.

## Runtime 1.1 — deployed and verified

Tab icon controls are implemented in App Studio, the gateway contract, SwiftUI and
Compose. Each tab can select home, categories, cart, account, wishlist or location;
its destination and accessible label stay unchanged. Icon overrides require native
runtime 1.1.0. The gateway and Studio rollout is complete, and both installed native
apps use 1.1.0 build 2. Temporary v4 proved an actual Home → location icon change
on both platforms; final v5 restored the saved design without verification content.

A fresh 2026-10-12 check passed on the iOS simulator and Android emulator. Both
complete configuration caches match published v5; the current deployed Studio
bundle still includes the icon controls and minimum-runtime guard. See the
[deployment and verification record](commerce-2026-10-12.md#runtime-11-deployment-and-live-design-reflection--2026-10-12).
Signed physical-device testing and store distribution remain pending.

## Real-device build preparation — 2026-10-12

Rocento 1.1.0 build 3 has an unsigned physical-device iOS Release archive and
an unsigned Android Release APK; Android release lint passed. Signing helpers
are prepared, and the Android helper passed a disposable-key signing/verification
check. No merchant-signed IPA or APK has been produced. Apple Team ID, installed
certificate/private key and device provisioning profile, plus the Android
keystore/alias and privately supplied passwords, are required next. See the
[signing preparation guide](../device-signing.md) for exact inputs, commands and acceptance steps.
Firebase/APNs remain deferred; real-device acceptance and remote CI remain open.

## Native shopping assistant — 2026-10-12

Production merchant apps now include a native shopping assistant backed by the existing
`POST /v1/assistant/chat` API. SwiftUI and Compose render streamed text, product cards,
comparison rows, clarification choices, guided product selection, cart summaries and
reviewed basket proposals. Product cards open the existing native product screen or
add an available simple product after rechecking the catalog. Checkout commands open
the existing reviewed native checkout; they never place an order.

The assistant shares the installation-bound commerce client, customer bearer and
selected delivery context. Guest product discovery works without a customer token.
Session changes clear the in-memory conversation. Closing/stopping cancels the stream;
interrupted turns retain their partial content and prompt the shopper to check their
bag. Partially received requests are never automatically replayed. Conversations are
currently kept in memory for the app session; native history browsing and background
stream continuation are not implemented.

The shared fixture `shared/testing/assistant-stream.json` is checked against the
existing gateway OpenAPI contract by `scripts.tests.test_native_assistant_contract`.
Core tests cover split UTF-8/CRLF, response IDs and ordering, invalid products, body
limits, customer/guest headers, delivery context, authentication refresh, interruption,
session changes, bounded product follow-ups and checkout gating. Android additionally
exercises partial network delivery and cancellation of a stalled socket.

Focused commands:

```sh
python3 -m unittest scripts.tests.test_native_assistant_contract
swift test --package-path mobile/ios/RocentoCore --filter AssistantTests
mobile/android/gradlew -p mobile/android :core:testDebugUnitTest --tests com.rocento.mobile.AssistantTests
```

Isolated UI scenarios are in `StorefrontUITests` (methods starting with
`testAssistant` and `testArabicAssistant`) and Android `CompleteStorefrontFlowTests`
(`assistantProductCartAndCheckout`, `arabicAssistantProductCartAndCheckout`,
`interruptedAssistantNeverOpensCheckout`, `assistantStopAndSessionReset`). The fixtures
have no production network fallback. UI execution and installation are coordinated
with the combined runtime 1.2 release; successful compilation alone is not UI acceptance.


## Commerce checkpoint

The **Rocento** iOS scheme and **rocento** Android flavor connect to production Rocento Grocery. Customer accounts, cart, delivery, reviewed checkout and manual order tracking are implemented locally. Owner-approved internal enrollment and private brand-asset delivery are deployed (2026-10-12), with production dashboard/API enrollment verified for both platform identities. Production design **v5** is published; the v3 catalog acceptance below is retained as historical evidence. Its featured grid uses the live `grocery-fruit` category; both platform APIs and the Swift/Kotlin configuration and commerce clients verified 15 grocery products, product images and cache restart in English/Arabic. Published v3 is also visually verified on the iPhone 17 Pro simulator and API 36 Android emulator, including RTL and restart. Arabic product names now refresh from the production catalog when the language changes; the fix is verified on both simulators. Authentication and complete shopping flows pass isolated English/Arabic simulator acceptance, with 14 UI cases per platform. Order statuses and dates now localize in English/Arabic; focused language-switch/checkout/tracking checks pass on both devices, and the expanded core/unit suites pass 25 cases per platform. Live Android catalog/variant/coverage reads also pass. Production verification-email receipt, verified account display, login/sign-out and session restoration now pass. A production-data customer identity mismatch was fixed on both platforms; production password reset, old-password rejection and prior-session revocation pass on both platforms; new-password session restoration now passes on both platforms. On 2026-10-12, the owner signed in on the active Android emulator and the verified English/Arabic account survived two explicit force-stop/relaunch cycles. The Android suite now passes 29 unit tests, with separate Keystore process-restart and rotation checks. Firebase/push is explicitly deferred; signed real-device acceptance remains pending; see the [Milestone 4 guide](../commerce.md).

Milestone 2 contains one SwiftUI engine and one Compose engine, each building Demo Market and Demo Boutique from the canonical backend contract. Market and Boutique are local previews with bundled catalogs and illustrative artwork. They do not enroll a device or perform checkout.

See the [native implementation and validation guide](native-milestones-2026-10-11.md) for commands, architecture, test evidence and remaining production work. The [roadmap](../plans/native-preview-and-release.md) tracks subsequent milestones.
