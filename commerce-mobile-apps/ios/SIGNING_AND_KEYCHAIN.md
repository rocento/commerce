# Mandatory iOS signing and Keychain requirements

These requirements apply to all native merchant apps, canonical merchant apps and legacy Studio
scheme aliases. Customer credentials and published-settings enrollment use
separate Keychain purposes. Follow this guide together with the
[iOS coding standard](CODING_STANDARDS.md).

## Preserve the installed identity

An update MUST preserve the merchant's bundle ID, application-identifier prefix,
and authorized Keychain access groups. Canonical schemes and legacy Studio aliases for the
same merchant MUST use the same identity. Different merchants MUST keep separate
groups. Do not assume that retaining only the bundle ID is sufficient: changing
the App ID prefix can remove access to existing items.
[Apple's Keychain-access warning guidance](https://developer.apple.com/library/archive/qa/qa1726/_index.html)
describes that failure.

`SecureSession` does not set `kSecAttrAccessGroup` explicitly. Its writes therefore
use the app's default group. Preserve that default when adding or reordering
groups; reading and writing must remain compatible with existing items.
See [Apple's access-group rules](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps).

The established **local simulator** identities are:

| Standalone / Studio schemes | Bundle ID | `application-identifier` and sole `keychain-access-groups` entry |
| --- | --- | --- |
| Rocento / RocentoStudio | `com.rocento.grocery` | `local.rocento.com.rocento.grocery` |
| Electronics / ElectronicsStudio | `com.rocento.electronics` | `local.rocento.com.rocento.electronics` |
| Jewelry / JewelryStudio | `com.rocento.jewelry` | `local.rocento.com.rocento.jewelry` |
| Pharmacy / PharmacyStudio | `com.rocento.pharmacy` | `local.rocento.com.rocento.pharmacy` |

This local prefix preserves the existing simulator installations. It is not an
Apple Team ID or a physical-device provisioning identity. If an installation
uses another established prefix/group, inspect and preserve that identity rather
than replacing it with this table.

## Preserve the stored-item contract

Changes to [SecureSession](RocentoCore/Sources/RocentoCore/SecureSession.swift) or
[AppIdentity](RocentoCore/Sources/RocentoCore/Config.swift) MUST preserve these
values unless an explicit, tested migration is provided:

| Attribute | Existing value or derivation |
| --- | --- |
| Item class | `kSecClassGenericPassword` |
| Service | `com.rocento.mobile.session` |
| Account | `identity.cacheKey + "\|" + purpose + "\|" + SHA256(commerceBaseURL.absoluteString)` |
| `identity.cacheKey` | SHA256 of `merchantID\|environment\|ios\|commerceBaseURL.absoluteString` |
| Purpose values | `customer-refresh`, `checkout-attempt`, `analytics-consent`, `reorder-task`; optional adapter: `config-device` |
| Accessibility | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` |

The separators above are literal pipe characters (`|`). Endpoint spelling is
part of the key: a trailing-slash change can change the hash. Preserve credential
purpose separation. The unified merchant app MUST reuse the existing builder credential without
changing its key or deleting it. Local fixture apps do not use enrollment.

`reorder-task` is a separate customer/order-keyed map of server task IDs and pending
application flags. Checked reads MUST distinguish missing items from access
failures. Writes update an existing item before attempting an add, preserving
the previous record on failure. No existing credential purpose or key changes.
Signed upgrade acceptance must verify a pending reorder survives process restart.

All `SecureSession.save` replacements now update an existing item before adding
an absent one, so a failed write does not first delete the previous credential or
checkout record. Deletion accepts success or an already-missing item; other
Keychain failures propagate through logout to action feedback. Storage identifiers
and accessibility remain unchanged. Fault-injection unit tests cover these paths;
they do not replace signed device upgrade and restart acceptance.

## Signed simulator build

Use [the checked simulator build script](../tools/build_ios_simulator.py) from
the repository root. Select a booted simulator from `xcrun simctl list devices
available`, a scheme from the table, and a **new absolute output directory**:

```sh
python3 commerce-mobile-apps/tools/build_ios_simulator.py \
  --scheme Rocento \
  --simulator YOUR_AVAILABLE_SIMULATOR_UDID \
  --output "$PWD/output/ios-simulator-signed-NEW"
```

The script reads the installed app's effective identity before building, preserves
its application identifier and Keychain groups, signs the new app, and verifies
the final artifact. It reads the destination again after building to detect a
changed baseline. A confirmed new installation uses the established local
identity. Lookup failures, unreadable signatures, empty effective entitlements, a changed
prefix/default group, or removal of an existing group stop the script with a
nonzero exit status. The check never reads stored credentials.

For simulators, Xcode embeds effective entitlements in the executable's Mach-O
`__TEXT,__entitlements` section (from `App-Simulated.xcent`). The code-signature
entitlement dictionary may legitimately be empty. The checker verifies the
signature first, then validates the embedded plist in **every architecture**;
missing, malformed, or inconsistent embedded entitlements fail. If the signature
also contains entitlements, its identity fields must agree with the embedded
ones. Do not reject a simulator app solely because `codesign -d --entitlements`
prints an empty dictionary, or manually inject entitlements into its signature
to compensate; let Xcode generate the simulator metadata.

- Add `--build-for-testing` to prepare UI tests with the same checks. CI uses this
  path before `test-without-building`, which may install the target app.
- Add `--install` only when installation is intended. Installation runs only after
  successful verification; the default only builds and checks.
- If an earlier broken build has lost its entitlements, supply
  `--baseline-app /absolute/path/to/known-good/Rocento.app` for recovery.
  This explicitly uses that artifact instead of the installed app as the baseline;
  preserve the correct merchant's last working artifact and do not erase data.

The output contains `build.log`, `Simulator.entitlements`, `DerivedData`, and
`signing-check.json` with the checked identity and whether an existing baseline
was compared, plus the entitlement source. Signature success alone is insufficient;
the checker validates effective entitlements, including the simulator debug flag.

Recheck any artifact changed or rebuilt after verification, before installing it:

```sh
python3 commerce-mobile-apps/tools/check_ios_signing.py /absolute/path/to/Rocento.app \
  --platform simulator --bundle-id com.rocento.grocery \
  --simulator YOUR_AVAILABLE_SIMULATOR_UDID
```

[The checker](../tools/check_ios_signing.py) also validates device apps. Device
updates require `--baseline-app` pointing to a prior signed app; only a new device
installation may use `--new-installation`. Both require `--team-id`. It verifies
signature, platform, bundle/application IDs, default and retained access groups,
profile expiry, entitlement authorization, and the actual signing certificate's
membership in the provisioning profile. The
[device signing script](../tools/sign_ios_device.sh) runs it on both the archive
and the app extracted from the exported IPA; an export cannot silently change
the Keychain identity.

Keep concurrent builds in separate output directories. `CODE_SIGNING_ALLOWED=NO`
is permitted for compile-only checks, never as credential acceptance or an
installable artifact. The boundary guard checks builder isolation separately.
These signing checks cannot prove customer-session restoration or detect a change
to storage-key derivation inside native code; the runtime checks below still apply.

## Verify before installing and after upgrading

1. Inspect the current installed app's signature/entitlements and the proposed
   replacement. On a simulator, obtain the current app path with
   `xcrun simctl get_app_container DEVICE_UDID BUNDLE_ID app`. Use the checker
   above with `--simulator` and optionally `--report /path/to/report.json` to
   compare the replacement against it. Compare bundle ID, application identifier,
   and access groups. Verify the actual final artifact, not just an entitlements
   source file or the build settings.
2. Install as an update on the designated test installation, preserving its data.
   Do not uninstall or erase the simulator/Keychain to make the test pass.
3. Verify a previously saved customer session restores, then terminate and
   relaunch and verify it again. Test new credential persistence on a separate
   disposable test installation; do not overwrite the existing user's session.
4. For Studio, confirm the original enrollment retrieves the expected published
   version without a new connection code, including after restart. A visible
   cached design alone does not prove enrollment or network access works.
5. When changing composition/signing, verify an update from a legacy signed app
   to the canonical app with the same identity: customer-session continuity and
   published configuration using the original enrollment, including after restart.
6. Record scheme, bundle ID, simulator/device, signed entitlements, artifact
   checksum, and restoration result. Do not record tokens or connection codes.

If access fails, first compare signing and storage keys against the working
installation. Restore compatible signing before retrying enrollment. Any
temporary diagnostics must be limited to operation names, HTTP status, or numeric
Keychain OSStatus; never log credentials, request/response bodies, or connection
codes. An inaccessible item is not proof that the credential was deleted or revoked.
The current `SecureSession` returns `nil` on a failed read and maps a failed write
to `MobileFailure.unauthorized`; a generic connection error alone does not identify
whether HTTP authorization or Keychain access failed.

## Physical-device builds

Use the owner's matching Apple signing certificate and provisioning profile,
with the correct App ID prefix and authorized access groups. Preserve the
installed identity across upgrades; inspect the final signed/exported app.
Do not copy `local.rocento.*`, simulator ad hoc signing (`CODE_SIGN_IDENTITY=-`),
or the simulator `get-task-allow` setting into distribution configuration.
Follow the [real-device signing guide](../../commerce-docs/mobile/device-signing.md).

## Verified recovery — 2026-10-12

The runtime 1.2 Grocery simulator app displayed cached v5 and failed to reconnect
when its build lacked the established Keychain entitlements. Rebuilding with
the per-merchant simulator entitlements and ad hoc signing restored access:
Grocery downloaded published v6 using the original saved credential, without
re-enrollment or a source-code change. This is why unsigned compilation and
cached configuration are insufficient credential-compatibility checks.
Subsequent inspection confirmed that the working simulator's effective values
were embedded in `__TEXT,__entitlements` even though its code-signature plist
was empty. The automated gate validates that effective identity and accepts the
known-working app; an empty signature plist alone is not a credential failure.

## Automated signed upgrade acceptance

Build the RocentoStudio compatibility alias and Rocento with `build_ios_simulator.py --build-for-testing`
on a disposable simulator, then run (the legacy `--standalone` argument now
selects the canonical app build):

```sh
python3 commerce-mobile-apps/tools/test_ios_keychain_upgrade.py \
  --simulator YOUR_SIMULATOR_UDID \
  --studio /absolute/path/to/checked-studio-output \
  --standalone /absolute/path/to/checked-canonical-output \
  --output /absolute/path/to/new-evidence-directory
```

The debug-only harness uses a synthetic merchant/origin and real Keychain APIs.
It inserts the established legacy account/service/accessibility format independently
of `SecureSession`, fails on existing seed records, and then runs Studio seed,
Studio restart, canonical app update/restart, alias update and final recovery/logout.
It verifies refresh-token rotation, unchanged pending checkout idempotency keys,
pending reorder retention, and restored Studio enrollment fetching a publication
without another connection code. Every update passes the signature/identity gate.
All HTTP is fixture-only and cannot fall back to the network. The runner requires
one passing, non-skipped test per stage and retains signature reports and xcresults.
It never uninstalls the app or clears Keychain data. A second fresh seed run needs
a separate disposable simulator; do not erase records to bypass a failed run.

This proves signed simulator storage-contract continuity, including alias/canonical updates.
Owner-signed physical-device distribution and live server integration remain
separate release checks.
