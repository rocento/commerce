# Storefront customer flows

The customer UI composes catalog browsing, product details, search, cart, checkout, account/order history, saved locations, support, content/community screens and the assistant. The gateway remains authoritative for identity, availability, price, tax, shipping and successful order placement.

Search and category collections use the shared client. Product cards preserve product identity, source availability and effective published prices. Comparison is browser-owned selection with grounded catalog details; clearing it changes that selection. Bestsellers use their dedicated server period/ranking data rather than inferred popularity.

Catalog and theme images use advertised responsive WebP candidates, including compressed original-width candidates for high-density displays. Media without a prepared manifest keeps its original URL. The early theme hero preload, interactive image and public renderer share candidate selection. A stored guest delivery draft skips the anonymous warmup, preventing an unused hero download before the delivery context resolves. Reproduce the Electronics byte comparison locally with `cargo run -p api-gateway --example electronics-image-budget` from `commerce-api/rocento-api`, then run `node e2e/electronics-performance-fixture.mjs` and `node e2e/electronics-performance-check.mjs` from `commerce-web`. The fixtures use approved demo artwork and local responses; they do not measure live PageSpeed scores.

Cart displays and quantity controls must reconcile server responses. Checkout reviews a current quote and preserves the order idempotency key during transport retries. Cart or delivery changes, expired reservations and changed market facts require fresh review. A displayed success message is not an authoritative order receipt.

## Storefront translations

Saved English and Arabic interface phrases are served anonymously by `/v1/languages/interface`. The shopping app and published documents use the same validated catalog, including account, personal details, wishlist, orders, support and validation. Open pages refresh saved phrases within five seconds and on navigation or focus. Published HTML embeds the current phrases for hydration; network failures retain the last validated bundle or built-in copy. Overrides for an obsolete source or incompatible placeholders fall back to the current source phrase.

Product, category and attribute translations use the selected locale and must be current and marked reviewed. Navigation translations belong to the published menu release. Customer-entered text and historical order facts retain their original values. Admin previews remain paired to the authorized parent and prevent order placement.

## Delivery and fulfillment

Customers can select a saved address or map pin. Country changes clear region, place and coordinates; region changes clear place and coordinates. Street/building details remain editable. The bundled locality directory is a picker aid, not delivery authorization. Merchant polygons, source stock and fulfillment policies determine eligibility.

When scheduled selection is enabled, eligible windows can be explicitly held, with the UI displaying hold expiry. Automatic mode allocates during review. Customer APIs omit admin capacity counters. Pickup uses a selected eligible branch and existing store capabilities. Destination, cart, source or inventory changes must be revalidated by checkout. [Backend fulfillment](../backend/fulfillment.md) describes the reservation contract.

## Assistant

The `/assistant` UI renders validated streamed blocks, safe prose, product and order cards, support flows, progress, stop/retry, history and feedback. Focused modules own delivery, comparison, reorder, product selection and cart presentation.

An admitted `open_checkout` event opens existing checkout after stream completion. History or prose must never trigger that action. Explicit product selections retain IDs; uncertain names require selection rather than guessed mutation. Stream `done` is transport completion; successful commerce work needs an appropriate receipt.

See [AI service capabilities](../ai-service/language-and-capabilities.md) for interpretation, delegation and compound limits. Browser presentation does not widen those limits.
