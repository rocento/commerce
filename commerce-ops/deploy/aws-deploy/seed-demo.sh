#!/usr/bin/env bash
# Run demo seeding on the existing EC2 deployment from the local checkout.
set -Eeuo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
KEY="$ROOT/commerce-ops/deploy/aws-deploy/rocento.pem"
HOST=3.78.102.161
SSH_USER=ubuntu
REMOTE=/opt/rocento
STORE=all
DELIVERY_ONLY=0
EXPAND_COVERAGE=0
SEED_OPTIONS=
DELIVERY_AREAS="$ROOT/commerce-demo/egypt-delivery-areas.json"
SEED_FILES=(
  commerce-ops/deploy/ec2/server/ec2-seed-demo.sh
  commerce-ops/deploy/ec2/server/repository-root.sh
  commerce-ops/scripts/seed-demo-storefront.py commerce-ops/scripts/demo_presets.py
  commerce-ops/scripts/demo/seed-demo-storefront.py commerce-ops/scripts/demo/demo_presets.py
  commerce-ops/scripts/demo/sync-grocery-palette.py commerce-ops/scripts/demo/grocery_palette.py
  commerce-ops/scripts/sync-grocery-palette.py commerce-ops/scripts/grocery_palette.py
  commerce-assets/demo/demo_seed.py commerce-assets/demo/seed-category-images.py commerce-assets/demo/seed-delivery-areas.py
)
UPLOAD=
SEED_DATA=(commerce-demo/egypt-delivery-areas.json)
cleanup() {
  local status=$?
  [[ -z $UPLOAD ]] || rm -f -- "$UPLOAD"
  exit "$status"
}
trap cleanup EXIT

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Usage: bash commerce-ops/deploy/aws-deploy/seed-demo.sh [--store all|grocery|jewelry|electronics|pharmacy] [--delivery-only] [--expand-coverage]

Run from your local machine. Connects to EC2 with commerce-ops/deploy/aws-deploy/rocento.pem
and runs the standalone seed using the protected configuration already on EC2.
Uploads the current seeding helpers, selected demo presets/assets and local
delivery-area JSON. Grocery seeding deactivates the previous 50-product demo
after the replacement products are seeded.
Default: all stores. Does not upload application code, build or restart services.
Requires an existing EC2 deployment; no redeployment is needed to update these helpers.
--delivery-only seeds areas, sources, stock pools and inventory for existing demo products.
--expand-coverage adds missing Egypt demo zones alongside existing custom areas;
requires --delivery-only. Existing areas and source links are preserved.
HELP
}
while (($#)); do
  case "$1" in
    --delivery-only) DELIVERY_ONLY=1; shift ;;
    --expand-coverage) EXPAND_COVERAGE=1; shift ;;
    --store)
      (($# >= 2)) || fail 'Missing store after --store.'
      case "$2" in all|grocery|jewelry|electronics|pharmacy) STORE=$2 ;; *) fail "Unknown store: $2" ;; esac
      shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1. Run --help for usage." ;;
  esac
done
if (( EXPAND_COVERAGE && ! DELIVERY_ONLY )); then
  fail '--expand-coverage requires --delivery-only.'
fi
if (( DELIVERY_ONLY )); then SEED_OPTIONS='--delivery-only'; fi
if (( EXPAND_COVERAGE )); then SEED_OPTIONS="$SEED_OPTIONS --expand-coverage"; fi
STORES=(grocery jewelry electronics pharmacy)
[[ $STORE == all ]] || STORES=("$STORE")
for store in "${STORES[@]}"; do
  SEED_DATA+=("commerce-demo/$store/preset.json" "commerce-demo/$store/theme.json")
  if [[ $store == grocery ]]; then
    SEED_DATA+=(commerce-assets/demo/Grocery-Items)
  else
    SEED_DATA+=("commerce-assets/demo/$store")
  fi
  if (( ! DELIVERY_ONLY )); then
    command -v python3 >/dev/null || fail 'Python 3 is required to validate demo seed assets.'
    python3 "$ROOT/commerce-ops/scripts/seed-demo-storefront.py" "$store" >/dev/null
  fi
done
if (( ! DELIVERY_ONLY )) && [[ $STORE == all || $STORE == jewelry ]]; then
  SEED_DATA+=(commerce-assets/demo/categories)
fi
[[ -r $KEY ]] || fail "Missing SSH key: $KEY"
[[ -s $DELIVERY_AREAS ]] || fail "Missing delivery-area definitions: $DELIVERY_AREAS"
command -v ssh >/dev/null || fail 'OpenSSH is required.'
command -v tar >/dev/null || fail 'tar is required.'
for file in "${SEED_FILES[@]}"; do
  [[ -s $ROOT/$file ]] || fail "Missing seed helper: $ROOT/$file"
done
UPLOAD=$(mktemp)
# Build the complete upload before connecting so an archive failure cannot seed.
COPYFILE_DISABLE=1 tar --format=ustar --no-xattrs -cf "$UPLOAD" -C "$ROOT" "${SEED_FILES[@]}" "${SEED_DATA[@]}"
chmod 400 "$KEY"
printf '[INFO] Running %s demo seed on %s; no deployment will run.\n' "$STORE" "$HOST"
printf '[INFO] Uploading current seeding helpers and local demo delivery areas through SSH.\n'

# Do not retry a seed command: a lost connection may follow committed writes.
if ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
  -o ConnectTimeout=20 -o ConnectionAttempts=3 \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  "$SSH_USER@$HOST" "
set -eu
if ! test -f '$REMOTE/deploy/ec2/server/ec2-bootstrap.sh' || ! test -d '$REMOTE/deploy/ec2'; then
  printf '%s\\n' 'An EC2 deployment is required. Run bash commerce-ops/deploy/aws-deploy/deploy.sh locally once, then retry.' >&2
  exit 1
fi
work=\$(mktemp -d)
trap 'rm -rf -- \"\$work\"' EXIT
tar -xf - -C \"\$work\"
# Install only seed helpers, under the same lock used by deployment and seeding.
sudo -n bash -c '
  set -eu
  exec 9>\"\$1/deploy/ec2/setup.lock\"
  flock -n 9 || { printf \"%s\\n\" \"Another deployment or seed is active. Wait for it to finish.\" >&2; exit 1; }
  install -d \"\$1/deploy/ec2/server\" \"\$1/commerce-ops/deploy/ec2/server\" \"\$1/commerce-ops/scripts\" \"\$1/commerce-ops/scripts/demo\" \"\$1/commerce-assets/demo\"
  for file in ${SEED_FILES[*]}; do
    install -m 644 \"\$2/\$file\" \"\$1/\$file\"
  done
  install -D -m 755 \"\$2/commerce-ops/deploy/ec2/server/ec2-seed-demo.sh\" \"\$1/deploy/ec2/server/ec2-seed-demo.sh\"
  install -D -m 644 \"\$2/commerce-ops/deploy/ec2/server/repository-root.sh\" \"\$1/deploy/ec2/server/repository-root.sh\"
  install -d \"\$1/commerce-demo\" \"\$1/commerce-assets/demo\"
  cp -a \"\$2/commerce-demo/.\" \"\$1/commerce-demo/\"
  cp -a \"\$2/commerce-assets/demo/.\" \"\$1/commerce-assets/demo/\"
' seed-helper-upload '$REMOTE' \"\$work\"
sudo -n bash '$REMOTE/deploy/ec2/server/ec2-seed-demo.sh' --store '$STORE' --delivery-areas-stdin $SEED_OPTIONS < \"\$work/commerce-demo/egypt-delivery-areas.json\"
" < "$UPLOAD"; then
  printf '[OK] Demo seeding complete for %s.\n' "$STORE"
else
  status=$?
  printf 'ERROR: Remote demo seed failed (exit %s). No automatic retry was attempted. Check the output above and /var/log/rocento/seeds/ on EC2 before rerunning.\n' "$status" >&2
  exit "$status"
fi
