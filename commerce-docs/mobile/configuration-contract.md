# Canonical mobile definition and tokens

## Authoritative inputs

- [Runtime schema](../../commerce-api/rocento-api/crates/domain-mobile/contract/v1/schema.json) and [merchant fixtures](../../commerce-api/rocento-api/crates/domain-mobile/contract/v1/fixtures).
- [Build-manifest schema](../../commerce-api/rocento-api/crates/domain-mobile/contract/v1/build-manifest.schema.json), separate from runtime configuration.
- [Contract guide](../../commerce-api/rocento-api/crates/domain-mobile/contract/README.md) and [OpenAPI](../../commerce-api/rocento-api/openapi.json).
- [Native model generator](../../commerce-mobile-apps/tools/generate_contract.py) and [browser validator generator](../../commerce-web/packages/api-client/scripts/generate-mobile-validator.mjs).

Use executable fixtures instead of maintaining another JSON example here. Generated copies are build inputs and compatibility artifacts, not competing hand-authored schemas. Native resources originate outside the editor.

## Existing contract

The definition uses `schemaVersion`, `configVersion`, `tenantId`, `brand`, `navigation`, `screens`, `features`, `localization` and `compatibility`. Registered sections are `heroBanner`, `productGrid`, `productCarousel`, `categoryGrid`, `richText` and `spacer`. Stable section IDs and typed, allowlisted actions preserve predictable rendering. Validation enforces bounds, supported properties, owned assets and runtime compatibility; configuration cannot introduce executable code.

Theme fields include `brand.light`, `brand.dark`, `fontToken`, `radiusToken` and `density`. Native presentation maps logical dimensions to platform units. Browser simulation currently selects `brand.light`. Native and browser adapters necessarily have platform-specific rendering; the executable schema defines the supported fields and values.

## Versions and isolation

- `schemaVersion` identifies the definition shape; existing v1 configurations remain supported.
- Minimum iOS/Android runtime versions identify capabilities; do not conflate these with schema version.
- Server draft revisions order edits and drive preview ACKs.
- `configVersion` identifies immutable publication; preview must not mutate it or its cache.
- Native snapshots validate tenant binding, compatibility and checksum before application. Failed updates retain the last valid state.

Schema evolution requires a versioned migration and cross-platform fixtures that preserve supported published configurations. Browser profile storage is separate from the app-definition contract.

## Verification

Run `python3 commerce-mobile-apps/tools/generate_contract.py --check`, the browser validator generator with `--check`, frontend/native contract tests and the boundary guard. Test unknown components, invalid properties, assets, runtime minimums, revision regression, checksum conflicts and draft/published isolation. Build commands live in [development guide](development.md); dated results belong in implementation history.

## Banner layouts (runtime 1.3)

Hero banners optionally accept `layout: portrait` (2:3 cards) or `horizontal`
(3:1 banners), `imageFit: cover|contain`, and up to seven
`additionalImageAssetIds`. The first image remains `imageAssetId`. Multiple images
form a swipeable carousel; they share the section's accessible description and
native destination. Each referenced asset must belong to the merchant. All new
fields require both minimum runtimes to be `1.3.0`; older clients must not receive
these configurations. Existing v1 banners without these fields retain their
original rendering. No persisted configuration migration is required: choosing a
new layout opts the draft into runtime 1.3.

In App Studio, select a hero banner and use **Banner layout**, **Image fitting**,
and **Add carousel image**. The component library's **Add grocery banner demos**
adds three tall produce, pantry, and greens cards and a wide breakfast banner with English and Arabic
copy. Artwork is uploaded into the selected merchant's asset library before its
IDs enter the draft; publication remains a separate action. Bundled Grocery also
contains both examples, including React Native standalone. Three-card tall carousels start on the middle card with both neighbors peeking into view. The demo PNGs are 640×960 and 1080×360,
with byte sizes and checksums in `commerce-web/apps/mobile-studio/public/demo-banners/manifest.json`.
