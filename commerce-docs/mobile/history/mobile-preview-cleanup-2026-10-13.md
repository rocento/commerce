# Preview cleanup audit — 2026-10-13

Historical checkpoint. Later records may supersede these deployment statements; see the [mobile status](../../frontend/README.md) and [history index](README.md).

## Scope and outcome

Audited the Studio entry point/import graph, browser previews and checkout, canonical contract/generation, gateway preview registrations, native package/manifests/composition, React Native entry/Metro configuration, mobile CI, native tooling and preview tests. The workspace already contained extensive uncommitted/untracked work. Changes here are limited to verified dead browser implementation, its exclusive styling, preview regression assertions and consolidated specifications. No deployment, infrastructure provisioning, database operation, publication, signing-identity change or customer-data deletion was performed.

The before state had one active browser renderer plus an unreachable older checkout/cart renderer and state machine, alongside proposal documents describing another schema/package/transport design as if it were implemented. The after state keeps the active renderer and configuration-delivery boundaries, deletes the unreachable implementation, and documents one supported architecture with explicitly separate future work.

This is source-level evidence, not an inventory of every deployed customer binary. No public API, published schema, native adapter, production renderer or stored configuration was removed. Those would require additional downstream compatibility evidence.

## Exact implementation removals

| File | Removal and evidence | Preserved replacement/behavior |
| --- | --- | --- |
| `frontend/apps/mobile-admin/src/mobile-preview-checkout.tsx` | Deleted file: unused `usePreviewCheckout`, `PreviewCheckout`, private step/scenario state and synthetic confirmation flow. Repository-wide symbol/import searches found no executable consumer; only a type-only `Address` import remained. No dynamic/glob registration or build/template reference selects it. | `mobile-preview.tsx` directly imports `useNativePreviewCheckout`, `NativeCartCheckout` and `NativeCheckoutControls` for all four targets. Move the unchanged `Address` shape to its sole consumer, `mobile-preview-profile.tsx`. |
| `frontend/apps/mobile-admin/src/mobile-preview-cart.tsx` | Deleted the exported but unreferenced `PreviewCart` renderer. | Retained `CartLine`, `lineTotal`, `usePreviewCart` and all active cart mutation behavior. Current cart UI is in `mobile-native-checkout.tsx`. |
| `frontend/apps/mobile-admin/src/style.css` | Deleted exclusive `.ms-checkout` heading/paragraph rules, `.ms-checkout-steps`, `-options`, `-address`, `-success`, `-reference`, `-testing`, `-failure` rules and `.ms-cart-line`, `-controls`, `-quantity`, `-remove`, `-total` selectors. Split grouped rules to keep live selectors. | Retained shared checkout forms, summary/items/totals, wishlist product styling, cart buttons, added-to-cart and failure actions. Searches of remaining JSX verified these consumers. |
| `frontend/apps/mobile-admin/src/mobile-preview-native.css` | Deleted obsolete cart-line/quantity rules and cart-controls/remove branches of grouped selectors. | Retained live product text, cart-clear, back and added-to-cart styling. |

No dependency, package, public route, native file, generated model, fixture, runtime registration or synchronization transport was deleted. Existing four target identifiers and browser storage keys/formats remain unchanged; there is no configuration or data migration.

## Regression changes

`mobile-preview-contract.test.tsx` previously failed before cleanup because it expected the removed `ms-native-header-brand` element. Both current SwiftUI and Compose storefronts expose delivery controls in their header. The test now checks two delivery selectors, search inputs and assistant controls, retaining its other negative assertions. An additional test verifies all four target labels remain simulations and local edits never fabricate native acknowledgement. No legitimate test was skipped, weakened or deleted to hide a failure.

The existing browser suite exercises the replacement cart/checkout, simulated writes, rejected orders, delivery/stock recovery, saved addresses, merchant changes, promotion totals, history and RTL. Those behavior tests remain intact.

## Intentionally retained

- `MobilePreview` and its active account/search/profile/preferences/support/information/assistant/product/checkout components: Studio still needs browser authoring and simulated shopping. Native sync does not replace these capabilities.
- `mobile-native-checkout-model.ts` and `mobile-native-checkout.tsx`: active browser simulation despite “native” names; not native production dependencies.
- `RocentoAppBuilder`, Android `app-builder`, enrollment, secure configuration caches and asset delivery: optional native adapters, independent of editor implementation.
- `DraftPreviewRuntime`, HTTP transport, memory-only draft provider and `NativePreviewSession`: the iOS snapshot/apply/ACK path and separate status observation. Four-second snapshot polling and three-second status polling have different responsibilities, not competing revision authority.
- Catalog refresh/retry, published refresh, checkout quote timers and native observation counters: data retry, publication delivery, quote expiry and UI observation respectively; none is an obsolete draft synchronization loop.
- Market/Boutique native demo identities, `preview_icon.xml`, generated resources and test fixtures: referenced by build manifests, generators and native acceptance.
- RN `Storefront`, `Acceptance` and `VisualPreview`: live/demo and explicitly selected development QA paths, referenced from `App.tsx`, package scripts and CI. RN has no equivalent draft-session consumer to replace/remove.
- Gateway preview session/catalog APIs, migrations and security tests: active clients and persistent session authorization depend on them.
- `backend/crates/api-gateway/src/mobile/preview_worker.rs`, `deploy/native-preview` and related UI/API changes: concurrent implementation observed during this audit. Preserved; not authored or certified as production-ready by this cleanup.

## Documentation consolidation

The eight existing top-level files (`README.md`, `01-architecture.md` through `07-roadmap-codex.md`) now describe current responsibilities and remaining acceptance gates. External links to the original numbered top-level files, including `01-architecture.md#architectural-decisions`, are preserved.

Removed the following superseded files after merging useful content:

| Removed path under `rocento-mobile-specs/` | Destination |
| --- | --- |
| `rocento-live-preview-docs/README.md` | Top-level `README.md` |
| `rocento-live-preview-docs/00-implementation-audit.md` | Current architecture, this decision record, and historical evidence in `08-native-preview.md` |
| `rocento-live-preview-docs/01-architecture.md` | `01-architecture.md` |
| `rocento-live-preview-docs/02-schema-and-tokens.md` | `03-config-contract.md` and future token work in `07-roadmap-codex.md` |
| `rocento-live-preview-docs/03-native-runtime.md` | `05-native-apps.md` and parity acceptance in `07-roadmap-codex.md` |
| `rocento-live-preview-docs/04-sync-and-security.md` | `04-api-and-data.md`, `08-native-preview.md` and future transport gates in `07-roadmap-codex.md` |
| `rocento-live-preview-docs/05-roadmap-and-tests.md` | `07-roadmap-codex.md` |
| `rocento-live-preview-docs/06-local-native-sync.md` | Moved to `08-native-preview.md`; evidence links adjusted, historical checkpoint labeled |
| `rocento-live-preview-architecture.zip` | Removed duplicate six-document proposal distribution; useful requirements retained in the maintained Markdown set |

Removed misleading illustrative schema/patch JSON, speculative package inventories and already-completed greenfield tickets from current guidance. Required future token semantics, revision mismatch recovery, component diagnostics, streaming isolation, metrics and release gates remain in the roadmap. Canonical schema/fixture links replace copied JSON examples. Detailed deployment/signing history remains in the existing implementation guides rather than repeated stale summaries.

## Validation executed

Logs from this run are in `/tmp/rocento-cleanup/`. Results describe this workspace, not remote CI or production verification.

| Check | Result |
| --- | --- |
| TypeScript checks via each package's `npm run typecheck` | PASS: storefront, website, admin, mobile-admin, UI and API client |
| Frontend `vitest run` | Initial sandbox run: 3,417 passed, 16 failed because loopback `listen` was denied. The single affected `identity-session.integration.test.ts` file passed all 16 on an authorized rerun. All 3,433 cases passed across these runs. |
| Focused Studio Vitest | PASS: 31 tests in four files |
| Studio Playwright | PASS: 93 tests; production Vite build and generated-validator check also passed. Temporary config used port 15194 because 5194 was occupied; no existing server was stopped. |
| Mobile tooling `unittest discover -s mobile/tools/tests -v` | PASS: all 65 tests, including editor-boundary and signing regressions |
| `generate_contract.py --check` | PASS: 27 generated contract/resource files |
| `check_boundaries.py` | PASS: source/editor boundary and generated Xcode wiring |
| Swift core / builder `swift test` | PASS: 113 core + 17 adapter tests, including revision/checksum and draft/published isolation |
| iOS Rocento / RocentoStudio `xcodebuild ... CODE_SIGNING_ALLOWED=NO build` | PASS: both simulator schemes, compile-only; nothing installed |
| Standalone iOS artifact boundary | PASS: built Rocento.app excludes builder implementation |
| Android core tests | FAIL compiling existing `CommerceTests.kt:32–33`: assistant constructor/API mismatch, unresolved `restoreConversation`, `conversationID`, `state`, `question`, `reply`. No test execution success claimed; cached earlier XML results are not this run. |
| Android builder tests and Studio assembly | PASS: 12 adapter tests and `-PappBuilder=true :app:assembleRocentoDebug` |
| Android standalone assembly | PASS: separate `:app:assembleRocentoDebug` invocation |
| React Native | PASS: typecheck, 146 tests, Expo iOS/Android bundle export. No signed native RN build/device UI test performed. |
| Python mobile contract / ingress / native assistant checks | 11 total: five passed, one failed (`test_mobile_security_is_explicit`: missing required `environment` assertion), five Docker-dependent ingress cases skipped by their existing opt-in guard. Test was not weakened. Temporary OpenAPI dependencies resolved the initial missing-module error. |
| Concurrent preview worker unit tests | PASS: three tests; not hosted/native streaming acceptance |

Native tests initially encountered sandbox cache restrictions and were rerun with approved cache access. Android initially used incompatible Java 25; the recorded results use Android Studio's bundled Java 21. No global Java setting was changed.

## Remaining debt and readiness

The local iOS full-snapshot protocol is implemented and its core/adapter checks pass. The earlier signed simulator edit/outage/recovery acceptance is preserved in the [runbook](../native-preview.md); it was not rerun here. This audit did not create a disposable database, rerun backend database security tests or verify installed customer-login continuity.

Android/RN draft delivery, complete token/component parity, arbitrary token references, optional patch transport, physical-device acceptance and observed-frame revision guarantees remain separate work. Current browser simulation uses the light palette. Platform-native renderers must not be deleted to simulate consolidation into a nonexistent universal package.

Concurrent worker/frame code needs its own endpoint, tenant isolation, signing, expiry, resource cleanup and end-to-end acceptance. No cloud provisioning or deployed streaming readiness is claimed. Resolve the Android test API mismatch and Python OpenAPI security assertion before treating the overall repository as green. Preserve existing contracts while adding any future migration.
