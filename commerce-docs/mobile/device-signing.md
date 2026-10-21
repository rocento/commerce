# Native real-device signing preparation

Recorded preparation checkpoint — 2026-10-12: **unsigned device builds prepared; owner signing details required**.
Rocento Grocery uses `com.rocento.grocery` on both platforms, version 1.1.0,
build 3. This is direct internal device testing, not TestFlight/Play publication.
Firebase/APNs remain deferred.

All signing and upgrade work MUST follow the
[iOS signing and Keychain requirements](../../commerce-mobile-apps/ios/SIGNING_AND_KEYCHAIN.md)
and [Android signing and Keystore requirements](../../commerce-mobile-apps/android/SIGNING_AND_KEYSTORE.md).
Preserve the installed App ID prefix, authorized access groups, and stored-item
keys. Simulator entitlements and the local simulator prefix are never inputs to
physical-device signing.

The following artifacts and available credentials describe that checkpoint. Inspect current artifacts and signing inventory before a new run; the source-adjacent signing contracts remain authoritative. Android prerequisites are owned by the [development guide](development.md#prerequisites).

## Prepared artifacts and validation

`output/mobile-device-builds-20261012/` contains:

- `Rocento-unsigned.xcarchive`: Release archive built for `generic/platform=iOS`
  (physical iPhone/iPad), not a simulator archive. `ARCHIVE SUCCEEDED`.
- `Rocento-1.1.0-build3-unsigned.apk`: Android Release APK; release lint passed.
- `preparation.json`, build logs and APK `SHA256SUMS`.
- `disposable-signing-test.txt`: successful APK signature verification from testing
  the signing script with a disposable fixture key. That key and its signed test
  APK were deleted; they are not merchant credentials or distributable artifacts.

Archive inspection exposed a hard-coded iOS build 2 in Info.plist despite Xcode
being configured for build 3. Info.plist and its generator now derive build and
version from `CURRENT_PROJECT_VERSION` and `MARKETING_VERSION`; the device archive
was rebuilt to verify the resolved metadata.

The Mac reported zero valid Apple code-signing identities. No owner Android
release key is configured. Neither prepared artifact is a signed installation
package. The iOS signing script passed syntax/preflight checks; signing/export
cannot be verified until the owner supplies a certificate and profile.

## Details needed from the owner

For iOS, provide the Apple Developer **Team ID** and confirm that
`com.rocento.grocery` belongs to that team. For direct distribution to registered
devices, supply an Apple Distribution certificate with its private key installed
in this Mac's Keychain, its SHA-1 fingerprint, and an installed Ad Hoc provisioning
profile UUID covering the app and test devices. Provide the test iPhone/iPad UDIDs
and device names for registration if they are not already in the profile. A
Development certificate/profile can instead be used with the `debugging` export
method. The owner can sign in to Xcode locally to manage certificates; do not send
Apple account passwords or two-factor codes in chat.

For Android, provide the **absolute keystore path**, **key alias**, and the expected
certificate SHA-256 fingerprint if one already exists. Keystore and key passwords
must be supplied in the private local environment, not chat or source control.
If there is no existing key, tell us before creating a durable merchant-owned key
and deciding where its protected backup will live. Reuse the established signing
identity if this app has already been distributed. A Play upload key may differ
from the key signing apps delivered by Google Play.

Default delivery is an iOS IPA for registered devices and a directly installable
Android APK. If TestFlight or Play internal testing is preferred, say so; those
need their store-account/app setup and a separate submission step. A Google Play
account is not required just to sign and sideload an APK.

Apple references: [registered device distribution](https://developer.apple.com/documentation/xcode/distributing-your-app-to-registered-devices),
[device registration](https://developer.apple.com/help/account/devices/register-a-single-device).
Android references: [app signing](https://developer.android.com/studio/publish/app-signing),
[apksigner verification](https://developer.android.com/tools/apksigner).

## Signing commands

Signing files belong outside the repository. `.gitignore` also excludes common
keystore/certificate/profile extensions and `commerce-mobile-apps/signing.local.env`.
The scripts require a new output directory and never install or publish an app.

Android: set `JAVA_HOME` to JDK 21 and `ANDROID_HOME` to the SDK. Supply
`ROCENTO_ANDROID_KEYSTORE`, `ROCENTO_ANDROID_KEY_ALIAS`,
`ROCENTO_ANDROID_STORE_PASSWORD` and `ROCENTO_ANDROID_KEY_PASSWORD` through a
private local environment. Passwords are passed to apksigner by environment name,
not command-line value. For updates, set `ROCENTO_ANDROID_BASELINE_APK` to the prior
delivered, known-good signed APK. For a first installation only, set
`ROCENTO_ANDROID_NEW_INSTALLATION=1` and `ROCENTO_ANDROID_CERT_SHA256` to the intended
app-signing certificate SHA-256 fingerprint instead. The fingerprint pin is also
supported on updates. Then run from the repository root:

```sh
bash commerce-mobile-apps/tools/sign_android_device.sh \
  output/mobile-device-builds-20261012/Rocento-1.1.0-build3-unsigned.apk \
  output/mobile-device-builds-20261012/android-signed
```

The script rejects a different package or debuggable APK, aligns and signs, then
automatically compares the final APK's signing certificate/package/version against
the baseline (or the explicit first-install certificate pin). A mismatch, invalid
signature, shared UID or downgrade fails before success/checksum output.
It writes `signing-check.json`, certificate details and a checksum beside
`Rocento-device.apk`. Before installing, check the actual destination too:

```sh
python3 commerce-mobile-apps/tools/check_android_signing.py /absolute/path/to/Rocento-device.apk \
  --flavor rocento --serial YOUR_DEVICE_SERIAL --release --install
```

For iOS, install the matching certificate/private key and provisioning profile.
Set `ROCENTO_APPLE_TEAM_ID`, `ROCENTO_IOS_SIGNING_IDENTITY` (certificate SHA-1),
`ROCENTO_IOS_PROFILE_UUID`, and optionally `ROCENTO_IOS_EXPORT_METHOD` (`release-testing`
by default, or `debugging` for a development profile). For an update, also set
`ROCENTO_IOS_BASELINE_APP` to the absolute path of the previously distributed,
known-good signed `.app`. For a first installation only, set
`ROCENTO_IOS_NEW_INSTALLATION=1` instead; the script rejects an unspecified or
ambiguous baseline. Then:

```sh
bash commerce-mobile-apps/tools/sign_ios_device.sh \
  /Users/momar/Documents/commerce-ai/output/mobile-device-builds-20261012/ios-signed
```

This creates a fresh Release archive using manual signing, verifies its signature
and Keychain identity, then repeats the checks on the app extracted from the
exported IPA. It checks profile expiry, authorized entitlements and signing
certificate, and rejects a changed application identifier/default Keychain group
or loss of an existing group. Reports are saved as `archive-signing-check.json`
and `export-signing-check.json`; no success/checksum is emitted on failure.
It does not use simulator entitlements, create
certificates, register devices, or upload to App Store Connect. Changes made after
this preparation will be included in that fresh archive; review/freeze the source
before final acceptance and rebuild Android too if the source changes.

## Real-device acceptance after signing

1. Install the IPA with Xcode/Apple Configurator on a device covered by its profile;
   enable Developer Mode where required. Install the APK on the designated Android
   test device. A release key cannot update a debug-key installation with the same
   package ID: use a separate test device. Do not uninstall or clear an existing
   installation to bypass a signing mismatch; preserve its saved credentials.
2. For an update, verify the saved customer session restores before creating
   new credentials. Studio builds must also reuse existing enrollment to fetch
   published configuration; use an owner-issued connection code only for a new
   test enrollment. Standalone builds use bundled design and need no enrollment.
   Restart and verify customer-session restoration and, for Studio, enrollment
   restoration. Inspect final signed entitlements if access fails before replacing
   credentials or clearing data.
3. Check English/Arabic, RTL, dark mode, large text, VoiceOver/TalkBack, delivery
   location permission denial and outside-area handling.
4. Check authentication/revocation and interrupted-checkout replay under the
   controlled acceptance procedure in the [commerce guide](commerce.md).
   Agree on the test account and order procedure before placing any real order.
5. Record OS/device model, runtime/build, signing certificate fingerprint, profile
   expiry, artifact checksum and pass/fail evidence. Signed device acceptance,
   remote CI and store distribution remain open until separately completed.
