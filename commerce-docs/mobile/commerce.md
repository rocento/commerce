# Native commerce and Studio enrollment

**Rocento** now includes published settings with cached/bundled fallback. `RocentoStudio` is a compatibility alias for the same app. Android requires `-PappBuilder=true` for enrollment/published design. See the [module separation and current build commands](development.md#standalone-apps-and-optional-app-studio).

This guide describes implemented customer commerce and optional Studio enrollment. Local and production checkpoints are retained in [commerce history](history/commerce-2026-10-12.md); they do not establish a current published version or signed physical-device release. See the [mobile status](README.md) and [release plan](plans/native-preview-and-release.md).

## Production binding and administration

- iOS scheme **Rocento**, Android flavor **rocento**, bundle/application ID `com.rocento.grocery`.
- Compiled merchant: `312f9ac8-4888-4d35-92a0-e5fdb3bf59b8`; environment: `production`.
- Config and commerce base: `https://grocery.rocento.com/api`. Remote config cannot replace the merchant, environment or API origin.
- `apps.rocento.com` remains the separate, production-only mobile administration application. Customer sign-in uses the grocery customer APIs; no mobile admin or core admin credential is embedded or accepted as a customer session.
- The native fallback uses the checked-in merchant design. Market and Boutique remain isolated local preview targets; there is no environment switch in the production builder or Rocento application.
- Config enrollment and private mobile assets are deployed, separately from customer commerce. Owner-issued codes connect internal installations to published designs. The 2026-10-12 history records production enrollment and published-design verification. Both native configuration loaders accept the published bytes and cache them across restart; the bundled fallback remains available.

## Implemented flow

Both native engines support live catalog/category browsing, configurable product pack selection, customer sign-in, registration, verification and password-reset requests, secure session renewal, authenticated cart quantity changes, saved delivery addresses and coverage checks. iOS supports map pins and accessible manual coordinates; Android offers an explicit foreground location permission request plus manual coordinates.

Rocento Grocery requires a covered delivery pin for its public product-family API. Product details guide guests or customers without a saved address to Account before checking sizes/stock. They do not silently treat missing delivery context as an empty family.

Checkout loads the store's fulfillment capabilities, supports enabled delivery/pickup and ASAP/scheduled choices, obtains a fulfillment plan, then requests an authoritative price quote. The customer reviews the server total and explicitly confirms the order. The current backend payment method is cash on delivery. Order history, lifecycle history and manual status refresh use the authenticated customer order APIs.

A quote is not an order. Neither fetching a quote nor launching/reopening the app submits checkout. A checkout attempt is encrypted before its first request and retains the same idempotency key across timeouts, restarts, logout and reauthentication. Attempts are separated by customer. An uncertain result blocks a different quote for that customer. A successful replay clears the attempt. A `400` from the existing checkout endpoint also clears it because that transaction resolves the original idempotency key before validating an uncommitted quote; network, decoding, authentication and server failures retain it. The UI permits a fresh review after a definitive rejection.

Customer refresh credentials, config credentials and pending checkout attempts have separate storage purposes, scoped to the compiled installation and commerce origin. Customer access tokens remain in memory. Logout clears the customer credential; an unresolved checkout record remains encrypted so signing in again cannot silently create a second order. Android excludes backup and device transfer; iOS uses device-only Keychain storage. HTTP transports reject redirects and bound response sizes. Public catalog/images and optional analytics never receive customer or config authorization.

Optional analytics defaults off. The Account screen can enable or revoke consent. Only fixed anonymous screen/funnel events are sent to the existing grocery analytics endpoint; payloads have an event UUID, per-launch session UUID, fixed event type/path and fixed source. They contain no account, product/order identifiers, search text, delivery address or coordinates. No offline queue or automatic retry is maintained; errors do not block commerce. The anonymous visitor cookie is retained in memory. Essential server-side transaction/audit records are independent of this optional UI telemetry.

## Push status

Native APNs/FCM integration is prepared and disabled by default. Provider activation and delivery acceptance remain owner-deferred. The order inbox is independent of push; see the [order push guide](order-push.md) for the implementation boundary and activation gates.

## Development and acceptance

Use the [development guide](development.md) for toolchains and safe builds, and [release acceptance](plans/native-preview-and-release.md) for remaining device/release gates. Dated enrollment, publication, commerce and authentication evidence is in [commerce history](history/commerce-2026-10-12.md).

## Optional Studio enrollment and private assets

The App Studio **Test installations** panel is owner-only and uses the mobile administration host. New runtime enrollment/session/asset endpoints remain blocked on that host; native apps use their compiled grocery API origin. No core admin pages or customer session credentials are involved.

An owner issues a random 64-character code for a pre-provisioned production app identity. The code expires in 15 minutes, is stored hashed, and can be consumed once. Enrollment checks the issuer's current owner membership, active merchant and identity, platform, merchant and application identifier inside a transaction. Matching identifier strings alone do not authenticate an app. This is a controlled internal-testing connection, not App Attest/Play Integrity or public consumer onboarding.

Both apps expose **Account → App connection**. The device-only Keychain/Keystore entry uses the independent `config-device` purpose. A device credential lasts 30 days; its access session lasts 30 minutes, remains in memory and is renewed before expiry. Renewal replaces prior access without rotating or extending the device credential, so a lost renewal response can be retried. Owner revocation disables sessions, renewal and future private asset delivery. Previously downloaded nonsecret configuration remains available offline. Commerce/customer sign-in is independent.

Private PNG reads require an active native session and an asset reference in the latest compatible published configuration. Draft-only, foreign and unverified assets are denied. Storage keys are constructed from the authenticated merchant and asset, never supplied by the caller. Backend and clients verify exact-byte SHA-256 checksums. Asset responses are private/no-store, have no redirects, and carry no customer bearer. Rendering uses bounded thumbnails. Trusted legacy external asset URLs are not proxied by this endpoint.
