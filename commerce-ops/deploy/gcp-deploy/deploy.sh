#!/usr/bin/env bash
# Stage the reviewed checkout on a Google Compute Engine VM and invoke the
# existing production activation gate. Public keys belong in GCP metadata;
# private keys and deployment configuration stay local and ignored by Git.
set -Eeuo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
DEPLOY_DIR="$ROOT/commerce-ops/deploy/gcp-deploy"
CONFIG="$DEPLOY_DIR/target.env"
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
Usage: bash commerce-ops/deploy/gcp-deploy/deploy.sh [options]

Stages this checkout on a Compute Engine VM and runs the same locked,
evidence-gated production activation used by the existing server deployment.
It never uploads a private key to Google Cloud or stores one in this repo.

Target settings come from commerce-ops/deploy/gcp-deploy/target.env or GCLOUD_* variables:
  GCLOUD_PROJECT, GCLOUD_ZONE, GCLOUD_INSTANCE, GCLOUD_HOST, GCLOUD_SSH_KEY
  --preserve-ai  Keep the existing production AI services and release.
  --dry-run      Preview filtered source and migration uploads only.
  -h, --help     Show this help.

The target must accept SSH as user ubuntu (add only the public key to GCE
metadata), have sudo, and be prepared with the root-owned release authorization
packet and exact qualified ARM64 artifacts. See commerce-ops/deploy/gcp-deploy/README.md.
HELP
}

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '[INFO] %s\n' "$*"; }

if [[ -f $CONFIG ]]; then
  # This is a local, ignored operator config. Parse KEY=value without eval.
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || ${line:0:1} == '#' || $line != *=* ]] && continue
    key=${line%%=*}; value=${line#*=}
    case "$key" in
      GCLOUD_PROJECT) PROJECT=${PROJECT:-$value} ;;
      GCLOUD_ZONE) ZONE=${ZONE:-$value} ;;
      GCLOUD_INSTANCE) INSTANCE=${INSTANCE:-$value} ;;
      GCLOUD_HOST) HOST=${HOST:-$value} ;;
      GCLOUD_SSH_KEY) SSH_KEY=${SSH_KEY:-$value} ;;
      *) fail "Unsupported target.env key: $key" ;;
    esac
  done < "$CONFIG"
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
  [[ -n $PROJECT && -n $ZONE && -n $INSTANCE ]] || fail 'Set GCLOUD_PROJECT, GCLOUD_ZONE, GCLOUD_INSTANCE (or GCLOUD_HOST) in commerce-ops/deploy/gcp-deploy/target.env.'
  command -v gcloud >/dev/null 2>&1 || fail 'Install Google Cloud CLI or provide GCLOUD_HOST.'
  HOST=$(gcloud compute instances describe "$INSTANCE" --project "$PROJECT" --zone "$ZONE" --format='get(networkInterfaces[0].accessConfigs[0].natIP)') || fail 'Could not resolve the VM external IP with gcloud. Check project, zone, instance, and local gcloud login.'
  [[ -n $HOST ]] || fail 'The VM has no external IPv4 address. Set GCLOUD_HOST only if the target is reachable by SSH.'
fi
[[ $HOST =~ ^[A-Za-z0-9.-]+$ ]] || fail 'GCLOUD_HOST must be a hostname or IP address.'
[[ $HOST =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail 'For the production direct-origin validation, GCLOUD_HOST must be the VM external IPv4 address.'
[[ $USER == ubuntu ]] || fail 'The current production activation expects the VM SSH account to be named ubuntu.'
[[ -n $SSH_KEY && -r $SSH_KEY ]] || fail 'Set GCLOUD_SSH_KEY to the local private-key path. Add its matching public key to GCE project or instance SSH metadata; never upload the private key.'
command -v ssh >/dev/null && command -v rsync >/dev/null || fail 'Local ssh and rsync are required.'
command -v python3 >/dev/null || fail 'Python 3 is required for deployment status monitoring.'
[[ -r "$ROOT/commerce-ops/deploy/ec2/server/ec2-source-filters.sh" ]] || fail 'Deployment source filters are missing.'

BOOTSTRAP="$DEPLOY_DIR/bootstrap.env"
ORIGIN_CERT="$DEPLOY_DIR/origin.pem"
ORIGIN_KEY="$DEPLOY_DIR/origin.key"
(( DRY_RUN )) || {
  [[ -f $BOOTSTRAP ]] || fail 'Create commerce-ops/deploy/gcp-deploy/bootstrap.env from commerce-ops/deploy/ec2/bootstrap.env.example.'
  bootstrap_mode=$(stat -f '%Lp' "$BOOTSTRAP" 2>/dev/null || stat -c '%a' "$BOOTSTRAP")
  [[ $bootstrap_mode == 600 ]] || fail 'commerce-ops/deploy/gcp-deploy/bootstrap.env must have mode 600.'
  [[ -s $ORIGIN_CERT && -s $ORIGIN_KEY ]] || fail 'Place the Cloudflare Origin CA certificate and matching private key in commerce-ops/deploy/gcp-deploy/origin.pem and origin.key.'
  cert_mode=$(stat -f '%Lp' "$ORIGIN_CERT" 2>/dev/null || stat -c '%a' "$ORIGIN_CERT")
  key_mode=$(stat -f '%Lp' "$ORIGIN_KEY" 2>/dev/null || stat -c '%a' "$ORIGIN_KEY")
  [[ $cert_mode == 600 && $key_mode == 600 ]] || fail 'origin.pem and origin.key must both have mode 600.'
}

. "$ROOT/commerce-ops/deploy/ec2/server/ec2-source-filters.sh"
configure_source_filters
TRANSPORT_DIR=$(mktemp -d /tmp/rocento-gcp-deploy.XXXXXX)
chmod 700 "$TRANSPORT_DIR"
SSH_OPTIONS=(-i "$SSH_KEY" -o BatchMode=yes -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20
  -o ConnectionAttempts=3 -o ServerAliveInterval=15 -o ServerAliveCountMax=3
  -o ControlMaster=auto -o ControlPersist=120 -o "ControlPath=$TRANSPORT_DIR/control")
SSH=(ssh "${SSH_OPTIONS[@]}" "$USER@$HOST")
RSYNC_SSH="ssh -i \"$SSH_KEY\" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o ConnectionAttempts=3 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ControlMaster=auto -o ControlPersist=120 -o ControlPath=$TRANSPORT_DIR/control"
RSYNC_OPTIONS=(-az --partial --partial-dir=.rsync-partial --timeout=120 --stats
  --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r -e "$RSYNC_SSH")
(( DRY_RUN )) && RSYNC_OPTIONS+=(--dry-run --itemize-changes) || RSYNC_OPTIONS+=(--progress)

cleanup() {
  local status=$?
  ssh -o BatchMode=yes -S "$TRANSPORT_DIR/control" -O exit "$USER@$HOST" >/dev/null 2>&1 || true
  rm -rf -- "$TRANSPORT_DIR"
  if (( status != 0 )); then
    printf 'ERROR: Deployment stopped during %s. The production activation gate must pass before live source changes.\n' "$STAGE" >&2
  fi
}
trap cleanup EXIT

retry() {
  local attempt status
  for attempt in 1 2 3; do
    if "$@"; then return 0; else status=$?; fi
    case "$status" in 10|12|30|35|255) ;; *) return "$status" ;; esac
    (( attempt < 3 )) || return "$status"
    info "SSH/transfer interrupted (exit $status); retrying $((attempt + 1))/3"
    ssh -o BatchMode=yes -S "$TRANSPORT_DIR/control" -O exit "$USER@$HOST" >/dev/null 2>&1 || true
    sleep 2
  done
}

STAGE=ssh-connection
info "Connecting to $USER@$HOST (GCE project=${PROJECT:-unspecified}, zone=${ZONE:-unspecified})"
retry "${SSH[@]}" 'test "$(id -un)" = ubuntu && sudo -n true && command -v rsync >/dev/null' || fail 'SSH preflight failed. Confirm GCE metadata contains the matching public key for user ubuntu, OS Login is configured accordingly, and ubuntu has passwordless sudo plus rsync.'

if (( DRY_RUN )); then
  "${SSH[@]}" "test -d '$REMOTE'" || fail 'Dry-run requires an existing /opt/rocento checkout.'
  STAGE=upload-preview
  retry rsync "${RSYNC_OPTIONS[@]}" --delete "${SOURCE_FILTERS[@]}" "$ROOT/" "$USER@$HOST:$REMOTE/"
  retry rsync "${RSYNC_OPTIONS[@]}" --delete "$ROOT/commerce-api/rocento-api/migrations/" "$USER@$HOST:$REMOTE/commerce-api/rocento-api/migrations/"
  info "Upload preview completed in $((SECONDS - START_SECONDS))s; no activation was started."
  exit 0
fi

DEPLOY_JOB="$(date -u +%Y%m%dT%H%M%SZ)-$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
UPLOAD="/home/$USER/.rocento-deploy/$DEPLOY_JOB"
STAGE=staging-directory
"${SSH[@]}" "install -d -m 700 '/home/$USER/.rocento-deploy' && mkdir -m 700 '$UPLOAD' && mkdir -m 700 '$UPLOAD/source' '$UPLOAD/config'"

STAGE=source-upload
info "Staging filtered source at $UPLOAD; active source remains unchanged"
retry rsync "${RSYNC_OPTIONS[@]}" --delete "${SOURCE_FILTERS[@]}" "$ROOT/" "$USER@$HOST:$UPLOAD/source/"
STAGE=migration-source-upload
retry rsync "${RSYNC_OPTIONS[@]}" --delete "$ROOT/commerce-api/rocento-api/migrations/" "$USER@$HOST:$UPLOAD/source/commerce-api/rocento-api/migrations/"

STAGE=configuration-upload
retry scp "${SSH_OPTIONS[@]}" "$BOOTSTRAP" "$ORIGIN_CERT" "$ORIGIN_KEY" "$USER@$HOST:$UPLOAD/config/"
if (( PRESERVE_AI )); then "${SSH[@]}" "touch '$UPLOAD/preserve-ai'"; fi
"${SSH[@]}" "printf '%s\\n' '$HOST' > '$UPLOAD/origin-ip' && chmod 600 '$UPLOAD/config/'* '$UPLOAD/origin-ip' && touch '$UPLOAD/ready'"

STAGE=production-activation
info "Starting evidence-gated production activation job $DEPLOY_JOB"
MONITOR_SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20
  -o ConnectionAttempts=3 -o ServerAliveInterval=15 -o ServerAliveCountMax=3
  -o ControlMaster=no -o ControlPath=none "$USER@$HOST")
python3 "$ROOT/commerce-ops/deploy/ec2/server/ec2-deploy-job.py" monitor "$DEPLOY_JOB" \
  --source "$UPLOAD" --ssh "${MONITOR_SSH[@]}"
info "Google Cloud deployment completed in $((SECONDS - START_SECONDS))s."
