#!/usr/bin/env bash
# Manual signing: certificates/private keys stay in the owner's Keychain.
set -euo pipefail
set +x
if [[ $# != 1 ]]; then
  echo 'Usage: bash commerce-mobile-apps/tools/sign_ios_device.sh NEW_ABSOLUTE_OUTPUT_DIRECTORY' >&2
  exit 2
fi
: "${ROCENTO_APPLE_TEAM_ID:?Set the Apple Developer Team ID}"
: "${ROCENTO_IOS_SIGNING_IDENTITY:?Set the installed signing certificate SHA-1 fingerprint}"
: "${ROCENTO_IOS_PROFILE_UUID:?Set the installed provisioning profile UUID}"
[[ "$ROCENTO_APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]
[[ "$ROCENTO_IOS_SIGNING_IDENTITY" =~ ^[A-Fa-f0-9]{40}$ ]]
[[ "$ROCENTO_IOS_PROFILE_UUID" =~ ^[A-Fa-f0-9-]{36}$ ]]
method=${ROCENTO_IOS_EXPORT_METHOD:-release-testing}
[[ "$method" == release-testing || "$method" == debugging ]] || { echo 'Only direct device-testing exports are supported.' >&2; exit 2; }
[[ "$1" == /* && ! -e "$1" ]] || { echo 'Use a new absolute output directory.' >&2; exit 2; }
baseline_args=()
if [[ -n "${ROCENTO_IOS_BASELINE_APP:-}" ]]; then
  [[ "${ROCENTO_IOS_NEW_INSTALLATION:-}" != 1 ]] || { echo 'Choose a baseline app or a new installation, not both.' >&2; exit 2; }
  [[ -d "$ROCENTO_IOS_BASELINE_APP" ]] || { echo 'Known-good baseline .app not found.' >&2; exit 2; }
  baseline_args=(--baseline-app "$ROCENTO_IOS_BASELINE_APP")
elif [[ "${ROCENTO_IOS_NEW_INSTALLATION:-}" == 1 ]]; then
  baseline_args=(--new-installation)
else
  echo 'Set ROCENTO_IOS_BASELINE_APP to the prior signed .app, or ROCENTO_IOS_NEW_INSTALLATION=1 for a new installation.' >&2
  exit 2
fi
security find-identity -v -p codesigning | grep -F -i "$ROCENTO_IOS_SIGNING_IDENTITY" >/dev/null
root=$(cd "$(dirname "$0")/../.." && pwd)
umask 077
mkdir -p "$1"
python3 - "$1/ExportOptions.plist" "$method" <<'PY'
import os, plistlib, sys
with open(sys.argv[1], 'wb') as f:
    plistlib.dump({'method': sys.argv[2], 'destination': 'export',
        'teamID': os.environ['ROCENTO_APPLE_TEAM_ID'], 'signingStyle': 'manual',
        'signingCertificate': os.environ['ROCENTO_IOS_SIGNING_IDENTITY'],
        'provisioningProfiles': {'com.rocento.grocery': os.environ['ROCENTO_IOS_PROFILE_UUID']}}, f)
PY
xcodebuild -project "$root/commerce-mobile-apps/ios/RocentoMobile.xcodeproj" -scheme Rocento \
  -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath "$1/DerivedData" -archivePath "$1/Rocento.xcarchive" \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM="$ROCENTO_APPLE_TEAM_ID" CODE_SIGN_IDENTITY="$ROCENTO_IOS_SIGNING_IDENTITY" \
  PROVISIONING_PROFILE_SPECIFIER="$ROCENTO_IOS_PROFILE_UUID" archive > "$1/archive.log" 2>&1
python3 "$root/commerce-mobile-apps/tools/check_ios_signing.py" "$1/Rocento.xcarchive/Products/Applications/Rocento.app" \
  --platform device --bundle-id com.rocento.grocery --team-id "$ROCENTO_APPLE_TEAM_ID" \
  "${baseline_args[@]}" --report "$1/archive-signing-check.json"
xcodebuild -exportArchive -archivePath "$1/Rocento.xcarchive" \
  -exportOptionsPlist "$1/ExportOptions.plist" -exportPath "$1/export" > "$1/export.log" 2>&1
shopt -s nullglob
ipas=("$1"/export/*.ipa)
[[ ${#ipas[@]} == 1 ]] || { echo 'Expected exactly one exported IPA.' >&2; exit 1; }
ditto -x -k "${ipas[0]}" "$1/verified-export"
apps=("$1"/verified-export/Payload/*.app)
[[ ${#apps[@]} == 1 ]] || { echo 'Expected exactly one exported app.' >&2; exit 1; }
python3 "$root/commerce-mobile-apps/tools/check_ios_signing.py" "${apps[0]}" \
  --platform device --bundle-id com.rocento.grocery --team-id "$ROCENTO_APPLE_TEAM_ID" \
  --baseline-app "$1/Rocento.xcarchive/Products/Applications/Rocento.app" \
  --report "$1/export-signing-check.json"
shasum -a 256 "${ipas[0]}" > "$1/SHA256SUMS"
echo "Device IPA exported to $1/export; install only on devices covered by the profile."
