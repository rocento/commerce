#!/usr/bin/env bash
# Preview/apply grocery configurable sizes and 20 distinct new products.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)
. "$ROOT/commerce-ops/cloud/providers/aws/target.sh"
MODE=''
PHASE=all
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) MODE=--apply; shift ;;
    --phase) PHASE=${2:?Expected all, families or products}; shift 2 ;;
    *) echo 'Usage: bash commerce-ops/cloud/providers/aws/update-grocery-catalog.sh [--apply] [--phase all|families|products]' >&2; exit 2 ;;
  esac
done
case "$PHASE" in all|families|products) ;; *) echo 'Invalid phase' >&2; exit 2 ;; esac
load_aws_target
SSH_OPTIONS=(-i "$ROOT/.local/commerce-ops/secrets/aws/rocento.pem" -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=20 -o ServerAliveInterval=15)
HOST="ubuntu@$AWS_HOST"
BUNDLE=$(mktemp /tmp/rocento-grocery.XXXXXX)
REMOTE=''
cleanup() {
  rm -f "$BUNDLE"
  if [[ $REMOTE == /tmp/rocento-grocery.* ]]; then
    ssh "${SSH_OPTIONS[@]}" "$HOST" "rm -rf -- '$REMOTE'" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$BUNDLE" -C "$ROOT" commerce-ops/workflows/demo/update-grocery-catalog.py commerce-assets/demo/grocery-expansion-20260929
REMOTE=$(ssh "${SSH_OPTIONS[@]}" "$HOST" 'mktemp -d /tmp/rocento-grocery.XXXXXX')
[[ $REMOTE =~ ^/tmp/rocento-grocery\.[a-zA-Z0-9]+$ ]] || { echo 'Unexpected remote temporary directory' >&2; exit 1; }
scp "${SSH_OPTIONS[@]}" "$BUNDLE" "$HOST:$REMOTE/catalog.tar.gz"
ssh "${SSH_OPTIONS[@]}" "$HOST" \
  "tar -xzf '$REMOTE/catalog.tar.gz' -C '$REMOTE' && cd /opt/rocento && sudo python3 '$REMOTE/commerce-ops/workflows/demo/update-grocery-catalog.py' --root /opt/rocento --assets '$REMOTE/commerce-assets/demo/grocery-expansion-20260929' --phase '$PHASE' $MODE"
