#!/usr/bin/env bash
# Sign a release APK using an owner-provided key. Never enable shell tracing here.
set -euo pipefail
set +x
if [[ $# != 2 ]]; then
  echo 'Usage: bash commerce-mobile-apps/tools/sign_android_device.sh UNSIGNED_APK NEW_OUTPUT_DIRECTORY' >&2
  exit 2
fi
: "${ANDROID_HOME:?Set ANDROID_HOME to the installed Android SDK}"
: "${ROCENTO_ANDROID_KEYSTORE:?Set the absolute path to your private keystore}"
: "${ROCENTO_ANDROID_KEY_ALIAS:?Set the signing key alias}"
: "${ROCENTO_ANDROID_STORE_PASSWORD:?Set the keystore password in the private environment}"
: "${ROCENTO_ANDROID_KEY_PASSWORD:?Set the key password in the private environment}"
tools="$ANDROID_HOME/build-tools/36.0.0"
[[ -f "$1" && -f "$ROCENTO_ANDROID_KEYSTORE" && -x "$tools/apksigner" && -x "$tools/zipalign" ]]
[[ ! -e "$2" ]] || { echo 'Output directory must be new; refusing to overwrite artifacts.' >&2; exit 2; }
root=$(cd "$(dirname "$0")/../.." && pwd)
baseline_args=()
if [[ -n "${ROCENTO_ANDROID_BASELINE_APK:-}" ]]; then
  [[ "${ROCENTO_ANDROID_NEW_INSTALLATION:-}" != 1 ]] || { echo 'Choose a baseline APK or a new installation, not both.' >&2; exit 2; }
  [[ -f "$ROCENTO_ANDROID_BASELINE_APK" ]] || { echo 'Known-good baseline APK not found.' >&2; exit 2; }
  baseline_args=(--baseline-apk "$ROCENTO_ANDROID_BASELINE_APK")
elif [[ "${ROCENTO_ANDROID_NEW_INSTALLATION:-}" == 1 ]]; then
  : "${ROCENTO_ANDROID_CERT_SHA256:?New installations require the intended app-signing certificate SHA-256 fingerprint}"
  baseline_args=(--new-installation)
else
  echo 'Set ROCENTO_ANDROID_BASELINE_APK to the prior delivered APK, or ROCENTO_ANDROID_NEW_INSTALLATION=1 for a first installation.' >&2
  exit 2
fi
if [[ -n "${ROCENTO_ANDROID_CERT_SHA256:-}" ]]; then
  baseline_args+=(--expected-cert-sha256 "$ROCENTO_ANDROID_CERT_SHA256")
fi
# Avoid signing a different merchant or a debuggable application.
metadata=$("$tools/aapt" dump badging "$1")
[[ "$metadata" == *"package: name='com.rocento.grocery'"* ]]
[[ "$metadata" != *"application-debuggable"* ]]
umask 077
mkdir -p "$2"
"$tools/zipalign" -P 16 -f 4 "$1" "$2/aligned-unsigned.apk"
"$tools/apksigner" sign --ks "$ROCENTO_ANDROID_KEYSTORE" \
  --ks-key-alias "$ROCENTO_ANDROID_KEY_ALIAS" \
  --ks-pass env:ROCENTO_ANDROID_STORE_PASSWORD --key-pass env:ROCENTO_ANDROID_KEY_PASSWORD \
  --out "$2/Rocento-device.apk" "$2/aligned-unsigned.apk"
"$tools/apksigner" verify --verbose --print-certs "$2/Rocento-device.apk" > "$2/signature-verification.txt"
"$tools/zipalign" -c -P 16 4 "$2/Rocento-device.apk"
python3 "$root/commerce-mobile-apps/tools/check_android_signing.py" "$2/Rocento-device.apk" \
  --package-id com.rocento.grocery --release "${baseline_args[@]}" \
  --report "$2/signing-check.json"
shasum -a 256 "$2/Rocento-device.apk" > "$2/SHA256SUMS"
echo "Signed APK and certificate verification saved in $2"
