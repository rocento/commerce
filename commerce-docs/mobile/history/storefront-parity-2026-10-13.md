# Storefront parity implementation — 2026-10-13

Historical implementation and local verification evidence. Track remaining work in the [parity plan](../plans/storefront-parity.md); this record does not establish signed-device or production acceptance.


## First implementation increment - 2026-10-13

P05 adds React Native coupon apply/remove controls in cart and checkout, server
coupon errors and discount amounts. Mutations run through CartStore and the
operation queue, invalidate reviewed quotes, reject unresolved checkout edits and
discard responses after customer reset. Existing Swift/Kotlin coupon APIs and UI
were retained.

P07 adds optional gift messages to Swift, Kotlin and React Native. CheckoutFlow
owns the draft, preserves it across delivery/cart review invalidation, blocks edits
while quoting/submitting/uncertain, enforces the web's 500 UTF-8-byte limit and
clears it on customer reset or successful completion. Clients send gift_message
with the quote request; review screens show the server snapshot. Pending checkout
restoration includes the saved message. The optional snapshot field remains
compatible with older saved attempts; credential keys/signing identities did not
change.

Verification completed with isolated fixtures; no production purchase or install:

| Check | Result |
| --- | --- |
| Swift `swift test --package-path mobile/ios/RocentoCore` | 85 tests passed |
| Kotlin `:core:testDebugUnitTest` | 89 tests passed |
| React Native `npm run typecheck` and `npm test` | Passed; 86 tests |
| React Native `npm run test:checkout-ui` | 4 English/Arabic flows passed, including coupons, gift validation, quote editing and confirmation |
| React Native `npm run bundle` | iOS and Android Hermes exports passed |
| Swift Rocento and RocentoStudio simulator builds | Both compiled; unsigned compile-only artifacts, not installed |
| Android standalone and `-PappBuilder=true` | Both assembled; instrumented tests compiled |
| Android `:app:lintRocentoDebug` | Passed |
| Mobile tooling unit tests | 61 tests passed |
| Mobile boundary guard | Passed |

React Native screenshots were inspected at 390x844 in English and Arabic; coupon
controls fit and RTL alignment is correct. Screenshots are under
`mobile/react-native/test-results/coupon-form-{en,ar}.png`. Test logs for this run
are `/tmp/rocento-parity-{swift-tests,android,android-studio,ios,ios-studio,rn-ui,rn-bundle}.log`.
These are local verification artifacts and may be regenerated or removed.

Still open: native UI execution for the new gift screens, signed physical-device
acceptance, release distribution and all unchecked feature rows above. Native
compilation and React Native browser fixtures do not establish device acceptance.
## Reorder and relationships increment - 2026-10-13

P13 now uses the existing shopping-context, basket-proposal and trust-confirmation
APIs on all three platforms. Customers explicitly keep or replace the reviewed
cart, confirm a saved address, change quantities/remove lines/select replacement
products, and approve current server totals. Approval updates the cart only;
placing an order remains a separate checkout confirmation. Cart and address
changes invalidate preparation. Partial cart clearing reloads remaining items
without replaying deletes. Unresolved checkout blocks reorder writes.

A merchant-scoped `reorder-task` record stores customer/order task IDs and pending
application state before mutations. Restart resumes the same server task and
proposal. An already-applied proposal is recovered without reapplying. Corrupt or
unreadable storage fails closed; native existing credential keys are unchanged.
Swift uses checked Keychain reads and update-before-add writes for this new
purpose; Android uses checked decryption and the existing atomic persistence.

P03 adds related and upsell links on product details and cross-sell links in cart.
The same relationship endpoint as web receives source IDs, relationship kind,
language, current delivery coordinates and customer authorization when signed in.
Empty sections stay hidden; failed requests offer retry. Context changes discard
old recommendations and links open the normal product/variant purchase journey.

Verification completed using isolated fixtures; no live orders or app installs:

| Check | Result |
| --- | --- |
| Swift core tests | 99 passed, including lost reorder response/recovery, persistence and relationship request context |
| Swift optional adapter tests | 13 passed |
| Kotlin core tests | Passed, including reorder recovery/persistence and relationship request context |
| React Native typecheck and unit tests | Passed; 106 tests |
| React Native checkout UI fixtures | 8 English/Arabic journeys passed: reorder, related/cross-sell navigation, coupons and checkout |
| React Native Hermes exports | iOS and Android passed |
| Swift standalone and Studio | Both compiled for arm64 simulator; unsigned compile-only, not installed |
| Android standalone and Studio | Both assembled; instrumented test sources compiled; optional adapter tests passed |
| Android standalone lint | Passed |
| Mobile tooling tests / boundary guard | 61 passed / passed |

Reorder screenshots were inspected at 390x844 in English and Arabic. The browser
tests also cover product-link navigation and relationship headings in both
languages. Logs are `/tmp/rocento-reorder-{swift,swift-builder,android,android-studio,ios,ios-studio,rn-tests,rn-ui,rn-bundle,tooling,boundaries}.log`.
Temporary build/test artifacts may be regenerated or cleaned. Native UI execution,
large-text/accessibility acceptance and signed restart/upgrade recovery remain
open; compiling is not evidence of physical-device credential continuity.

## Comparison, reviews and order contents increment - 2026-10-13

P14 now provides session-scoped selection of up to five products, current facts,
missing-product recovery, dynamic attributes, explicit configurable-product
pricing, unconverted currencies and an assistant draft handoff on all platforms.
Selection resets on account changes; process-restart persistence is not included.

P15 adds public review paging, own-review readback, verified submission/editing,
UTF-8 validation and moderation status. Drafts survive read failures. Unknown
submission outcomes require explicit refresh before another edit or submission;
no write is automatically replayed. A successful save remains successful when
refreshing the public list fails. Refresh is explicit rather than web polling.

P12 additionally renders historical order lines, gift messages and cost
breakdowns without repricing from current catalog data. It remains partial.

Verification used isolated fixtures, with no live submissions or app installs:

| Check | Result |
| --- | --- |
| Swift core / optional adapter tests | 111 / 13 passed |
| Kotlin core tests | 115 passed |
| React Native typecheck / unit tests | Passed / 132 passed |
| React Native browser fixtures | 10 English/Arabic journeys passed |
| React Native Hermes exports | iOS and Android passed |
| Swift standalone and Studio | arm64 simulator compilation passed; unsigned, not installed |
| Android standalone and Studio | Assembly and instrumented-test compilation passed; adapter tests passed |
| Android standalone lint | Passed |
| Tooling tests / boundary guard | 61 passed / passed |

Comparison and review screenshots were inspected at 390x844, including Arabic.
Logs and screenshots are temporary `/tmp/rocento-community-*` and
`/tmp/rocento-{comparison,reviews}-{en,ar}.png` artifacts. Native UI execution,
large-text/accessibility and signed physical-device acceptance remain open.

## Support lifecycle increment - 2026-10-13

P16 adds guest/customer ticket creation, the customer's recent ticket list,
detail/status/priority, timestamped message history and replies on all platforms.
Order details open a prelinked support draft; support links return to the existing
order journey. Signed-in assistant ticket confirmations now open support details,
closing that P17 handoff gap without declaring all assistant actions complete.

Guest creation initializes a dedicated support cookie; customer list/detail/reply
use customer authorization. Guest confirmation retains the ticket number and
contact-follow-up notice, without exposing authenticated tracking. Customer
replies cannot send administrative status changes. List/message limits follow
the current web API (100); refresh is explicit rather than ten-second polling.

Drafts survive navigation and read errors, with reply drafts keyed by ticket.
Before either write, the store freezes its payload and request ID. Connection
errors preserve the exact attempt for explicit retry; successful writes clear it.
Only definitive 400/422 validation failures unlock edits. Reads never replay
writes, and identity reset invalidates late responses and clears customer data.
Pending replies have a return action when another ticket is opened.

These drafts, pending attempts and guest cookies are session-scoped, not durable
across process restart. Do not claim restart-safe support retries or credential
continuity from these tests. Existing credential keys and signing remain unchanged.

Verification uses isolated fixtures, with no live ticket creation or installs:

| Check | Result |
| --- | --- |
| Swift core / optional adapter tests | 113 / 13 passed |
| Kotlin core tests | 117 passed |
| React Native typecheck / unit tests | Passed / 138 passed |
| React Native browser fixtures | 14 English/Arabic journeys passed, including lost create/reply responses, exact retries, linked orders and guest intake |
| React Native Hermes exports | iOS and Android passed |
| Swift standalone and Studio | Simulator compilation passed; unsigned compile-only artifacts |
| Android standalone and Studio | Assembly and instrumented-test compilation passed; adapter tests passed |
| Android standalone lint | Passed |
| Mobile tooling tests / boundary guard | 61 passed / passed |

Support screenshots were inspected at 390x844 in English and Arabic. Logs are
`/tmp/rocento-support-*.log`; screenshots are `/tmp/rocento-support-{en,ar}.png`.
These temporary artifacts may be regenerated. Native screen execution, large
text, screen-reader and signed physical-device acceptance remain open.

## Saved conversations and memory increment - 2026-10-13

P18 adds authenticated recent-history grouping/search, fresh reads on reopening,
restored answer text and validated structured blocks, new conversation and
unavailable-history recovery to Swift, Kotlin and React Native. Restoring a turn
does not replay assistant events, apply a basket or open checkout. The current
history API returns at most 100 turns and has no cursor/offset contract; the UI
does not claim an exhaustive paginated archive. History remains accessible when
the independent memory read fails.

P19 adds personalization and journey consent with optimistic versions, category-
scoped preferences (create/edit/remove, dislike, occasion and recipient), recent
signals, context removal, explicit JSON export/share and confirmed deletion.
Per-request opt-out uses `X-Commerce-Personalize: 0`, not an unsupported JSON
field. Saved customer goals support rename, archive/unarchive, deletion and
fresh-read continuation; continuation checks expiry/archive state and never
applies a basket. Goal mutations carry the observed version.

Unknown memory-write outcomes require explicit readback before another change;
no write is automatically replayed. Drafts survive failures. Account reset clears
history, preferences, goals, draft and export data and invalidates late responses.
Guest memory uses a separate in-memory `assistant_guest` cookie, never customer
credentials; unavailable cookie retention fails closed. Guest journey consent
is disabled, and login/logout clears the local guest capability. Guest state is
not durable across process restart. Native export uses the platform share sheet
for JSON text; the React Native browser fixture downloads a JSON file.

Remaining P19 work: mobile guest-cart saved goals, full context-summary rendering,
and real cross-client ownership/expiry verification. These are not marked closed.
Native sharing, accessibility, large text and signed-device acceptance also remain
open. Existing credential storage keys and signing identities are unchanged; no
apps were installed and no live memories, conversations or orders were modified.

Verification artifacts are `/tmp/rocento-memory-*.log` and the inspected English/
Arabic screenshots `/tmp/rocento-memory-{en,ar}.png`. These are temporary and can
be regenerated from the isolated fixtures.

| Check | Result |
| --- | --- |
| Swift core / optional adapter tests | 117 / 17 passed |
| Kotlin core tests | 121 passed |
| React Native typecheck / unit tests | Passed / 148 passed |
| React Native browser fixtures | 16 English/Arabic journeys passed, including history restoration, lost preference response/readback, edit, export, goal rename/archive and confirmed memory deletion |
| React Native Hermes exports | iOS and Android passed |
| Swift standalone and Studio | Simulator compilation passed; unsigned compile-only artifacts |
| Android standalone and Studio | Assembly and instrumented-test compilation passed; adapter tests passed |
| Android standalone lint | Passed |
| Mobile tooling tests | 65 passed in the current shared workspace |
| Source and standalone artifact boundary guards | Passed |

Core regressions cover duplicate/malformed history, non-actionable restored turns,
unavailable conversations/goals, unknown-write readback, private-state reset,
guest-cookie ownership, request opt-out headers and versioned controls. Browser
screenshots were inspected at 390x844; this does not substitute for native screen
execution or physical-device acceptance.

Next unchecked groups: finish P19 details, P20 published content, P08 address
editing, P12 fulfillment/payment detail, P01/P21 React Native facets/merchandising,
then P22-P25 notifications, links and accessibility. No unchecked gap is implied
complete.
