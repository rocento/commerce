# Web storefront and mobile parity

Owner: mobile maintainers. Status: active implementation and acceptance tracker. Reviewed: 2026-10-14; original source baseline: 2026-10-13. This is an implementation
tracker, not a claim that a deployed build has passed acceptance. Web is the
functional reference; native navigation and controls may differ.

## Status and completion rules

- Present: a source implementation exists; parity acceptance is still required.
- Partial: only part of the web journey is implemented.
- Gap: no matching mobile implementation was found in the reviewed source.
- Verify: deeper contract/behavior inspection is needed before estimating work.
- Implemented: added during this effort; verification evidence is recorded below.

A row closes only after all applicable platforms pass its shared scenarios,
including English/Arabic, error recovery, session isolation and accessibility.
Fixtures must never fall back to production or create live orders.

## Feature inventory

| ID | Web reference / shopper capability | Swift | Kotlin | React Native | Acceptance requirement |
| --- | --- | --- | --- | --- | --- |
| P01 | `catalog.tsx`, `search.tsx`: categories, search, filters, sorting, paging | Present | Present | Partial | React Native lacks dynamic attribute facets and attribute sorting; compare matching products and errors |
| P02 | `product-types.tsx`: product details and variant choice | Present | Present | Present | Variant price/availability and required options match |
| P03 | `product-relationships.tsx`: related products | Implemented | Implemented | Implemented | Related, upsell and cross-sell sections with customer/delivery-aware results; device acceptance pending |
| P04 | `community.tsx`: wishlist and save for later | Present | Present | Present | Paging, removal, unavailable products, account reset |
| P05 | `cart.tsx`, `checkout.tsx`: coupon entry/removal | Present | Present | Implemented | Server validation, discount display, quote invalidation, locked checkout; native acceptance pending |
| P06 | `cart.tsx`: cart lines, stock, reservations and totals | Present | Present | Present | Verify full cart pagination, quantity limits, stock changes and discount breakdowns |
| P07 | `checkout.tsx`: gift message | Implemented | Implemented | Implemented | UTF-8 limit, quote payload/review, edited quote invalidation, pending restore; device acceptance pending |
| P08 | `locations.tsx`: saved addresses and coverage | Partial | Partial | Partial | Mobile create/select exists; add web address editing, label/default choice and complete address fields |
| P09 | `delivery-slots.tsx`, `checkout.tsx`: pickup, ASAP, scheduling | Present | Present | Present | Multi-source slots, expired availability and delivery changes |
| P10 | `checkout.tsx`: quote, consent, place, interrupted recovery | Present | Present | Present | Current server total; explicit confirmation; stable retry key across restart |
| P11 | Account routes: registration, verification, reset, session restoration | Present | Present | Present | Expiry/revocation, account switches, signed upgrade credential continuity |
| P12 | Order routes: history, pagination, details, status refresh | Partial | Partial | Partial | Added historical items, gift message and subtotal/discount/delivery/tax; shipment, payment/refund, address and full fulfillment rendering remain |
| P13 | `assistant-reorder.tsx`: reorder | Implemented | Implemented | Implemented | Keep/replace reviewed cart, confirm address, current proposal, replacements, safe retry; signed device acceptance pending |
| P14 | `comparison.tsx`: dedicated comparison selection and screen | Implemented | Implemented | Implemented | Up to five products, fresh facts, missing values, unconverted currencies, assistant draft handoff; device acceptance pending |
| P15 | `community.tsx`: product reviews | Implemented | Implemented | Implemented | Public paging, own review, verified submission/edit, moderation status, unknown-outcome readback; device acceptance pending |
| P16 | `support.tsx`: ticket creation, list, detail, reply | Implemented | Implemented | Implemented | Guest/customer intake, list/detail/status, linked orders, session drafts and same-request retries; device acceptance pending |
| P17 | `assistant.tsx`: streaming, product actions, basket proposals | Present | Present | Present | Added authenticated ticket-detail handoff; audit other blocks/actions and interruption behavior against web |
| P18 | `assistant.tsx`: saved conversation history | Implemented | Implemented | Implemented | Recent conversation search/list, structured reopening, new chat and unavailable recovery; API returns at most 100 turns without paging; device acceptance pending |
| P19 | `assistant-memory.tsx`: consent, preferences, goals, export/delete | Partial | Partial | Partial | Consent, scoped preferences, signals, context removal, JSON export/delete and customer saved-goal controls implemented; guest-cart saved goals and native acceptance remain |
| P20 | `content.tsx`: published information and policy pages | Gap | Gap | Gap | Supported content blocks, localization, links, unavailable pages |
| P21 | `theme-sections.tsx`: configured home and merchandising | Present | Present | Partial | All six RN home sections and private banners are implemented; verify remaining navigation, dark-theme, actions, feature flags and fallback behavior |
| P22 | `storefront-notifications.tsx`: server notification inbox | Partial | Partial | Partial | Announcements plus customer events, paging, unread/read-all, account/guest isolation |
| P23 | Order push and notification navigation | Partial | Partial | Gap | Signed physical-device delivery, token rotation, denial, logout, authenticated destination |
| P24 | Language, RTL, appearance and accessibility | Partial | Partial | Partial | Audit every new/existing flow; large text, focus, labels, no overflow |
| P25 | Product/order/ticket/content links | Verify | Verify | Verify | Cold/warm app entry, sign-in return, invalid/foreign identifiers |
| P26 | Browser SEO and indexable URLs | N/A | N/A | N/A | Web-only; mobile uses appropriate deep links, not HTML indexing |

Source references above are relative to `commerce-web/apps/storefront/src`.
Mobile sources: `commerce-mobile-apps/ios/Storefront` and `RocentoCore`,
`commerce-mobile-apps/android/app/src/main` and `core`, and `commerce-mobile-apps/react-native/src`.

## Delivery checklist

- [x] Create source-based baseline and distinguish implementation from acceptance.
- [ ] Resolve every Verify entry and audit API response fields and feature flags.
- [x] P05: implement React Native coupons and exercise quote invalidation/locking with isolated tests.
- [x] P07: implement gift-message entry, quote contract and interrupted recovery on all three platforms.
- [ ] P05/P07: signed device UI acceptance before marking release parity complete.
- [x] P13: implement reorder as a reviewed basket proposal on all three platforms.
- [x] P03: related/upsell product sections and cart cross-sells on all three platforms.
- [ ] P03/P13: signed device UI and upgrade/restoration acceptance.
- [x] P14-P15: comparison and customer reviews on all three platforms.
- [ ] P14-P15: signed-device, large-text and accessibility acceptance.
- [x] P16: implement support ticket lifecycle on all three platforms.
- [ ] P16: signed-device, accessibility and interrupted-session acceptance; durable support drafts/retries remain outside this increment.
- [x] P18: saved assistant conversation search, structured reopening and new conversation on all three platforms.
- [x] P19: consent, preferences, signals, context removal, export/delete and authenticated saved-goal lifecycle on all three platforms.
- [ ] P19: guest-cart saved-goal ownership and full context-summary presentation parity.
- [ ] P18-P19: signed-device, screen-reader, large-text, native sharing and cross-client live acceptance.
- [ ] P03/P07/P08/P12/P17: close detail-level gaps found in the contract audit.
- [ ] P20-P21: published content and configurable merchandising parity.
- [ ] P22-P23/P25: server inbox, push and destination handling.
- [ ] P24: cross-platform localization/accessibility regression acceptance.
- [ ] Signed release/upgrade verification and physical-device acceptance.

## Architecture and dependencies

Extend existing core stores and commerce clients; screens own presentation and
navigation. Keep the operation queue, customer-generation checks, checkout lock,
and persisted idempotency contracts. Native apps remain standalone by default;
App Studio stays optional. Use the existing commerce APIs and backend validation.
Do not invoke assistant-tool order placement as a substitute for reviewed reorder.

Reorder depends on basket proposal/context contracts, complete cart snapshots,
saved-address validation and recoverable proposal application. Support and memory
require confirming the same access and consent rules used by web. Push activation
depends on provider credentials, signing and real-device delivery evidence.

## Verification log

See the [2026-10-13 implementation record](../history/storefront-parity-2026-10-13.md) for completed increments and their acceptance limits.
