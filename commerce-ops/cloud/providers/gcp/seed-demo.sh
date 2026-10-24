#!/usr/bin/env bash
# Resolve the GCP workstation target, then use the shared demo-seed workflow.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)
if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  exec bash "$ROOT/commerce-ops/cloud/seed-demo.sh" --provider gcp --host help --key help --help
fi
CONFIG="$ROOT/.local/commerce-ops/targets/production-gcp.env"
HOST=${GCLOUD_HOST:-}
SSH_KEY=${GCLOUD_SSH_KEY:-}
PROJECT=${GCLOUD_PROJECT:-}
ZONE=${GCLOUD_ZONE:-}
INSTANCE=${GCLOUD_INSTANCE:-}
SEED_ARGS=()

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
while (($#)); do
  case "$1" in
    --host) (($# >= 2)) || fail 'Missing value for --host'; HOST=$2; shift 2 ;;
    --key) (($# >= 2)) || fail 'Missing value for --key'; SSH_KEY=$2; shift 2 ;;
    *) SEED_ARGS+=("$1"); shift ;;
  esac
done
. "$ROOT/commerce-ops/cloud/providers/gcp/target.sh"
if [[ ( -z $HOST || -z $SSH_KEY ) && -f $CONFIG ]]; then
  load_gcp_target
fi
if [[ -z $HOST ]]; then
  [[ -n $PROJECT && -n $ZONE && -n $INSTANCE ]] || fail 'Set GCLOUD_HOST or GCLOUD_PROJECT, GCLOUD_ZONE, and GCLOUD_INSTANCE.'
  command -v gcloud >/dev/null 2>&1 || fail 'Install Google Cloud CLI or provide GCLOUD_HOST.'
  HOST=$(gcloud compute instances describe "$INSTANCE" --project "$PROJECT" --zone "$ZONE" --format='get(networkInterfaces[0].accessConfigs[0].natIP)') || fail 'Could not resolve the VM external IP with gcloud.'
fi
[[ $HOST =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail 'GCP demo seeding requires the VM direct-origin IPv4 address.'
[[ -n $SSH_KEY ]] || fail 'Set GCLOUD_SSH_KEY or SSH_KEY in the GCP target file.'
if [[ $SSH_KEY != /* ]]; then SSH_KEY="$ROOT/$SSH_KEY"; fi
exec bash "$ROOT/commerce-ops/cloud/seed-demo.sh" --provider gcp --host "$HOST" --key "$SSH_KEY" "${SEED_ARGS[@]}"
