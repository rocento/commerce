#!/usr/bin/env bash
# Deploy assistant components to an already provisioned EC2 installation.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
HOST=3.78.102.161
REMOTE=/opt/rocento
KEY="$ROOT/commerce-ops/deploy/aws-deploy/rocento.pem"
SERVICE=all
STORE=all
SYNC=
UPLOAD=
STAGE=configuration
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
while (($#)); do
  case "$1" in
    --service) [[ $# -ge 2 ]] || fail 'Missing --service value'; SERVICE=$2; shift 2 ;;
    --store) [[ $# -ge 2 ]] || fail 'Missing --store value'; STORE=$2; shift 2 ;;
    --sync-language-data|--sync-language-db) [[ -z $SYNC ]] || fail 'Choose one language data source.'; SYNC=$1; shift ;;
    -h|--help)
      echo 'Usage: bash commerce-ops/deploy/aws-deploy/deploy-ai.sh [--service all|ai|language] [--store all|grocery|jewelry|electronics|pharmacy] [--sync-language-data|--sync-language-db]'
      echo 'Defaults: both AI services, all stores. Requires an existing full deployment.'
      exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done
case "$SERVICE" in all|ai|language) ;; *) fail 'Invalid service; use all, ai, or language.' ;; esac
case "$STORE" in all|grocery|jewelry|electronics|pharmacy) ;; *) fail 'Invalid store.' ;; esac
[[ $SERVICE != ai || -z $SYNC ]] || fail 'Language data sync requires --service language or all.'
[[ -r $KEY ]] || fail "Missing SSH key: $KEY"
chmod 400 "$KEY"
if [[ -n $SYNC ]]; then
  STAGE=language-release-export
  if [[ $SYNC == --sync-language-db ]]; then
    node "$ROOT/commerce-assistant-platform/app/commerce_language_engine/scripts/export-db-release.ts"
  else
    node "$ROOT/commerce-assistant-platform/app/commerce_language_engine/scripts/export-release.ts"
  fi
fi
if [[ $SERVICE != ai ]]; then
  node "$ROOT/commerce-assistant-platform/app/commerce_language_engine/scripts/check-release.ts"
  [[ -s "$ROOT/commerce-assistant-platform/app/commerce_language_engine/data/deployment-release.json.gz" ]] || fail 'Package a language release with --sync-language-data or --sync-language-db first.'
fi
SSH_OPTIONS=(-i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=20 -o ConnectionAttempts=3 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
SSH=(ssh "${SSH_OPTIONS[@]}" "ubuntu@$HOST")
RSYNC_SSH="ssh -i \"$KEY\" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o ConnectionAttempts=3 -o ServerAliveInterval=15 -o ServerAliveCountMax=3"
cleanup() {
  local status=$?
  if [[ $UPLOAD == /home/ubuntu/.rocento-ai-deploy.* ]]; then
    "${SSH[@]}" "rm -rf -- '$UPLOAD'" >/dev/null 2>&1 || true
  fi
  if (( status != 0 )); then printf 'ERROR: AI deployment stopped during %s (exit %s).\n' "$STAGE" "$status" >&2; fi
}
trap cleanup EXIT
upload() {
  local attempt status
  for attempt in 1 2 3; do
    if rsync -az --partial --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r -e "$RSYNC_SSH" "$@"; then return 0; else status=$?; fi
    case "$status" in 10|12|30|35|255) ;; *) return "$status" ;; esac
    (( attempt < 3 )) || return "$status"
    sleep 2
  done
}
STAGE=ssh-connection
UPLOAD=$("${SSH[@]}" "test -f '$REMOTE/deploy/ec2/server/ec2-compose.sh' && mktemp -d /home/ubuntu/.rocento-ai-deploy.XXXXXXXX")
[[ $UPLOAD =~ ^/home/ubuntu/\.rocento-ai-deploy\.[A-Za-z0-9]+$ ]] || fail 'Could not create a remote upload directory; run the full deployment first.'
STAGE=source-upload
echo "[INFO] Uploading $SERVICE assistant components for $STORE"
files=(commerce-ops/scripts/release/deployment_gate.py commerce-ops/scripts/release/release_readiness.py commerce-ops/deploy/ec2/server/ec2-deploy-ai.sh commerce-ops/deploy/ec2/server/ec2-compose.sh commerce-ops/deploy/ec2/server/ec2-shared-ai-upgrade.sh commerce-ops/deploy/ec2/server/repository-root.sh
  commerce-ops/deploy/assistant/shared-tenants.sql commerce-ops/deploy/assistant/shared-language-tenants.sql
  commerce-ops/deploy/ec2/shared-ai-consumer.yaml)
if [[ $SERVICE != language ]]; then
  files+=(commerce-assistant-platform/Dockerfile commerce-assistant-platform/.dockerignore commerce-assistant-platform/requirements.lock commerce-assistant-platform/app/ commerce-assistant-platform/knowledge/
    commerce-assistant-platform/migrations/ commerce-ops/scripts/local/conversations-setup.py
    commerce-ops/compose/compose.assistant-admin.yaml commerce-ops/compose/compose.assistant-provider.yaml
    commerce-ops/scripts/release/agentic-preflight.py commerce-ops/scripts/contracts/generate_openapi.py commerce-ops/scripts/contracts/generate_assistant_models.py commerce-ops/scripts/contracts/generate_assistant_validator.py
    commerce-ops/scripts/contracts/generate_openapi.py commerce-ops/scripts/contracts/generate_assistant_models.py commerce-ops/scripts/contracts/generate_assistant_validator.py)
fi
cd "$ROOT"
# The Node build context is uploaded separately, only when selected.
upload --relative --exclude='commerce_language_engine/' --exclude='__pycache__/' --exclude='*.pyc' \
  "${files[@]}" "ubuntu@$HOST:$UPLOAD/"
if [[ $SERVICE != ai ]]; then
  language=commerce-assistant-platform/app/commerce_language_engine
  upload --relative "$language/Dockerfile" "$language/.dockerignore" "$language/package.json" "$language/package-lock.json" \
    "$language/src/" "$language/seeds/" "$language/scripts/" "$language/migrations/" "$language/public/" \
    "$language/data/compiled.json" "$language/data/deployment-release.json.gz" "ubuntu@$HOST:$UPLOAD/"
fi
STAGE=remote-ai-deployment
"${SSH[@]}" "sudo bash '$UPLOAD/commerce-ops/deploy/ec2/server/ec2-deploy-ai.sh' --root '$REMOTE' --source '$UPLOAD' --service '$SERVICE' --store '$STORE'"
