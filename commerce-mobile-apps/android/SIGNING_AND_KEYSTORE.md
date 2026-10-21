# Mandatory Android signing and Keystore requirements

All native merchant builds, standalone and optional App Studio, MUST preserve
the installed package identity and app-signing certificate when updating an
existing installation. Follow this guide with the
[Android coding standard](CODING_STANDARDS.md).

Android checks signing certificates when accepting updates. Keystore keys belong
to an app UID and alias, so uninstalling/reinstalling or clearing data is not a
credential-preserving workaround for a signing failure. See
[Android app signing](https://developer.android.com/studio/publish/app-signing)
and [Keystore access control](https://source.android.com/docs/security/features/keystore#access-control).

## Preserve the identity and stored-item contract

| Flavor (same with or without `-PappBuilder=true`) | Application ID |
| --- | --- |
| `rocento` | `com.rocento.grocery` |
| `electronics` | `com.rocento.electronics` |
| `jewelry` | `com.rocento.jewelry` |
| `pharmacy` | `com.rocento.pharmacy` |
| `market` | `com.rocento.mobile.preview.market` |
| `boutique` | `com.rocento.mobile.preview.boutique` |

MUST preserve the actual signing certificate, not merely its alias, keystore
filename or subject name. A regenerated debug keystore is a different identity.
Debug and release keys normally differ. A Google Play upload key is not
necessarily the app-signing key on users' devices; compare the delivered APK.
Keep merchant package IDs separate. Do not introduce a shared UID.

[SecureSession](app/src/main/java/com/rocento/mobile/SecureSession.kt) uses:

- Keystore provider `AndroidKeyStore`, AES/GCM/NoPadding with a 128-bit tag.
- Alias and private SharedPreferences name:
  `rocento-session-<identity.cacheKey>-<purpose>-<SHA256(commerceBase)>`.
- `identity.cacheKey`: SHA256 of the literal UTF-8 string
  `merchantId|environment|android|commerceBase`.
- Preference key `session`, containing Base64 IV, `:`, Base64 encrypted value.
- Purposes `customer-refresh`, `checkout-attempt`, `analytics-consent`, `reorder-task`, and the
  optional builder adapter's `config-device`.

These values, endpoint spelling, and key-generation/access settings MUST remain
stable unless a tested migration is provided. Standalone builds MUST ignore
builder credentials without deleting them. Retain the manifest's disabled backup
and [data extraction exclusions](app/src/main/res/xml/data_extraction_rules.xml);
copying encrypted preferences alone does not restore the Keystore key.

`reorder-task` stores a customer/order-keyed map of server task IDs and pending
application flags. It uses checked reads: decryption/access failure MUST NOT be
treated as a missing record or cause creation of a fresh task. Existing credential
keys are unchanged. Signed upgrade acceptance must restore an interrupted reorder
under the same task after process restart.

## Automatic checks before installation

[The signing checker](../tools/check_android_signing.py) uses SDK Build Tools
36.0.0 `apksigner verify --verbose --print-certs` and the actual APK manifest.
It verifies the complete APK signature, expected package, single signing
certificate SHA-256 fingerprint, and version code. It rejects shared UID and
split APK inputs rather than guessing their compatibility.
See [apksigner verification](https://developer.android.com/tools/apksigner).

Gradle `install<Variant>`, `install<Variant>AndroidTest`, and
`connected<Variant>AndroidTest` tasks automatically run this gate after assembly
and before AGP's install/test action, for both standalone and builder modes.
Every connected device must be online and authorized; each is checked. The test
APK must also have the correct package, target and signing certificate.
CI runs through the same gate and saves `app/build/reports/signing/*.json`.
Use instrumented tests on disposable test devices: test runners can remove apps
when cleaning up. The signing gate does not change test-runner cleanup behavior.

Plain `assemble` has no destination to compare. Before manually installing its
output, use the checker with the explicit device/emulator serial from `adb devices`:

```sh
python3 commerce-mobile-apps/tools/check_android_signing.py \
  commerce-mobile-apps/android/app/build/outputs/apk/rocento/debug/app-rocento-debug.apk \
  --flavor rocento --serial YOUR_DEVICE_SERIAL \
  --report /absolute/path/to/signing-check.json
```

By default this only reads APK and package metadata. It never reads credentials
or app-private preferences. It copies the installed APK into a temporary local
directory, verifies it, compares certificates and version codes, then removes
that copy. An ADB error, unreadable/retained package, unsupported split installation,
invalid signature, changed certificate/package or version downgrade fails with
a nonzero exit status. A verified package inventory is required before treating
an app as a new installation; lookup failures are never treated as absence.

Add `--install` for a checked update. It takes a private snapshot of the candidate,
checks that exact APK against the destination, and runs `adb -s SERIAL install -r
--user CURRENT_USER` only after success. There is no uninstall, clear-data or
downgrade retry. Recheck any APK rebuilt or re-signed after a prior verification.
Do not run concurrent builds/installations against the same destination/output.

## Release signing

[The release signing script](../tools/sign_android_device.sh) requires the
existing owner-supplied signing inputs described in the
[device signing guide](../../commerce-docs/mobile/device-signing.md).
For upgrades, also set `ROCENTO_ANDROID_BASELINE_APK` to the prior delivered,
known-good signed APK. For a first installation only, set
`ROCENTO_ANDROID_NEW_INSTALLATION=1` and `ROCENTO_ANDROID_CERT_SHA256` to the
intended app-signing certificate fingerprint instead. The script rejects missing
or ambiguous baseline choices. The optional fingerprint pin also works on updates.

After alignment/signing, the final APK MUST pass the checker before the script
writes its success/checksum. A release artifact must not be debuggable.
`signing-check.json` records the APK checksum, package, version, signing
fingerprint and baseline status. No passwords or key material are recorded.
Before installing on a device, compare against that destination again using
`--serial`; an offline baseline cannot establish the device's current state.

The gate intentionally requires the same single signer. Android supports certain
signing-key rotations, but accepting one requires a separate tested lineage and
OS-version migration plan. AAB/Play-generated splits, multi-signer APKs and shared
UID migrations are outside this direct-APK flow. Do not bypass the guard to force
them through or generate a replacement merchant key to fix a mismatch.

## Saved-credential acceptance

Signing checks protect the update identity; they cannot prove that native code
still derives the same alias or can decrypt existing data. After an approved
update, verify an existing customer session restores across a process restart.
For builder builds, also verify the original enrollment retrieves the published
configuration without a new connection code. When changing composition, verify
builder → standalone → builder preserves both credential purposes.

Storage changes require focused Keystore migration/restart tests. Never clear
data, uninstall, overwrite the user's session, or re-enroll merely to make an
upgrade test pass. If decryption fails, compare signing, package identity and
stored-item derivation first. Record only metadata and pass/fail results, never
tokens, plaintext/ciphertext credentials or connection codes.
