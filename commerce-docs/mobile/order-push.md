# Native order push integration

Prepared integration; **not enabled or deployed**. No APNs key, Apple provisioning
profile, Firebase project, or device delivery acceptance has been supplied.
The existing in-app order inbox continues to work independently.

## Backend

Apply the normal gateway migrations, including
`commerce-api/rocento-api/migrations/20261012090000_customer_order_push.sql`. The gateway remains
push-disabled unless `ORDER_PUSH_CONFIG_FILE` points to a readable JSON file:

```json
{
  "app_id": "com.rocento.grocery",
  "apns": {
    "team_id": "YOURTEAMID",
    "key_id": "YOURKEY_ID",
    "key_file": "/run/secrets/order-push/AuthKey.p8",
    "environment": "sandbox"
  },
  "fcm_service_account_file": "/run/secrets/order-push/firebase-service-account.json"
}
```

Use the actual ten-character Apple team/key identifiers. Either provider may be
omitted. A supplied but invalid configuration fails gateway startup. Configure
one merchant application ID per merchant gateway; use the corresponding
`com.rocento.grocery`, `com.rocento.electronics`, `com.rocento.jewelry`, or
`com.rocento.pharmacy` ID. These are trusted deployment settings, independent of
App Studio enrollment.

Mount the config and private keys read-only into the gateway container, set
`ORDER_PUSH_CONFIG_FILE` there, and grant only that service access. The current
Compose setup does not automatically mount these files: provide a deployment
secrets/override configuration when enabling. Keep private keys out of Git,
mobile bundles, public storage, logs, and chat. Firebase's server service account
needs permission to send FCM messages in its project, with the FCM HTTP v1 API
enabled. Egress is HTTPS to Apple's APNs host, `oauth2.googleapis.com`, and
`fcm.googleapis.com`.

The authenticated API is `PUT /v1/customer/push-devices/{installation_uuid}` with:

```json
{
  "customer_id": "SIGNED_IN_CUSTOMER_UUID",
  "platform": "ios",
  "app_id": "com.rocento.grocery",
  "token": "PROVIDER_DEVICE_TOKEN",
  "locale": "en"
}
```

`DELETE` on the same path revokes that customer's installation. Registration
requires a valid customer session and a configured provider. The expected
customer ID prevents account-switch races. Device rows are bound to the session;
logout/password-reset session deletion cascades registrations and queued work.
A token can belong to only one installation/account for a given app/platform.
The apps retain separate installation IDs and opt-in preferences per account.

Order history inserts atomically enqueue delivery to opted-in devices. Public
states include placed, confirmed, fulfilling, shipped, delivered, cancelled,
pickup-ready, picked-up, and delivery-failed. Internal cash-collection events do
not notify. Old history is not backfilled. Active registrations are refreshed
on app foreground; registrations older than 30 days are excluded. Jobs expire
after 24 hours and have at most eight attempts, with exponential backoff for
network/provider failures. Invalid provider tokens are disabled. APNs JWTs and
Google OAuth access tokens are cached. Delivery is best effort: a lost provider
acknowledgement can cause a retry/duplicate, and provider acceptance is not proof
that a device displayed an alert. Android keeps a bounded local event dedupe list.

Payloads contain only generic localized copy and opaque customer/order/event
IDs, with no name, address, items, payment details, or order number. Android uses
data messages, checks local account/permission/opt-in, and creates the notification
locally. Taps validate IDs and fetch the order through the customer's authenticated
API; a payload does not grant order access. Disabling or logout clears Android
notifications. iOS unregisters with APNs and clears delivered notifications.
Already in-flight alerts cannot be recalled from provider networks.

## Apple setup

1. Enable Push Notifications for each actual App ID in the Apple developer
   account. Create an APNs authentication key and securely configure the backend.
2. Regenerate the owner's provisioning profile with the push capability. Add
   `aps-environment` (`development` or `production`) to the **existing authorized
   entitlements**, retaining its application identifier and Keychain groups.
   Follow [the mandatory signing guide](../../commerce-mobile-apps/ios/SIGNING_AND_KEYCHAIN.md).
   Never replace the existing entitlements with a push-only file or use the local
   simulator identity for physical devices.
3. Build with `ROCENTO_PUSH_ENABLED=YES` and the owner's signing/profile settings.
   The generated default is `NO`; run the normal Xcode project generator after
   source changes. The backend APNs environment must match the build's entitlement:
   development → sandbox; TestFlight/App Store → production.
4. Sign in, open Account → App settings, and enable **Order push notifications**.
   The app asks iOS permission and displays enabled only after server registration
   succeeds. If denied, it links to system Settings. Foregrounding resynchronizes
   permission and token registration. Token callback updates are also registered.

No background-fetch entitlement is needed for this visible-alert integration.

## Android setup

1. Create a Firebase project, register each exact package ID, and enable FCM.
   Download the public Android client `google-services.json` for each merchant.
2. Put it in that merchant's flavor assets, for example
   `commerce-mobile-apps/android/app/src/rocento/assets/google-services.json` (other flavors:
   `electronics`, `jewelry`, `pharmacy`). This is the **client** configuration;
   never put a service-account JSON/private key in app assets. The implementation
   initializes `FirebaseOptions` directly and checks the package match, so it does
   not require the Google Services Gradle plugin.
3. Build using `-PpushNotifications=true` (plus `-PappBuilder=true` only for Studio).
   Default builds remain disabled and need no Firebase configuration. Messaging
   auto-init and analytics collection default off; no Analytics SDK is added.
4. On a Google Play-enabled physical device, sign in and enable the push setting.
   Android 13+ asks `POST_NOTIFICATIONS` permission. Android notification settings
   control both app permission and the Order updates channel. Foregrounding
   refreshes registration; token rotation refreshes immediately while a commerce
   client is active, otherwise on the next foreground.

The permission controls are separate from **Show order updates**, which controls
only the in-app inbox. Push setup is not simulated by App Builder preview.

## Activation acceptance (required before calling delivery live)

Use designated test customer accounts and real signed device builds. Do not
broadcast or send test orders to customer accounts.

- Enable, deny, and revoke OS permission; disable/re-enable the app preference.
- Verify token registration and rotation, app restart, foreground and background,
  cold-start taps, and opt-out. Android force-stop prevents delivery until relaunched.
- Change an owned test order through public statuses. Verify one generic alert,
  the intended merchant, and a fresh authenticated order screen after tapping.
- Sign out or switch accounts and confirm old queued alerts do not reveal an old
  order. Try another account's order ID and confirm API denial. Confirm session
  revocation removes registration/jobs and unrelated accounts receive no alerts.
- Exercise provider rejection, invalid token, retry, expiration, and a worker
  restart. Inspect job state/counts without logging provider tokens or credentials.
- Verify iOS saved customer/Studio credentials survive the signed update. Unsigned
  compilation does not establish credential persistence or APNs delivery.

Provider setup references: [Apple APNs registration](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns),
[Apple APNs requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns),
and [Firebase Android messaging](https://firebase.google.com/docs/cloud-messaging/android/get-started).
