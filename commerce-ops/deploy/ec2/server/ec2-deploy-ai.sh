#!/usr/bin/env bash
# Update only selected assistant services on an existing deployment.
set -Eeuo pipefail
ROOT=/opt/rocento
SOURCE=
SERVICE=all
STORE=all
STAGE=configuration
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
while (($#)); do
  case "$1" in
    --root|--source|--service|--store)
      [[ $# -ge 2 ]] || fail "Missing value for $1"
      case "$1" in --root) ROOT=$2 ;; --source) SOURCE=$2 ;; --service) SERVICE=$2 ;; --store) STORE=$2 ;; esac
      shift 2 ;;
    -h|--help) echo 'Usage: sudo bash deploy/ec2/server/ec2-deploy-ai.sh [--service all|ai|language] [--store all|grocery|jewelry|electronics|pharmacy]'; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done
case "$SERVICE" in all|ai|language) ;; *) fail 'Invalid service.' ;; esac
case "$STORE" in all) STORES=(grocery jewelry electronics pharmacy) ;; grocery|jewelry|electronics|pharmacy) STORES=("$STORE") ;; *) fail 'Invalid store.' ;; esac
[[ $EUID == 0 ]] || fail 'Run with sudo.'
[[ -f "$ROOT/deploy/ec2/server/ec2-compose.sh" && -f "$ROOT/deploy/ec2/common.yaml" ]] || fail 'Run a full deployment first.'
exec 9>"$ROOT/deploy/ec2/setup.lock"
flock -n 9 || fail 'Another deployment or seed is active. Wait for it to finish.'
python3 "${SOURCE:-$ROOT}/commerce-ops/scripts/release/deployment_gate.py" check --source "${SOURCE:-$ROOT}" --operation ai --service "$SERVICE" --store "$STORE"
mkdir -p /var/log/rocento/deployments
LOG="/var/log/rocento/deployments/ai-$(date -u +%Y-%m-%dT%H-%M-%SZ)-$$.log"
exec > >(tee -a "$LOG") 2>&1
trap 'status=$?; if (( status != 0 )); then echo "ERROR: AI deployment stopped during $STAGE. See $LOG. Persistent data and secrets were retained."; fi' EXIT
compose() { bash "$ROOT/deploy/ec2/server/ec2-compose.sh" "$@"; }
if [[ $SERVICE != ai && $STORE != all && -f "$ROOT/deploy/ec2/$STORE-shared-ai.env" ]]; then
  fail 'Shared Language Engine upgrades must target all stores.'
fi

require_running() {
  local store=$1 dependency=$2 id
  id=$(compose "$store" ps -q "$dependency")
  [[ -n $id ]] || fail "$store $dependency is not running; restore the existing stack with a full deployment."
  [[ $(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id") == healthy ]] || fail "$store $dependency is not healthy."
}

for store in "${STORES[@]}"; do
  [[ -f "$ROOT/deploy/ec2/$store.env" && -f "$ROOT/deploy/ec2/$store-assistant.env" ]] || fail "Missing $store configuration; run a full deployment first."
  require_running "$store" postgres
  if [[ $SERVICE != language ]]; then
    require_running "$store" api-gateway
    if [[ -f "$ROOT/deploy/ec2/$store-shared-ai.env" ]]; then
      [[ $(docker inspect --format '{{.State.Health.Status}}' rocento-ai-shared-ai-postgres-1) == healthy ]] || fail 'Shared AI database is not healthy.'
    else
      require_running "$store" ai-postgres
    fi
    if [[ $SERVICE == ai ]]; then require_running "$store" commerce-language-engine; fi
  fi
done

for service in ai-service commerce-language-engine; do
  expected=rocento-ai-service:release
  [[ $service != commerce-language-engine ]] || expected=rocento-language-engine:release
  grep -Fq "image: $expected" "$ROOT/deploy/ec2/common.yaml" || fail 'Run a full deployment first to enable shared AI images.'
done

STAGE=install-source
if [[ -n $SOURCE ]]; then
  install -D -m 644 "$SOURCE/commerce-ops/deploy/ec2/server/repository-root.sh" "$ROOT/deploy/ec2/server/repository-root.sh"
  install -D -m 755 "$SOURCE/commerce-ops/deploy/ec2/server/ec2-compose.sh" "$ROOT/deploy/ec2/server/ec2-compose.sh"
  install -D -m 755 "$SOURCE/commerce-ops/deploy/ec2/server/ec2-shared-ai-upgrade.sh" "$ROOT/deploy/ec2/server/ec2-shared-ai-upgrade.sh"
  install -D -m 644 "$SOURCE/commerce-ops/deploy/assistant/shared-tenants.sql" "$ROOT/commerce-ops/deploy/assistant/shared-tenants.sql"
  install -D -m 644 "$SOURCE/commerce-ops/deploy/assistant/shared-language-tenants.sql" "$ROOT/commerce-ops/deploy/assistant/shared-language-tenants.sql"
  install -D -m 644 "$SOURCE/commerce-ops/deploy/ec2/shared-ai-consumer.yaml" "$ROOT/commerce-ops/deploy/ec2/shared-ai-consumer.yaml"
  install -D -m 755 "$SOURCE/commerce-ops/deploy/ec2/server/ec2-deploy-ai.sh" "$ROOT/deploy/ec2/server/ec2-deploy-ai.sh"
  # Source changes are applied only while holding the existing deployment lock.
  if [[ $SERVICE != language ]]; then
    install -D -m 644 "$SOURCE/commerce-ops/compose/compose.assistant-admin.yaml" "$ROOT/commerce-ops/compose/compose.assistant-admin.yaml"
    install -D -m 644 "$SOURCE/commerce-ops/compose/compose.assistant-provider.yaml" "$ROOT/commerce-ops/compose/compose.assistant-provider.yaml"
    [[ -s "$SOURCE/commerce-assistant-platform/app/main.py" ]] || fail 'Assistant upload is incomplete.'
    [[ -s "$SOURCE/commerce-assistant-platform/knowledge/intent-examples.en.json" ]] || fail 'Assistant knowledge upload is incomplete.'
    mkdir -p "$ROOT/commerce-assistant-platform/app" "$ROOT/commerce-assistant-platform/knowledge" "$ROOT/commerce-assistant-platform/migrations"
    rsync -a --delete --exclude=commerce_language_engine/ --exclude=__pycache__/ \
      "$SOURCE/commerce-assistant-platform/app/" "$ROOT/commerce-assistant-platform/app/"
    rsync -a --delete "$SOURCE/commerce-assistant-platform/knowledge/" "$ROOT/commerce-assistant-platform/knowledge/"
    rsync -a "$SOURCE/commerce-assistant-platform/migrations/" "$ROOT/commerce-assistant-platform/migrations/"
    install -D -m 644 "$SOURCE/commerce-ops/scripts/local/conversations-setup.py" "$ROOT/commerce-ops/scripts/local/conversations-setup.py"
    install -D -m 644 "$SOURCE/commerce-ops/scripts/release/agentic-preflight.py" "$ROOT/commerce-ops/scripts/release/agentic-preflight.py"
    for file in Dockerfile .dockerignore requirements.lock; do install -m 644 "$SOURCE/commerce-assistant-platform/$file" "$ROOT/commerce-assistant-platform/$file"; done
    for file in generate_openapi.py generate_assistant_models.py generate_assistant_validator.py; do
      install -D -m 644 "$SOURCE/commerce-ops/scripts/contracts/$file" "$ROOT/commerce-ops/scripts/contracts/$file"
    done
  fi
  if [[ $SERVICE != ai ]]; then
    language=commerce-assistant-platform/app/commerce_language_engine
    [[ -s "$SOURCE/$language/data/compiled.json" && -s "$SOURCE/$language/data/deployment-release.json.gz" ]] || fail 'Language upload is incomplete.'
    for directory in src seeds scripts migrations public; do
      mkdir -p "$ROOT/$language/$directory"
      rsync -a --delete "$SOURCE/$language/$directory/" "$ROOT/$language/$directory/"
    done
    for file in Dockerfile .dockerignore package.json package-lock.json data/compiled.json data/deployment-release.json.gz; do
      install -D -m 644 "$SOURCE/$language/$file" "$ROOT/$language/$file"
    done
  fi
fi

deploy_store() {
  local store=$1
  local services=()
  [[ $SERVICE == language ]] || services+=(ai-service)
  [[ $SERVICE == ai ]] || services+=(commerce-language-engine)
  STAGE="$store-preflight"
  python3 "${SOURCE:-$ROOT}/commerce-ops/scripts/release/deployment_gate.py" artifacts --source "${SOURCE:-$ROOT}" --operation ai --service "$SERVICE" --store "$STORE"
  if [[ -f "$ROOT/deploy/ec2/$store-shared-ai.env" && ${SHARED_AI_MIGRATED:-0} != 1 ]]; then
    bash "$ROOT/deploy/ec2/server/ec2-shared-ai-upgrade.sh" "$SERVICE"
    SHARED_AI_MIGRATED=1
  fi
  if [[ $SERVICE != language ]]; then
    STAGE="$store-assistant-migrations"
    if [[ ! -f "$ROOT/deploy/ec2/$store-shared-ai.env" ]]; then
      python3 "$ROOT/commerce-ops/scripts/local/conversations-setup.py" --container "$(compose "$store" ps -q ai-postgres)"
    fi
    STAGE="$store-preflight"
    compose "$store" run --rm --no-deps --entrypoint python -v "$ROOT:/release:ro" ai-service /release/commerce-ops/scripts/release/agentic-preflight.py --installed-app /app/app
    compose "$store" run --rm --no-deps --entrypoint python ai-service -c 'from app.main import app'
  fi
  if [[ $SERVICE != ai ]]; then
    compose "$store" run --rm --no-deps --entrypoint node commerce-language-engine scripts/check-release.ts
    STAGE="$store-language-start"
    # Startup verifies the release already promoted by the operator.
    compose "$store" up -d --no-deps --no-build --wait --wait-timeout 300 commerce-language-engine || {
      compose "$store" logs --tail=60 commerce-language-engine || true
      fail "$store language-engine startup failed."
    }
  fi
  if [[ $SERVICE != language ]]; then
    STAGE="$store-ai-start"
    compose "$store" up -d --no-deps --no-build --wait --wait-timeout 300 ai-service || {
      compose "$store" logs --tail=60 ai-service || true
      fail "$store assistant startup failed."
    }
    # The Compose liveness check alone does not verify migrated AI storage.
    STAGE="$store-assistant-readiness"
    compose "$store" exec -T ai-service python -c '
import json
import urllib.request
try:
    with urllib.request.urlopen("http://localhost:8000/ready", timeout=5) as response:
        payload = response.read(4097)
    if len(payload) > 4096:
        raise ValueError()
    body = json.loads(payload)
    components = body.get("components", {})
    if body.get("status") != "ready" or components.get("language") != "ready" or components.get("storage") != "ready":
        raise ValueError()
except (OSError, ValueError, TypeError, AttributeError):
    raise SystemExit("Assistant dependencies are not ready") from None
' || {
      compose "$store" logs --tail=60 ai-service commerce-language-engine || true
      fail "$store assistant is not ready; deployment cannot be marked healthy."
    }
  fi
  echo "[OK] $store $SERVICE assistant deployment healthy"
}
for store in "${STORES[@]}"; do deploy_store "$store"; done
echo "[OK] AI deployment complete. Log: $LOG"
