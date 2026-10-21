# Mobile performance and regression checks

## Implemented safeguards

- Swift and Kotlin reuse HTTP connection pools. Authenticated commerce and
  builder responses remain uncached; public product images have a separate
  64 MiB disk cache. Identical concurrent image requests share one transfer;
  cancellation closes that transfer only when its last reader leaves.
- Native thumbnail decoding runs away from the UI thread. Each app limits its
  decoded image cache to 32 MiB, with a five-minute lifetime and full URL/size
  keys. Image responses remain capped at 5 MiB. The existing width fallback
  preserves the merchant origin and other query parameters.
- Native home catalog requests overlap, with at most four reads in flight.
  Sections publish as their data arrives. Locale changes and cancelled requests
  cannot publish old data. Kotlin public reads release the client lock before
  network I/O; account, refresh, and checkout operations retain their ordering.
- Compose grids put individual product rows in the parent `LazyColumn`.
  React Native catalog, deals, wishlist, assistant history, and configured home
  sections use windowed lists. Catalog cards have stable keys and memoized
  presentation. Lists keep variable heights for Arabic and accessibility text.
- React Native consumes every assistant event but batches text publication at
  32 ms intervals. Completion, structured content, interruption, and reset flush
  or discard pending updates appropriately. The storefront subscribes only to
  the assistant's busy state. Currency formatters are reused with a bounded cache.
- Android release builds enable R8 optimization and resource shrinking, using
  library consumer rules rather than broad keep rules.
- Swift retry payloads use deterministic JSON encoding, and assistant retries
  reuse the original encoded body. This fixes the three byte-equality failures
  without relaxing their assertions or replaying interrupted streams.

## Repeatable checks

Run the [required platform checks](../commerce-docs/mobile/development.md#standalone-apps-and-optional-app-studio)
and the signing gates before native UI tests. `PerformanceTests` in each native
core package cover bounded overlapping reads, stale-locale rejection, shared
image requests, cancellation, and fallback URL isolation. The Android suite
also exercises the real commerce client to catch accidental serialization.

From `commerce-mobile-apps/react-native`:

```sh
npm run typecheck
npm test
npm run bundle
npm run test:live-ui
npm run test:checkout-ui
npm run test:discovery-ui
npm run test:ui
```

Run the browser suites sequentially, or pass distinct Playwright `--output`
directories: the default suites share an artifact folder. The large catalog
regression supplies 240 products, checks fewer than 60 mounted cards, scrolls
to the last item, and verifies that its product action still works. Streaming
tests check complete text delivery, bounded notifications, interruption, and
account-reset isolation.

`StorefrontUITests.testIsolatedLaunchPerformance` records three launch iterations
using XCTest's application launch metric and isolated commerce data. Keep the
`.xcresult` to compare runs on the same hardware and build configuration.

## Measuring device speed

Functional tests, compile checks, and emulator measurements do not establish
physical-device frame rate or battery use. Before release, compare optimized
builds on the same representative iPhone and lower-end Android device, with a
fixed catalog, locale, network, and cold/warm cache state. Record launch-to-first-
frame and catalog-ready separately, frame duration/jank during scrolling,
peak memory, and duplicate image request counts. Include Arabic, large text,
pagination, long assistant conversations, and interrupted-network recovery.

Use Instruments for Swift, Android Macrobenchmark/Perfetto for Kotlin, and a
release Hermes build for React Native. Measure before setting device-specific
regression budgets. Generate app-specific Android Baseline Profiles from those
critical journeys and compare them on physical hardware before claiming a
startup improvement; library profiles alone are not app-specific coverage.

References: [React Native list virtualization](https://reactnative.dev/docs/flatlist),
[Android release optimization](https://developer.android.com/topic/performance/app-optimization/enable-app-optimization),
[Android Baseline Profiles](https://developer.android.com/topic/performance/baselineprofiles/create-baselineprofile),
[XCTest launch metrics](https://developer.apple.com/documentation/xctest/xctapplicationlaunchmetric).
