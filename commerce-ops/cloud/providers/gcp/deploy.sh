#!/usr/bin/env bash
# Stage the reviewed checkout on a Google Compute Engine VM and invoke the
# existing production activation gate. Public keys belong in GCP metadata;
# private keys and deployment configuration stay local and ignored by Git.
set -Eeuo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)
SECRETS_DIR="$ROOT/.local/commerce-ops/secrets/gcp"
CONFIG="$ROOT/.local/commerce-ops/targets/production-gcp.env"
SSH_KEY="${GCLOUD_SSH_KEY:-}"
PROJECT="${GCLOUD_PROJECT:-}"
ZONE="${GCLOUD_ZONE:-}"
INSTANCE="${GCLOUD_INSTANCE:-}"
HOST="${GCLOUD_HOST:-}"
USER=ubuntu
REMOTE=/opt/rocento
PRESERVE_AI=0
DRY_RUN=0
STAGE=configuration
UPLOAD=
TRANSPORT_DIR=
START_SECONDS=$SECONDS

usage() {
  cat <<'HELP'
Usage: bash commerce-ops/cloud/providers/gcp/deploy.sh [options]

Stages this checkout on a Compute Engine VM and runs the same locked,
evidence-gated production activation used by the existing server deployment.
It never uploads a private key to Google Cloud or stores one in this repo.

Target settings come from .local/commerce-ops/targets/production-gcp.env or GCLOUD_* variables:
  GCLOUD_PROJECT, GCLOUD_ZONE, GCLOUD_INSTANCE, GCLOUD_HOST, GCLOUD_SSH_KEY
  --preserve-ai  Keep the existing production AI services and release.
  --dry-run      Preview filtered source and migration uploads only.
  -h, --help     Show this help.

The target must accept SSH as user ubuntu (add only the public key to GCE
metadata), have sudo, and be prepared with the root-owned release authorization
packet and exact qualified ARM64 artifacts. See commerce-ops/cloud/providers/gcp/README.md.
HELP
}

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '[INFO] %s\n' "$*"; }

. "$ROOT/commerce-ops/cloud/providers/gcp/target.sh"

[[ ! -L $CONFIG ]] || fail "Target file must not be a symlink: $CONFIG"
if [[ ${ROCENTO_TARGET_RESOLVED:-0} != 1 && -f $CONFIG && ! -L $CONFIG ]]; then
  load_gcp_target
fi
while (($#)); do
  case "$1" in
    --project) (($# >= 2)) || fail 'Missing value for --project'; PROJECT=$2; shift ;;
    --zone) (($# >= 2)) || fail 'Missing value for --zone'; ZONE=$2; shift ;;
    --instance) (($# >= 2)) || fail 'Missing value for --instance'; INSTANCE=$2; shift ;;
    --host) (($# >= 2)) || fail 'Missing value for --host'; HOST=$2; shift ;;
    --key) (($# >= 2)) || fail 'Missing value for --key'; SSH_KEY=$2; shift ;;
    --preserve-ai) PRESERVE_AI=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
  shift
done

if [[ -z $HOST ]]; then
  [[ -n $PROJECT && -n $ZONE && -n $INSTANCE ]] || fail 'Set GCLOUD_PROJECT, GCLOUD_ZONE, GCLOUD_INSTANCE (or GCLOUD_HOST) in .local/commerce-ops/targets/production-gcp.env.'
  command -v gcloud >/dev/null 2>&1 || fail 'Install Google Cloud CLI or provide GCLOUD_HOST.'
  HOST=$(gcloud compute instances describe "$INSTANCE" --project "$PROJECT" --zone "$ZONE" --format='get(networkInterfaces[0].accessConfigs[0].natIP)') || fail 'Could not resolve the VM external IP with gcloud. Check project, zone, instance, and local gcloud login.'
  [[ -n $HOST ]] || fail 'The VM has no external IPv4 address. Set GCLOUD_HOST only if the target is reachable by SSH.'
fi
[[ $HOST =~ ^[A-Za-z0-9.-]+$ ]] || fail 'GCLOUD_HOST must be a hostname or IP address.'
[[ $HOST =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail 'For the production direct-origin validation, GCLOUD_HOST must be the VM external IPv4 address.'
[[ $USER == ubuntu ]] || fail 'The current production activation expects the VM SSH account to be named ubuntu.'
if [[ -n $SSH_KEY && $SSH_KEY != /* ]]; then SSH_KEY="$ROOT/$SSH_KEY"; fi
[[ -n $SSH_KEY && -r $SSH_KEY ]] || fail 'Set GCLOUD_SSH_KEY to the local private-key path. Add its matching public key to GCE project or instance SSH metadata; never upload the private key.'
command -v ssh >/dev/null && command -v rsync >/dev/null || fail 'Local ssh and rsync are required.'
command -v python3 >/dev/null || fail 'Python 3 is required for deployment status monitoring.'
[[ -r "$ROOT/commerce-ops/cloud/lib/source-filters.sh" ]] || fail 'Deployment source filters are missing.'

BOOTSTRAP="$SECRETS_DIR/bootstrap.env"
ORIGIN_CERT="$SECRETS_DIR/origin.pem"
ORIGIN_KEY="$SECRETS_DIR/origin.key"
(( DRY_RUN )) || {
  [[ -f $BOOTSTRAP ]] || fail 'Create .local/commerce-ops/secrets/gcp/bootstrap.env from commerce-ops/deploy/ec2/bootstrap.env.example.'
  bootstrap_mode=$(stat -f '%Lp' "$BOOTSTRAP" 2>/dev/null || stat -c '%a' "$BOOTSTRAP")
  [[ $bootstrap_mode == 600 ]] || fail '.local/commerce-ops/secrets/gcp/bootstrap.env must have mode 600.'
  [[ -s $ORIGIN_CERT && -s $ORIGIN_KEY ]] || fail 'Place the Cloudflare Origin CA certificate and matching private key in .local/commerce-ops/secrets/gcp/origin.pem and .local/commerce-ops/secrets/gcp/origin.key.'
  cert_mode=$(stat -f '%Lp' "$ORIGIN_CERT" 2>/dev/null || stat -c '%a' "$ORIGIN_CERT")
  key_mode=$(stat -f '%Lp' "$ORIGIN_KEY" 2>/dev/null || stat -c '%a' "$ORIGIN_KEY")
  [[ $cert_mode == 600 && $key_mode == 600 ]] || fail 'origin.pem and origin.key must both have mode 600.'
}

. "$ROOT/commerce-ops/cloud/lib/source-filters.sh"
. "$ROOT/commerce-ops/cloud/lib/transport.sh"
. "$ROOT/commerce-ops/cloud/lib/jobs.sh"
configure_source_filters
configure_workstation_transport "$SSH_KEY" -az rocento-gcp-deploy 1 "$DRY_RUN"

cleanup() {
  local status=$?
  close_workstation_transport
  if (( status != 0 )); then
    printf 'ERROR: Deployment stopped during %s. The production activation gate must pass before live source changes.\n' "$STAGE" >&2
  fi
}
trap cleanup EXIT

STAGE=ssh-connection
info "Connecting to $USER@$HOST (GCE project=${PROJECT:-unspecified}, zone=${ZONE:-unspecified})"
retry_transfer "${SSH[@]}" 'test "$(id -un)" = ubuntu && sudo -n true && command -v rsync >/dev/null' || fail 'SSH preflight failed. Confirm GCE metadata contains the matching public key for user ubuntu, OS Login is configured accordingly, and ubuntu has passwordless sudo plus rsync.'

if (( DRY_RUN )); then
  "${SSH[@]}" "test -d '$REMOTE'" || fail 'Dry-run requires an existing /opt/rocento checkout.'
  STAGE=upload-preview
  retry_transfer rsync "${RSYNC_OPTIONS[@]}" --delete "${SOURCE_FILTERS[@]}" "$ROOT/" "$USER@$HOST:$REMOTE/"
  retry_transfer rsync "${RSYNC_OPTIONS[@]}" --delete "$ROOT/commerce-api/rocento-api/migrations/" "$USER@$HOST:$REMOTE/commerce-api/rocento-api/migrations/"
  info "Upload preview completed in $((SECONDS - START_SECONDS))s; no activation was started."
  exit 0
fi

STAGE=staging-directory
create_deployment_stage

info "Staging filtered source at $UPLOAD; active source remains unchanged"
stage_managed_source direct

STAGE=configuration-upload
retry_transfer scp "${SSH_OPTIONS[@]}" "$BOOTSTRAP" "$ORIGIN_CERT" "$ORIGIN_KEY" "$USER@$HOST:$UPLOAD/config/"
if (( PRESERVE_AI )); then "${SSH[@]}" "touch '$UPLOAD/preserve-ai'"; fi
"${SSH[@]}" "printf '%s\\n' '$HOST' > '$UPLOAD/origin-ip' && chmod 600 '$UPLOAD/config/'* '$UPLOAD/origin-ip' && touch '$UPLOAD/ready'"

STAGE=production-activation
info "Starting evidence-gated production activation job $DEPLOY_JOB"
monitor_deployment_job
info "Google Cloud deployment completed in $((SECONDS - START_SECONDS))s."
