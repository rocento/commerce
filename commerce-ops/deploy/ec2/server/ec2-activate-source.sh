#!/usr/bin/env bash
# Install one complete staged upload, then hold the same lock through deployment.
set -Eeuo pipefail
. "$(dirname -- "${BASH_SOURCE[0]}")/repository-root.sh"
SOURCE=$(find_repo_root)
UPLOAD=$(dirname -- "$SOURCE")
ROOT=/opt/rocento
PRESERVE_AI=0
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ ! -f "$UPLOAD/preserve-ai" ]] || PRESERVE_AI=1
if [[ -f "$UPLOAD/origin-ip" ]]; then
  ROCENTO_ORIGIN_IP=$(cat "$UPLOAD/origin-ip")
  [[ $ROCENTO_ORIGIN_IP =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail 'Staged direct-origin address is not an IPv4 address.'
  export ROCENTO_ORIGIN_IP
fi
[[ $EUID == 0 ]] || fail 'Run with sudo.'
[[ -f "$UPLOAD/ready" ]] || fail 'The staged upload is incomplete.'
for directory in commerce-api/rocento-api commerce-web commerce-web/apps/rengine commerce-ops/scripts commerce-ops/deploy commerce-ops/compose commerce-api/rocento-api/migrations; do
  [[ -d "$SOURCE/$directory" && ! -L "$SOURCE/$directory" ]] || fail "Missing staged source directory: $directory"
done
[[ $PRESERVE_AI == 1 || ( -d "$SOURCE/commerce-assistant-platform" && ! -L "$SOURCE/commerce-assistant-platform" ) ]] || fail 'Missing staged AI source.'
for file in commerce-ops/deploy/ec2/server/ec2-up.sh commerce-ops/deploy/ec2/server/ec2-source-filters.sh commerce-ops/deploy/ec2/server/cleanup.py commerce-ops/compose/compose.yaml; do
  [[ -s "$SOURCE/$file" ]] || fail "Missing staged deployment input: $file"
done
for file in bootstrap.env rocento-origin.pem rocento-origin.key; do
  [[ -s "$UPLOAD/config/$file" && ! -L "$UPLOAD/config/$file" ]] || fail "Missing staged configuration: $file"
done

# Keep the existing lock inode so full, AI, rengine and seed jobs serialize.
[[ ! -L "$ROOT" ]] || fail 'The active checkout must not be a symlink.'
mkdir -p "$ROOT"
[[ $(readlink -f "$ROOT") == "$ROOT" ]] || fail 'Unexpected checkout path.'
for directory in deploy deploy/ec2 deploy/ec2/server; do
  [[ ! -L "$ROOT/$directory" ]] || fail "Runtime directory must not be a symlink: $directory"
  mkdir -p "$ROOT/$directory"
done
[[ ! -L "$ROOT/commerce-api" && ! -L "$ROOT/commerce-web" && ! -L "$ROOT/commerce-assistant-platform" && ! -L "$ROOT/commerce-ops/scripts" && ! -L "$ROOT/commerce-ops/deploy" && ! -L "$ROOT/commerce-ops/compose" ]] || fail 'Managed commerce source directories must not be symlinks.'
[[ ! -L "$ROOT/deploy/ec2/setup.lock" ]] || fail 'Deployment lock must not be a symlink.'
exec 9>"$ROOT/deploy/ec2/setup.lock"
flock -n 9 || fail 'Another deployment or seed is active. Wait for it to finish, then rerun the local deployment command.'
export ROCENTO_DEPLOY_LOCK_FD=9
RELEASE_ARGS=(--source "$SOURCE" --operation full --bootstrap "$UPLOAD/config/bootstrap.env")
(( PRESERVE_AI == 0 )) || RELEASE_ARGS+=(--preserve-ai)
python3 "$SOURCE/commerce-ops/scripts/release/deployment_gate.py" check "${RELEASE_ARGS[@]}"
if (( PRESERVE_AI )); then
  [[ -f "$ROOT/deploy/ec2/common.yaml" ]] || fail '--preserve-ai requires an existing deployment.'
  export ROCENTO_AI_BASELINE="$UPLOAD/ai-baseline.json"
  python3 "$SOURCE/commerce-ops/deploy/ec2/server/ec2-preserve-ai.py" snapshot "$ROCENTO_AI_BASELINE"
fi

. "$SOURCE/commerce-ops/deploy/ec2/server/ec2-source-filters.sh"
configure_source_filters
printf '[INFO] Activating staged source under the deployment lock\n'
# Retain the launcher's legacy-workspace cleanup, now serialized with deploys.
rm -rf -- "$ROOT/Rocento-Codex"
BACKUP="/home/ubuntu/.rocento-migration-backups/$(basename -- "$UPLOAD")"
install -d -m 700 "$BACKUP"
if [[ -d "$ROOT/commerce-api/migrations" ]]; then
  mkdir -p "$BACKUP/legacy-root"
  cp -a "$ROOT/commerce-api/migrations/." "$BACKUP/legacy-root/"
fi
if [[ -d "$ROOT/commerce-api/rocento-api/migrations" ]]; then
  mkdir -p "$BACKUP/rocento-api"
  cp -a "$ROOT/commerce-api/rocento-api/migrations/." "$BACKUP/rocento-api/"
fi
# Only managed inputs are mirrored. Excluded receiver files (including the
# lock, secrets, generated YAML, and rengine-private) are never deleted.
rsync -a --delete --chown=ubuntu:ubuntu "${SOURCE_FILTERS[@]}" "$SOURCE/" "$ROOT/"
mkdir -p "$ROOT/commerce-api/rocento-api/migrations"
rsync -a --delete --chown=ubuntu:ubuntu "$SOURCE/commerce-api/rocento-api/migrations/" "$ROOT/commerce-api/rocento-api/migrations/"
# Keep the server's existing control-script location while source ownership moves
# into commerce-ops/deploy. The lock and generated deploy/ec2 configuration stay put.
rsync -a --delete "$SOURCE/commerce-ops/deploy/ec2/server/" "$ROOT/deploy/ec2/server/"
install -D -m 644 "$SOURCE/commerce-ops/deploy/ec2/configure.py" "$ROOT/deploy/ec2/configure.py"
install -D -m 755 "$SOURCE/commerce-ops/deploy/ec2/build-frontend.sh" "$ROOT/deploy/ec2/build-frontend.sh"

# Configuration is installed only after acquiring the same deployment lock.
install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/.rocento-secrets
for file in rocento-origin.pem rocento-origin.key bootstrap.env; do
  install -m 600 -o ubuntu -g ubuntu "$UPLOAD/config/$file" "/home/ubuntu/.rocento-secrets/$file"
done
install -m 600 "$UPLOAD/config/bootstrap.env" "$ROOT/deploy/ec2/bootstrap.env"
if [[ -f "$UPLOAD/config/notifications.env" ]]; then
  install -m 600 "$UPLOAD/config/notifications.env" "$ROOT/deploy/ec2/notifications.env"
fi
if [[ -f "$UPLOAD/config/contact.env" ]]; then
  install -d -m 700 /etc/rocento
  install -m 600 "$UPLOAD/config/contact.env" /etc/rocento/contact.env
fi
if (( PRESERVE_AI )); then
  exec bash "$ROOT/deploy/ec2/server/ec2-up.sh" --preserve-ai
fi
exec bash "$ROOT/deploy/ec2/server/ec2-up.sh"
