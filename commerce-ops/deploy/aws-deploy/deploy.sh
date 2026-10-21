#!/usr/bin/env bash
# Upload the current project safely, preserve EC2 data/secrets, then deploy.
set -Eeuo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
DEPLOY_DIR="$ROOT/commerce-ops/deploy/aws-deploy"
KEY="$DEPLOY_DIR/rocento.pem"
BOOTSTRAP="$DEPLOY_DIR/bootstrap.env"
ORIGIN_CERT="$DEPLOY_DIR/rocento-origin.pem"
ORIGIN_KEY="$DEPLOY_DIR/rocento-origin.key"
HOST=3.78.102.161
USER=ubuntu
REMOTE=/opt/rocento
STAGE=configuration
TRANSPORT_DIR=
UPLOAD=
SYNC_LANGUAGE_SOURCE=
LANGUAGE_RELEASE_ID=
PRESERVE_AI=0
EXPLICIT_PRESERVE_AI=0
INCLUDE_AI=0
DRY_RUN=0
START_SECONDS=$SECONDS

usage() {
  cat <<'HELP'
Usage: bash commerce-ops/deploy/aws-deploy/deploy.sh [--dry-run] [--preserve-ai | --include-ai | --sync-language-data | --sync-language-db --release-id UUID]

Default: deploy commerce, frontend and AI together under the server lock.
AI deployment requires a verified bundle matching the packaged runtime.
  --dry-run             Preview source/migration transfers; no remote changes or build.
  --preserve-ai         Opt out of AI deployment; keep running production AI.
  --include-ai          Include AI (default); requires a valid runtime-matching release bundle.
  --sync-language-data  Verify an existing versioned Language Engine bundle.
  --sync-language-db    Export the explicit immutable database release selected by --release-id.
  --release-id UUID     Required with --sync-language-db; never activates a release.
  -h, --help            Show this help.

Unchanged files are copied from the server checkout into the isolated stage. Demo assets/data use the separate seed command:
bash commerce-ops/deploy/aws-deploy/seed-demo.sh --store all
HELP
}

. "$ROOT/commerce-ops/deploy/ec2/server/ec2-source-filters.sh"

# Sharing one authenticated connection avoids another TCP handshake for each upload.
configure_transport() {
  local rsync_version archive_options=-az
  rsync_version=$(rsync --version) || fail 'Cannot identify the local rsync implementation.'
  # Apple's bundled OpenRSYNC uses the older protocol. Keep its transfers
  # uncompressed when talking to upstream rsync; delta/partial resume still apply.
  if [[ $rsync_version == *openrsync* ]]; then
    archive_options=-a
    info 'Apple OpenRSYNC detected; using uncompressed transfers for compatibility'
  fi
  TRANSPORT_DIR=$(mktemp -d /tmp/rocento-deploy.XXXXXX)
  SSH_OPTIONS=(-i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new
    -o ConnectTimeout=20 -o ConnectionAttempts=3
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3
    -o ControlMaster=auto -o ControlPersist=120 -o "ControlPath=$TRANSPORT_DIR/control")
  SSH=(ssh "${SSH_OPTIONS[@]}" "$USER@$HOST")
  SCP=(scp "${SSH_OPTIONS[@]}")
  RSYNC_SSH="ssh -i \"$KEY\" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o ConnectionAttempts=3 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ControlMaster=auto -o ControlPersist=120 -o ControlPath=$TRANSPORT_DIR/control"
  RSYNC_OPTIONS=("$archive_options" --partial --partial-dir=.rsync-partial --timeout=120 --stats
    --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r -e "$RSYNC_SSH")
  if (( DRY_RUN )); then
    RSYNC_OPTIONS+=(--dry-run --itemize-changes)
  else
    RSYNC_OPTIONS+=(--progress)
  fi
}

reset_transfer_connection() {
  [[ -n $TRANSPORT_DIR ]] || return 0
  # This socket belongs only to this launcher. A failed transfer must not
  # carry a broken multiplexed session into its next attempt.
  ssh -o BatchMode=yes -S "$TRANSPORT_DIR/control" -O exit "$USER@$HOST" >/dev/null 2>&1 || true
  rm -f -- "$TRANSPORT_DIR/control" || true
}

cleanup_transport() {
  local status=$?
  if [[ -n $TRANSPORT_DIR ]]; then
    reset_transfer_connection
    rm -rf -- "$TRANSPORT_DIR"
  fi
  if (( status != 0 )); then
    printf 'ERROR: Deployment stopped during %s (exit %s).\n' "$STAGE" "$status" >&2
    if [[ $STAGE == ssh-connection ]]; then
      printf 'No source upload or demo seeding started. Check EC2 reachability and TCP 22 access from your current IP, then rerun the same command.\n' >&2
    elif [[ $STAGE == source-upload || $STAGE == migration-source-upload ]]; then
      printf 'The active checkout was not changed. Staging directory: %s. Rerun to create a fresh stage.\n' "$UPLOAD" >&2
    fi
  fi
}
trap cleanup_transport EXIT

# Retry only transfers; the detached deployment is launched once and monitored.
retry_transfer() {
  local attempt status
  for attempt in 1 2 3; do
    if "$@"; then return 0; else status=$?; fi
    case "$status" in
      10|12|30|35|255) ;;
      *) return "$status" ;;
    esac
    (( attempt < 3 )) || return "$status"
    printf '[INFO] Transfer interrupted (exit %s); reconnecting and retrying %s/3.\n' "$status" "$((attempt + 1))"
    reset_transfer_connection
    sleep 2
  done
}

# A root-owned/unreadable comparison file must not require mutating live source
# permissions. Retry once without the optional server-side comparison tree.
stage_transfer() {
  local basis=$1 status
  shift
  if retry_transfer rsync "${RSYNC_OPTIONS[@]}" --copy-dest="$basis" "$@"; then
    return 0
  else
    status=$?
  fi
  [[ $status == 23 ]] || return "$status"
  info 'Staging could not read all comparison files; retrying without --copy-dest'
  retry_transfer rsync "${RSYNC_OPTIONS[@]}" "$@"
}

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '[INFO] %s\n' "$*"; }
while (($#)); do
  case "$1" in
    --seed-electronics|--seed-demo) fail 'Seeding is separate. Run locally: bash commerce-ops/deploy/aws-deploy/seed-demo.sh --store all (or electronics). This invokes the protected server seed command on EC2.' ;;
    --skip-seed) : ;; # Backward compatibility; deployment never seeds.
    --sync-language-data) [[ -z $SYNC_LANGUAGE_SOURCE ]] || fail 'Choose only one Language Engine data source.'; SYNC_LANGUAGE_SOURCE=files ;;
    --sync-language-db) [[ -z $SYNC_LANGUAGE_SOURCE ]] || fail 'Choose only one Language Engine data source.'; SYNC_LANGUAGE_SOURCE=database ;;
    --release-id) [[ $# -ge 2 ]] || fail 'Missing --release-id value.'; LANGUAGE_RELEASE_ID=$2; shift ;;
    --preserve-ai) EXPLICIT_PRESERVE_AI=1 ;;
    --include-ai) INCLUDE_AI=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
  shift
done
[[ $DRY_RUN == 0 || -z $SYNC_LANGUAGE_SOURCE ]] || fail '--dry-run cannot export language data; package the release separately before previewing.'
[[ $EXPLICIT_PRESERVE_AI == 0 || $INCLUDE_AI == 0 ]] || fail '--preserve-ai cannot be combined with --include-ai.'
[[ $EXPLICIT_PRESERVE_AI == 0 || -z $SYNC_LANGUAGE_SOURCE ]] || fail '--preserve-ai cannot be combined with language export options.'
if [[ $EXPLICIT_PRESERVE_AI == 1 ]]; then PRESERVE_AI=1; fi
[[ $SYNC_LANGUAGE_SOURCE == database || -z $LANGUAGE_RELEASE_ID ]] || fail '--release-id requires --sync-language-db.'
[[ $SYNC_LANGUAGE_SOURCE != database || $LANGUAGE_RELEASE_ID =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]] || fail '--sync-language-db requires --release-id <immutable-release-uuid>.'
[[ -r $KEY ]] || fail "Missing SSH key: $KEY"
(( DRY_RUN )) || chmod 400 "$KEY"
[[ -f $BOOTSTRAP ]] || fail "Missing $BOOTSTRAP. Copy commerce-ops/deploy/aws-deploy/bootstrap.env.example, fill it, then chmod 600 it."
[[ $(stat -f '%Lp' "$BOOTSTRAP") == 600 ]] || fail "$BOOTSTRAP must have mode 600. Run: chmod 600 $BOOTSTRAP"
[[ -s $ORIGIN_CERT && -s $ORIGIN_KEY ]] || fail "Cloudflare Origin CA files are required: $ORIGIN_CERT and $ORIGIN_KEY. Create a certificate for rocento.com and *.rocento.com in Cloudflare → SSL/TLS → Origin Server, save the PEM files here, and run chmod 600 on both."

# Validate only the non-secret file structure locally. The EC2 deployment does
# full certificate/key and hostname validation before it builds anything.
grep -q '^DOMAIN=rocento.com$' "$BOOTSTRAP" || fail 'bootstrap.env must set DOMAIN=rocento.com.'
for optional in notifications.env contact.env; do
  [[ ! -f "$DEPLOY_DIR/$optional" || $(stat -f '%Lp' "$DEPLOY_DIR/$optional") == 600 ]] || fail "commerce-ops/deploy/aws-deploy/$optional must have mode 600."
done
if [[ -n $SYNC_LANGUAGE_SOURCE ]]; then
  STAGE=language-release-export
  command -v node >/dev/null 2>&1 || fail 'Node.js is required to export the Language Engine release.'
  info "Validating and packaging the local Language Engine $SYNC_LANGUAGE_SOURCE release"
  if [[ $SYNC_LANGUAGE_SOURCE == database ]]; then
    node "$ROOT/commerce-assistant-platform/app/commerce_language_engine/scripts/export-db-release.ts" --release-id "$LANGUAGE_RELEASE_ID"
  else
    node "$ROOT/commerce-assistant-platform/app/commerce_language_engine/scripts/export-release.ts"
  fi
fi
STAGE=language-release-validation
command -v python3 >/dev/null 2>&1 || fail 'Python 3 is required to monitor the remote deployment.'
if (( PRESERVE_AI )); then
  info 'Preserving running production AI; local AI source and language bundles will not be deployed'
else
  command -v node >/dev/null 2>&1 || fail 'Node.js is required to validate the Language Engine release.'
  info 'Validating Language Engine image inputs before uploading source'
  node "$ROOT/commerce-assistant-platform/app/commerce_language_engine/scripts/check-release.ts" || fail 'Local AI source and release bundle are incompatible. Use --preserve-ai to retain production AI, or export a reviewed release matching this runtime with --sync-language-db --release-id UUID. --sync-language-data only verifies an existing bundle.'
fi
configure_transport
configure_source_filters
STAGE=ssh-connection
info "Connecting to $USER@$HOST"
if (( DRY_RUN )); then
  "${SSH[@]}" "test -d '$REMOTE'" || fail 'Upload preview requires an existing remote checkout. Run a normal deployment to provision it.'
  STAGE=upload-preview
  info 'Previewing changed source files (no remote files will be written)'
  retry_transfer rsync "${RSYNC_OPTIONS[@]}" --delete "${SOURCE_FILTERS[@]}" "$ROOT/" "$USER@$HOST:$REMOTE/"
  info 'Previewing the exact migration mirror, including removed migration filenames'
  retry_transfer rsync "${RSYNC_OPTIONS[@]}" --delete "$ROOT/commerce-api/rocento-api/migrations/" "$USER@$HOST:$REMOTE/commerce-api/rocento-api/migrations/"
  info 'Normal deployment also installs protected TLS/configuration files; their contents are omitted from this preview.'
  info "Upload preview completed in $((SECONDS - START_SECONDS))s; remote deployment was not started."
  exit 0
fi
# Each upload is private to one job. Nothing in the active checkout changes here.
DEPLOY_JOB="$(date -u +%Y%m%dT%H%M%SZ)-$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
UPLOAD="/home/$USER/.rocento-deploy/$DEPLOY_JOB"
"${SSH[@]}" "install -d -m 700 '/home/$USER/.rocento-deploy' && mkdir -m 700 '$UPLOAD' && mkdir -m 700 '$UPLOAD/source' '$UPLOAD/config'"

STAGE=source-upload
UPLOAD_SECONDS=$SECONDS
info "Staging deployment inputs in $UPLOAD; the active checkout remains unchanged"
# --copy-dest reuses unchanged server bytes without mutable hard links.
stage_transfer "$REMOTE" "${SOURCE_FILTERS[@]}" "$ROOT/" "$USER@$HOST:$UPLOAD/source/"

STAGE=migration-source-upload
info 'Staging the complete migration inventory; activation backs up and mirrors it under the lock'
stage_transfer "$REMOTE/commerce-api/rocento-api/migrations" --delete \
  "$ROOT/commerce-api/rocento-api/migrations/" "$USER@$HOST:$UPLOAD/source/commerce-api/rocento-api/migrations/"

STAGE=deployment-configuration-upload
info 'Staging protected TLS/configuration'
retry_transfer "${SCP[@]}" \
  "$ORIGIN_CERT" "$ORIGIN_KEY" "$BOOTSTRAP" "$USER@$HOST:$UPLOAD/config/"
for optional in notifications.env contact.env; do
  if [[ -f "$DEPLOY_DIR/$optional" ]]; then
    retry_transfer "${SCP[@]}" "$DEPLOY_DIR/$optional" "$USER@$HOST:$UPLOAD/config/$optional"
  fi
done
if (( PRESERVE_AI )); then
  "${SSH[@]}" "touch '$UPLOAD/preserve-ai'"
fi
"${SSH[@]}" "chmod 600 '$UPLOAD/config/'* && touch '$UPLOAD/ready'"

STAGE=remote-deployment
info "Upload completed in $((SECONDS - UPLOAD_SECONDS))s; starting remote deployment without demo seeding"
# Independent status connections can reconnect without a stale shared socket.
# systemd owns the deployment after the launch request finishes.
MONITOR_SSH=(ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=20 -o ConnectionAttempts=3
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3
  -o ControlMaster=no -o ControlPath=none "$USER@$HOST")
python3 "$ROOT/commerce-ops/deploy/ec2/server/ec2-deploy-job.py" monitor "$DEPLOY_JOB" --source "$UPLOAD" --ssh "${MONITOR_SSH[@]}"
info "Deployment completed in $((SECONDS - START_SECONDS))s."
