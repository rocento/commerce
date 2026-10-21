#!/usr/bin/env bash
# Idempotent, non-interactive deployment for Rocento and its four isolated demos.
set -Eeuo pipefail

. "$(dirname -- "${BASH_SOURCE[0]}")/repository-root.sh"
ROOT=$(find_repo_root)
BOOTSTRAP="$ROOT/deploy/ec2/bootstrap.env"
STATE="$ROOT/deploy/ec2/state"
LOG_DIR=/var/log/rocento/deployments
DEFAULT_CERT=/etc/nginx/ssl/rocento-origin.pem
DEFAULT_KEY=/etc/nginx/ssl/rocento-origin.key
MODE=full
RESTART=0
PRESERVE_AI=0
STAGE=preflight
WORK=

usage() {
  cat <<'HELP'
Usage: sudo bash commerce-ops/deploy/ec2/server/ec2-up.sh [options]

Default: safely deploy/resume all Rocento demo stores from deploy/ec2/bootstrap.env.
  --preserve-ai       Keep running production AI; update only commerce services.
  --verify-only       Check existing deployment without changing it.
  --skip-seed         Compatibility option; deployment never seeds demo data.
  --no-build          Compatibility option; production always promotes reviewed artifacts.
  --rebuild           Rejected; qualify artifacts before production promotion.
  --restart           Restart service containers after reconciliation.
  -h, --help          Show this help.

Required protected configuration: deploy/ec2/bootstrap.env (mode 600).
Start from commerce-ops/deploy/ec2/bootstrap.env.example and install it as
deploy/ec2/bootstrap.env. The file supplies DOMAIN,
ORIGIN_CERT, ORIGIN_KEY, and the store admin credentials; deployment never asks
questions and never prints these values.
Demo data is managed separately: sudo bash deploy/ec2/server/ec2-seed-demo.sh --store all.
Deployment does not bootstrap demo administrators or modify demo themes.
HELP
}

say() { printf '%s %s\n' "$1" "$2"; }
ok() { say '[OK]' "$*"; }
skip() { say '[SKIP]' "$*"; }
info() { say '[INFO]' "$*"; }
fail() { say 'ERROR:' "$*" >&2; exit 1; }

cleanup() {
  local status=$?
  [[ -z $WORK ]] || rm -rf -- "$WORK"
  if (( status != 0 )); then
    say 'ERROR:' "Deployment stopped during: $STAGE. Persistent data and secrets were retained. See $DEPLOY_LOG."
  fi
}

while (($#)); do
  case "$1" in
    --verify-only) MODE=verify; shift ;;
    --seed-only|--seed|--seed-store) fail 'Demo seeding moved to: sudo bash deploy/ec2/server/ec2-seed-demo.sh --store all (or grocery, jewelry, electronics, pharmacy)' ;;
    --skip-seed) shift ;;
    --no-build) shift ;;
    --rebuild) fail 'Production deploys require preverified images and frontend artifacts; build and qualify them before promotion.' ;;
    --restart) RESTART=1; shift ;;
    --preserve-ai) PRESERVE_AI=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1. Run --help for supported options." ;;
  esac
done
[[ $EUID == 0 ]] || fail 'Run with sudo: sudo bash deploy/ec2/server/ec2-up.sh'
[[ $PRESERVE_AI == 0 || $RESTART == 0 ]] || fail '--preserve-ai cannot be combined with --restart.'
if [[ $MODE != verify ]]; then
  RELEASE_ARGS=(--source "$ROOT" --operation full)
  (( PRESERVE_AI == 0 )) || RELEASE_ARGS+=(--preserve-ai)
  python3 "$ROOT/commerce-ops/scripts/release/deployment_gate.py" check "${RELEASE_ARGS[@]}"
fi
mkdir -p "$LOG_DIR"
DEPLOY_LOG="$LOG_DIR/$(date -u +%Y-%m-%dT%H-%M-%SZ).log"
exec > >(tee -a "$DEPLOY_LOG") 2>&1
trap cleanup EXIT

. "$ROOT/deploy/ec2/server/ec2-bootstrap.sh"

required_files() {
  local required=(commerce-ops/compose/compose.language-engine.yaml commerce-assistant-platform/app/commerce_language_engine/Dockerfile commerce-ops/compose/compose.yaml commerce-ops/compose/compose.jewelry.yaml commerce-ops/compose/compose.electronics.yaml commerce-ops/compose/compose.pharmacy.yaml deploy/ec2/server/ec2-up.sh deploy/ec2/server/ec2-bootstrap.sh deploy/ec2/server/ec2-compose.sh deploy/ec2/server/ec2-check.py commerce-ops/deploy/ec2/configure.py commerce-ops/deploy/ec2/build-frontend.sh commerce-web/pnpm-lock.yaml)
  local path
  for path in "${required[@]}"; do
    [[ -e "$ROOT/$path" ]] || fail "Repository is incomplete: missing $path. Upload the complete repository to /opt/rocento, then rerun."
  done
}

validate_os_architecture() {
  [[ -r /etc/os-release ]] || fail 'Cannot identify the operating system.'
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ ${ID:-} == ubuntu ]] || fail 'Rocento EC2 deployment supports Ubuntu 24.04 or 26.04 LTS.'
  case "${VERSION_ID:-}" in 24.04|26.04) ;; *) fail "Unsupported Ubuntu release ${VERSION_ID:-unknown}. Use Ubuntu 24.04 or 26.04 LTS." ;; esac
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64|amd64) ARCH=x86_64 ;;
    aarch64|arm64) ARCH=aarch64 ;;
    *) fail "Unsupported CPU architecture $(uname -m). Use an x86_64 or ARM64/aarch64 EC2 instance." ;;
  esac
  ok "Ubuntu $VERSION_ID; architecture: $ARCH"
}

ensure_dependencies() {
  STAGE=dependencies
  local packages=()
  command -v curl >/dev/null 2>&1 || packages+=(curl)
  command -v openssl >/dev/null 2>&1 || packages+=(openssl)
  command -v rsync >/dev/null 2>&1 || packages+=(rsync)
  command -v nginx >/dev/null 2>&1 || packages+=(nginx)
  command -v flock >/dev/null 2>&1 || packages+=(util-linux)
  if [[ $MODE == verify ]] && ((${#packages[@]})); then
    fail "Verification requires installed system dependencies: ${packages[*]}. Run a normal deployment first."
  fi
  if ((${#packages[@]})); then
    info "Installing system dependencies: ${packages[*]}"
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates python3 "${packages[@]}"
  else
    skip 'System dependencies already installed'
  fi
  if [[ $MODE == verify ]] && ! command -v docker >/dev/null 2>&1; then
    fail 'Verification requires Docker, but Docker is not installed. Run a normal deployment first.'
  fi
  if ! command -v docker >/dev/null 2>&1; then
    info 'Installing Docker Engine from Docker’s Ubuntu repository'
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' "$(dpkg --print-architecture)" "${UBUNTU_CODENAME:-$VERSION_CODENAME}" > /etc/apt/sources.list.d/docker.list
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  systemctl enable --now docker
  docker info >/dev/null || fail 'Docker is installed but unavailable. Run systemctl status docker and resolve the service error.'
  local version
  version=$(docker compose version --short 2>/dev/null || true)
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || fail 'Docker Compose plugin is missing. Install docker-compose-plugin, then rerun.'
  python3 - "$version" <<'PY'
import re, sys
match = re.search(r'(\d+)\.(\d+)\.(\d+)', sys.argv[1])
if not match or tuple(map(int, match.groups())) < (2, 24, 4):
    raise SystemExit('Docker Compose 2.24.4+ is required. Upgrade Docker Compose, then rerun.')
PY
  ok "Docker and Compose $version"
}

check_resources() {
  local disk memory
  disk=$(df -Pm "$ROOT" | awk 'NR==2 {print $4}')
  memory=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  # df -Pm reports MiB. Keep the same 30,000 MiB deployment reserve.
  (( disk >= 30000 )) || fail "Only ${disk} MiB disk space is available; at least 30000 MiB is required for images, staging and data. Expand the EBS volume, then rerun."
  (( memory >= 4096 )) || fail "Only ${memory}MB RAM is available; at least 4GB is required. Use a larger EC2 instance, then rerun."
  ok "Disk space: $((disk / 1024))GB available; memory: $((memory / 1024))GB"
}

validate_tls() {
  [[ -s $ORIGIN_CERT ]] || fail "Origin certificate not found: $ORIGIN_CERT. Put the Cloudflare Origin CA PEM there and set ORIGIN_CERT in $BOOTSTRAP."
  [[ -s $ORIGIN_KEY ]] || fail "Origin private key not found: $ORIGIN_KEY. Set ORIGIN_KEY in $BOOTSTRAP."
  openssl x509 -in "$ORIGIN_CERT" -noout -checkend 86400 >/dev/null || fail 'Origin certificate expires within 24 hours or is invalid. Replace it before deploying.'
  local host
  for host in "$DOMAIN" "www.$DOMAIN" "grocery.$DOMAIN" "admin.$DOMAIN" "jewelry.$DOMAIN" "jewelry-admin.$DOMAIN" "electronics.$DOMAIN" "electronics-admin.$DOMAIN" "pharmacy.$DOMAIN" "pharmacy-admin.$DOMAIN" "apps.$DOMAIN"; do
    openssl x509 -in "$ORIGIN_CERT" -noout -checkhost "$host" >/dev/null || fail "Origin certificate does not cover $host. Create a certificate covering $DOMAIN and *.$DOMAIN."
  done
  openssl x509 -in "$ORIGIN_CERT" -pubkey -noout > "$WORK/cert.pub"
  openssl pkey -in "$ORIGIN_KEY" -pubout > "$WORK/key.pub" || fail 'Origin private key is invalid.'
  cmp -s "$WORK/cert.pub" "$WORK/key.pub" || fail 'Origin certificate and private key do not match.'
  ok 'TLS certificate, private key, hostname coverage and key match'
}

fingerprint() {
  find "$@" -type d \( -name node_modules -o -name target -o -name dist -o -name out -o -name .next -o -name .venv -o -name __pycache__ -o -name .pytest_cache \) -prune -o -type f -print0 2>/dev/null | LC_ALL=C sort -z | xargs -0r sha256sum | sha256sum | awk '{print $1}'
}
backend_fingerprint() {
  fingerprint "$ROOT/commerce-api" "$ROOT/commerce-assistant-platform" "$ROOT/commerce-ops/deploy/assistant" "$ROOT/commerce-ops/compose/compose.language-engine.yaml" "$ROOT/commerce-ops/compose/compose.yaml" "$ROOT/commerce-ops/compose/compose.jewelry.yaml" "$ROOT/commerce-ops/compose/compose.electronics.yaml" "$ROOT/commerce-ops/compose/compose.pharmacy.yaml" "$ROOT/commerce-ops/compose/compose.assistant.yaml" "$ROOT/commerce-ops/compose/compose.assistant-admin.yaml" "$ROOT/commerce-ops/deploy/ec2/assistant.yaml" "$ROOT/deploy/ec2/common.yaml" "$ROOT/deploy/ec2/grocery.yaml" "$ROOT/deploy/ec2/jewelry.yaml" "$ROOT/deploy/ec2/electronics.yaml" "$ROOT/deploy/ec2/pharmacy.yaml"
}
state_value() { [[ -f "$STATE/$1" ]] && cat "$STATE/$1" || true; }
state_set() { install -d -m 700 "$STATE"; printf '%s\n' "$2" > "$STATE/$1.tmp"; chmod 600 "$STATE/$1.tmp"; mv -f "$STATE/$1.tmp" "$STATE/$1"; }
compose() { bash "$ROOT/deploy/ec2/server/ec2-compose.sh" "$@"; }

check_public_host() {
  local host=$1 origin_args=()
  if [[ -n ${ROCENTO_ORIGIN_IP:-} ]]; then
    origin_args=(--resolve-ip "$ROCENTO_ORIGIN_IP" --origin-cert "$ORIGIN_CERT")
  fi
  python3 "$ROOT/deploy/ec2/server/ec2-check.py" public --host "$host" "${origin_args[@]}"
}

check_public_ready() {
  local url=$1 origin_args=()
  if [[ -n ${ROCENTO_ORIGIN_IP:-} ]]; then
    origin_args=(--resolve-ip "$ROCENTO_ORIGIN_IP" --origin-cert "$ORIGIN_CERT")
  fi
  python3 "$ROOT/deploy/ec2/server/ec2-check.py" ready --url "$url" "${origin_args[@]}"
}

preflight() {
  STAGE=preflight
  printf '\nRocento deployment preflight\n\n'
  validate_os_architecture
  required_files; ok 'Repository completeness'
  load_bootstrap
  python3 "$ROOT/commerce-ops/deploy/ec2/configure.py" validate-domain --domain "$DOMAIN" || fail "DOMAIN=$DOMAIN is not a valid lowercase DNS domain. Update $BOOTSTRAP."
  ok "Bootstrap configuration: $BOOTSTRAP"
  if [[ $MODE != verify ]]; then
    command -v flock >/dev/null || fail 'Install util-linux before deployment (flock is required).'
    if [[ ${ROCENTO_DEPLOY_LOCK_FD:-} == 9 ]]; then
      [[ /proc/$$/fd/9 -ef "$ROOT/deploy/ec2/setup.lock" ]] || fail 'Inherited deployment lock does not match this checkout.'
    else
      exec 9>"$ROOT/deploy/ec2/setup.lock"
    fi
    # flock also verifies the inherited descriptor; never bypass the lock.
    flock -n 9 || fail 'Another Rocento deployment is already active. Wait for it to finish, then rerun.'
    python3 "$ROOT/commerce-ops/scripts/release/deployment_gate.py" check "${RELEASE_ARGS[@]}"
    if [[ -f "$ROOT/deploy/ec2/server/cleanup.py" ]]; then
      STAGE=disk-cleanup
      python3 "$ROOT/deploy/ec2/server/cleanup.py"
      STAGE=preflight
    fi
  fi
  WORK=$(mktemp -d)
  if (( PRESERVE_AI )); then
    if [[ -z ${ROCENTO_AI_BASELINE:-} ]]; then
      ROCENTO_AI_BASELINE="$WORK/ai-baseline.json"
      python3 "$ROOT/deploy/ec2/server/ec2-preserve-ai.py" snapshot "$ROCENTO_AI_BASELINE"
    else
      python3 "$ROOT/deploy/ec2/server/ec2-preserve-ai.py" verify "$ROCENTO_AI_BASELINE"
    fi
  fi
  check_resources
  ensure_dependencies
  validate_tls
  local host
  for host in "$DOMAIN" "grocery.$DOMAIN" "admin.$DOMAIN" "jewelry.$DOMAIN" "jewelry-admin.$DOMAIN" "electronics.$DOMAIN" "electronics-admin.$DOMAIN" "pharmacy.$DOMAIN" "pharmacy-admin.$DOMAIN" "apps.$DOMAIN"; do
    python3 "$ROOT/deploy/ec2/server/ec2-check.py" dns --host "$host" || fail "DNS preflight failed for $host. Add its proxied Cloudflare record before running a full deployment."
  done
  for port in 8080 58080; do
    if ss -ltn "sport = :$port" | grep -q LISTEN; then info "Port $port is already listening; it will be verified as an existing Rocento service."; else ok "Port $port available"; fi
  done
  printf '\nPreflight passed.\n'
}

prepare_configuration() {
  STAGE=configuration
  install -d -m 700 "$ROOT/deploy/ec2" "$STATE"
  local store
  for store in grocery jewelry electronics pharmacy; do
    if (( PRESERVE_AI )) || docker volume inspect "rocento-${store}_ai-data" >/dev/null 2>&1; then
      for assistant_file in "$ROOT/deploy/ec2/$store-assistant.env" "$ROOT/deploy/ec2/assistant/$store/"{private.pem,public.pem,store-admin-password,store-runtime-password}; do
        [[ -s "$assistant_file" ]] || fail "Existing $store AI database has missing credentials. Restore $assistant_file from backup before continuing."
      done
    fi
    if [[ ! -f "$ROOT/deploy/ec2/$store.env" ]] && docker volume inspect "rocento-${store}_postgres-data" >/dev/null 2>&1; then
      fail "Existing $store database volume exists but deploy/ec2/$store.env is missing. Restore that exact env file from backup; new secrets would make the database inaccessible."
    fi
  done
  # Detached activation starts in the upload stage; render into the active checkout.
  python3 "$ROOT/commerce-ops/deploy/ec2/configure.py" prepare --domain "$DOMAIN" --directory "$ROOT/deploy/ec2"
  for store in grocery jewelry electronics pharmacy; do chmod 600 "$ROOT/deploy/ec2/$store.env"; done
  compose grocery config --quiet
  compose jewelry config --quiet
  compose electronics config --quiet
  compose pharmacy config --quiet
  ok 'Persistent configuration'
}

verify_configuration() {
  STAGE=verify-configuration
  local store
  for store in grocery jewelry electronics pharmacy; do
    [[ -f "$ROOT/deploy/ec2/$store.env" && -f "$ROOT/deploy/ec2/$store.yaml" ]] || fail "Cannot verify: missing deploy/ec2/$store.env or deploy/ec2/$store.yaml. Run a normal deployment first."
  done
  [[ -f "$ROOT/deploy/ec2/common.yaml" ]] || fail 'Cannot verify: missing deploy/ec2/common.yaml. Run a normal deployment first.'
  compose grocery config --quiet
  compose jewelry config --quiet
  compose electronics config --quiet
  compose pharmacy config --quiet
  ok 'Existing deployment configuration'
}

migration_preflight() {
  STAGE=migration-history-preflight
  python3 "$ROOT/commerce-ops/scripts/checks/check-migration-history.py"
  local store container history_table
  for store in grocery jewelry electronics pharmacy; do
    container=$(compose "$store" ps --all --quiet postgres)
    if [[ -z $container ]]; then
      skip "$store has no existing PostgreSQL container; migration history will start fresh"
      continue
    fi
    history_table=$(compose "$store" exec -T postgres psql -X -U commerce -d commerce -Atqc "SELECT to_regclass('public._sqlx_migrations')")
    if [[ -z $history_table ]]; then
      skip "$store database has no applied migration history"
      continue
    fi
    compose "$store" exec -T postgres psql -X -U commerce -d commerce -v ON_ERROR_STOP=1 -Atqc \
      "SELECT version, encode(checksum, 'hex'), success FROM public._sqlx_migrations ORDER BY version" > "$WORK/$store-migrations.txt"
    python3 "$ROOT/commerce-ops/scripts/checks/check-migration-history.py" --history "$WORK/$store-migrations.txt"
    ok "$store applied migration history matches this release"
  done
}

verify_release_migrations() {
  STAGE=migration-completion-check
  local store
  # The gateway applies embedded SQLx migrations before opening its listener.
  # Verify the exact uploaded inventory before publishing new frontend assets.
  for store in grocery jewelry electronics pharmacy; do
    compose "$store" exec -T postgres psql -X -U commerce -d commerce -v ON_ERROR_STOP=1 -Atqc \
      "SELECT version, encode(checksum, 'hex'), success FROM public._sqlx_migrations ORDER BY version" > "$WORK/$store-release-migrations.txt"
    python3 "$ROOT/commerce-ops/scripts/checks/check-migration-history.py" --history "$WORK/$store-release-migrations.txt" --require-all
    ok "$store release migrations applied and verified (including megamenu translations)"
  done
}

frontend_current() {
  [[ -L /var/www/rocento/current ]] || return 1
  local site
  for site in website storefront grocery-admin jewelry-admin electronics-admin pharmacy-admin mobile-admin; do [[ -s "/var/www/rocento/current/$site/index.html" ]] || return 1; done
}

prepare_storefront_images() {
  STAGE=storefront-image-preparation
  local store
  for store in grocery jewelry electronics pharmacy; do
    info "Preparing existing $store storefront images (at most 100; originals preserved)"
    compose "$store" exec -T api-gateway prepare-storefront-images --apply --limit 100
  done
}

prepare_reviewed_frontend() {
  STAGE=frontend-artifact
  # The operator installs this exact reviewed export outside uploaded source.
  local artifact=/etc/rocento/release/frontend
  [[ -d "$artifact" && ! -L "$artifact" ]] || fail 'Install the reviewed frontend export in /etc/rocento/release/frontend.'
  python3 "$ROOT/commerce-ops/scripts/release/deployment_gate.py" artifacts "${RELEASE_ARGS[@]}" --frontend "$artifact"
  mkdir -p "$WORK/public"
  cp -a "$artifact/." "$WORK/public/"
  FRONTEND_DIGEST=$(fingerprint "$ROOT/commerce-web" "$ROOT/commerce-api/rocento-api/openapi.json" "$ROOT/commerce-ops/deploy/ec2/build-frontend.sh")
  ok 'Reviewed frontend artifact prepared'
}

engagement_import_state() {
  local store=$1 present initialized
  present=$(compose "$store" exec -T engagement-postgres psql -X -U engagement -d engagement -v ON_ERROR_STOP=1 -Atqc \
    "SELECT to_regclass('platform.engagement_installation') IS NOT NULL") || return
  case "$present" in
    f) echo pending; return ;;
    t) ;;
    *) fail 'Unexpected engagement migration status; refusing to stop the gateway.' ;;
  esac
  initialized=$(compose "$store" exec -T engagement-postgres psql -X -U engagement -d engagement -v ON_ERROR_STOP=1 -Atqc \
    'SELECT EXISTS (SELECT 1 FROM platform.engagement_installation WHERE singleton)') || return
  case "$initialized" in
    t) echo complete ;;
    f) echo pending ;;
    *) fail 'Unexpected engagement import status; refusing to stop the gateway.' ;;
  esac
}

validate_assistant_proxies() {
  local store=$1 proxy
  STAGE="${store}-proxy-validation"
  for proxy in ingress tools provider; do
    compose "$store" run --rm --no-deps --entrypoint nginx "assistant-$proxy" -t || fail "$store assistant-$proxy configuration is invalid; services were not replaced."
  done
}

start_store_preserving_ai() {
  local store=$1 digest image engagement_state
  STAGE="${store}-preserve-ai"
  digest=$(backend_fingerprint)
  python3 "$ROOT/commerce-ops/scripts/release/deployment_gate.py" artifacts "${RELEASE_ARGS[@]}"
  image=$(python3 "$ROOT/deploy/ec2/server/ec2-preserve-ai.py" image "$ROCENTO_AI_BASELINE" "$store")
  # Use the running image's immutable ID, never a possibly stale :release tag.
  # Verify gateway contracts while leaving AI code, databases and services alone.
  docker run --rm --network none --entrypoint python -v "$ROOT:/release:ro" "$image" \
    /release/commerce-ops/scripts/release/agentic-preflight.py --installed-contracts-only /app/app
  local infrastructure=(postgres engagement-postgres clickhouse nats meilisearch minio)
  local applications=(api-gateway export-worker engagement-worker analytics-worker)
  compose "$store" up -d --no-build --no-deps --wait --wait-timeout 300 "${infrastructure[@]}"
  engagement_state=$(engagement_import_state "$store")
  if [[ $engagement_state == pending ]]; then
    compose "$store" stop api-gateway engagement-worker
  fi
  compose "$store" up -d --no-build --no-deps --wait --wait-timeout 300 "${applications[@]}"
  # Separate state ensures this mode never marks an unbuilt AI release deployed.
  state_set "$store-preserved-commerce.sha256" "$digest"
  ok "$store commerce stack updated; production AI retained"
}

start_store() {
  if [[ ${PRESERVE_AI:-0} == 1 ]]; then
    start_store_preserving_ai "$1"
    return
  fi
  local store=$1 digest previous runtime_digest engagement_state build_arg=()
  STAGE="${store}-start"
  digest=$(backend_fingerprint)
  previous=$(state_value "$store-backend.sha256")
  python3 "$ROOT/commerce-ops/scripts/release/deployment_gate.py" artifacts "${RELEASE_ARGS[@]}"
  validate_assistant_proxies "$store"
  # New dedicated installations receive the packaged language release once.
  # Shared installations retain their operator-managed database lifecycle.
  if [[ ! -f "$ROOT/deploy/ec2/$store-shared-ai.env" ]]; then
    STAGE="${store}-language-first-install"
    compose "$store" up -d --no-deps --no-build --wait --wait-timeout 300 postgres
    compose "$store" run --rm --no-deps --entrypoint node commerce-language-engine scripts/install-empty.ts
  fi
  # Init scripts run only for new volumes. Upgrade existing assistant databases
  # before the new runtime checks for revision, plan, and tracking tables.
  STAGE="${store}-assistant-database"
  local assistant_database
  if [[ -f "$ROOT/deploy/ec2/$store-shared-ai.env" ]]; then
    assistant_database=rocento-ai-shared-ai-postgres-1
    [[ $(docker inspect --format '{{.State.Health.Status}}' "$assistant_database") == healthy ]] || fail 'Shared AI database is not healthy.'
    if [[ ${SHARED_AI_MIGRATED:-0} != 1 ]]; then
      bash "$ROOT/deploy/ec2/server/ec2-shared-ai-upgrade.sh" all
      SHARED_AI_MIGRATED=1
    fi
  else
  if ! compose "$store" up -d --no-deps --no-build --wait --wait-timeout 300 ai-postgres; then
    compose "$store" logs --tail=60 ai-postgres || true
    fail "$store AI database startup failed; application services were not replaced."
  fi
  assistant_database=$(compose "$store" ps -q ai-postgres)
  fi
  [[ -n $assistant_database ]] || fail "$store AI database container is missing; application services were not replaced."
  STAGE="${store}-assistant-migrations"
  python3 "$ROOT/commerce-ops/scripts/local/conversations-setup.py" --container "$assistant_database"
  STAGE="${store}-start"
  # Validate release contracts and the installed AI code before starting new services.
  compose "$store" run --rm --no-deps --entrypoint python -v "$ROOT:/release:ro" ai-service /release/commerce-ops/scripts/release/agentic-preflight.py --installed-app /app/app
  compose "$store" run --rm --no-deps --entrypoint python ai-service -c 'from app.main import app'
  STAGE="${store}-engagement-database"
  compose "$store" up -d --no-deps --no-build --wait --wait-timeout 120 engagement-postgres
  # Only the first engagement import needs the old writer stopped in advance.
  # Otherwise Compose reconciles changed services; unchanged gateways stay up.
  engagement_state=$(engagement_import_state "$store")
  if [[ $engagement_state == pending ]]; then
    compose "$store" stop api-gateway engagement-worker
  fi
  STAGE="${store}-start"
  if ! compose "$store" up -d --no-build --wait --wait-timeout 300; then
    # Startup/migration failures happen before internal_ready can show logs.
    compose "$store" logs --tail=60 api-gateway analytics-worker engagement-worker engagement-postgres || true
    compose "$store" logs --tail=60 commerce-language-engine || true
    compose "$store" logs --tail=60 ai-service || true
    fail "$store startup failed; inspect the gateway, language-engine, and AI service errors above. Do not reset persistent data or migration checksums."
  fi
  # rsync replaces files atomically. Existing single-file bind mounts retain
  # the old inode, and Compose cannot detect changes to mounted file contents.
  runtime_digest=$(fingerprint "$ROOT/commerce-ops/deploy/assistant/ingress.conf" "$ROOT/commerce-ops/deploy/assistant/tools.conf" "$ROOT/commerce-ops/deploy/assistant/provider.conf" "$ROOT/commerce-ops/deploy/assistant/policy-answers.json")
  if [[ $runtime_digest != "$(state_value "$store-assistant-runtime.sha256")" ]]; then
    info "Refreshing $store assistant configuration mounts"
    if ! compose "$store" up -d --no-deps --no-build --force-recreate --wait --wait-timeout 300 ai-service assistant-ingress assistant-tools assistant-provider; then
      compose "$store" logs --tail=60 assistant-ingress assistant-tools assistant-provider || true
      fail "$store assistant configuration refresh failed; inspect the proxy errors above."
    fi
  fi
  local proxy expected mounted
  for proxy in ingress tools; do
    expected=$(sha256sum "$ROOT/commerce-ops/deploy/assistant/$proxy.conf" | cut -d ' ' -f 1)
    mounted=$(compose "$store" exec -T "assistant-$proxy" cat /etc/nginx/conf.d/default.conf | sha256sum | cut -d ' ' -f 1)
    [[ $mounted == "$expected" ]] || fail "$store has a stale assistant-$proxy mount; traffic publication blocked."
  done
  (( ! RESTART )) || compose "$store" restart
  # Compose checks /health for process liveness. The runtime /ready check also
  # requires the migrated AI store and Language Engine before publishing success.
  STAGE="${store}-assistant-readiness"
  if ! compose "$store" exec -T ai-service python -c '
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
'; then
    compose "$store" logs --tail=60 ai-service commerce-language-engine || true
    fail "$store assistant is not ready; deployment state and frontend publication were not advanced."
  fi
  if [[ $runtime_digest != "$(state_value "$store-assistant-runtime.sha256")" ]]; then
    state_set "$store-assistant-runtime.sha256" "$runtime_digest"
  fi
  state_set "$store-backend.sha256" "$digest"
  ok "$store stack running"
}

internal_ready() {
  STAGE=internal-health
  python3 "$ROOT/deploy/ec2/server/ec2-check.py" ready --url http://127.0.0.1:8080/ready || { compose grocery logs --tail=80 api-gateway; fail 'Grocery API is unhealthy; inspect the gateway log above.'; }
  python3 "$ROOT/deploy/ec2/server/ec2-check.py" ready --url http://127.0.0.1:58080/ready || { compose jewelry logs --tail=80 api-gateway; fail 'Jewelry API is unhealthy; inspect the gateway log above.'; }
  python3 "$ROOT/deploy/ec2/server/ec2-check.py" ready --url http://127.0.0.1:59080/ready || { compose electronics logs --tail=80 api-gateway; fail 'Electronics API is unhealthy.'; }
  python3 "$ROOT/deploy/ec2/server/ec2-check.py" ready --url http://127.0.0.1:60080/ready || { compose pharmacy logs --tail=80 api-gateway; fail 'Pharmacy API is unhealthy.'; }
  ok 'All four local APIs are ready'
}

publish_ingress() {
  STAGE=nginx-ingress
  install -d -m 700 /etc/nginx/ssl
  [[ $(readlink -f "$ORIGIN_CERT") == "$DEFAULT_CERT" ]] || install -m 600 "$ORIGIN_CERT" "$DEFAULT_CERT"
  [[ $(readlink -f "$ORIGIN_KEY") == "$DEFAULT_KEY" ]] || install -m 600 "$ORIGIN_KEY" "$DEFAULT_KEY"
  chmod 600 "$DEFAULT_CERT" "$DEFAULT_KEY"
  local previous=0
  [[ -e /etc/nginx/sites-available/rocento ]] && { cp -a /etc/nginx/sites-available/rocento "$WORK/nginx.previous"; previous=1; }
  python3 "$ROOT/commerce-ops/deploy/ec2/configure.py" nginx --domain "$DOMAIN" > /etc/nginx/sites-available/rocento
  ln -sfn /etc/nginx/sites-available/rocento /etc/nginx/sites-enabled/rocento
  if ! nginx -t; then
    (( previous )) && cp -a "$WORK/nginx.previous" /etc/nginx/sites-available/rocento || rm -f /etc/nginx/sites-available/rocento /etc/nginx/sites-enabled/rocento
    fail 'Nginx rejected the generated configuration. The previous configuration was restored; backend services were not changed.'
  fi
  systemctl enable --now nginx
  if ! systemctl reload nginx; then
    (( previous )) && cp -a "$WORK/nginx.previous" /etc/nginx/sites-available/rocento || rm -f /etc/nginx/sites-available/rocento /etc/nginx/sites-enabled/rocento
    fail 'Nginx ingress reload failed. Gateway ingress throttling mode was not activated.'
  fi
  ok 'Authentication ingress limits and origin TLS active'
}

publish_nginx() {
  STAGE=frontend-publication
  install -d -m 755 /opt/rocento-contact
  install -m 644 "$ROOT/commerce-ops/deploy/contact/server.py" /opt/rocento-contact/server.py
  install -m 644 "$ROOT/commerce-ops/deploy/contact/rocento-contact.service" /etc/systemd/system/rocento-contact.service
  systemctl daemon-reload
  systemctl enable --now rocento-contact
  systemctl restart rocento-contact
  systemctl is-active --quiet rocento-contact || fail 'Company contact service failed to start.'
  [[ -s /etc/rocento/contact.env ]] || info 'Contact form needs SMTP credentials: configure commerce-ops/deploy/aws-deploy/contact.env and redeploy.'
  if [[ -n ${FRONTEND_DIGEST:-} ]]; then
    install -d -m 755 /var/www/rocento/releases
    local release
    release=$(mktemp -d /var/www/rocento/releases/release-XXXXXXXX)
    cp -a "$WORK/public/." "$release/"
    find "$release" -type d -exec chmod 755 {} +
    find "$release" -type f -exec chmod 644 {} +
    [[ ! -e /var/www/rocento/current || -L /var/www/rocento/current ]] || fail '/var/www/rocento/current must be a managed symlink, not a directory.'
    ln -sfn "$release" /var/www/rocento/current.next
    mv -Tf /var/www/rocento/current.next /var/www/rocento/current
    state_set frontend.sha256 "$FRONTEND_DIGEST"
  fi
  ok 'Frontend publication complete'
}

public_health() {
  STAGE=public-health
  local host
  for host in "$DOMAIN" "grocery.$DOMAIN" "admin.$DOMAIN" "jewelry.$DOMAIN" "jewelry-admin.$DOMAIN" "electronics.$DOMAIN" "electronics-admin.$DOMAIN" "pharmacy.$DOMAIN" "pharmacy-admin.$DOMAIN" "apps.$DOMAIN"; do
    check_public_host "$host" || fail "Public endpoint verification failed for $host. See the specific Cloudflare/Nginx remediation above."
  done
  check_public_ready "https://admin.$DOMAIN/api/ready" || fail 'Public Grocery API route is not ready.'
  check_public_ready "https://jewelry-admin.$DOMAIN/api/ready" || fail 'Public Jewelry API route is not ready.'
  check_public_ready "https://electronics-admin.$DOMAIN/api/ready" || fail 'Public Electronics API route is not ready.'
  check_public_ready "https://pharmacy-admin.$DOMAIN/api/ready" || fail 'Public Pharmacy API route is not ready.'
  ok 'Public HTTPS endpoints and API routing'
}

summary() {
  cat <<EOF

=================================================
          ROCENTO DEPLOYMENT COMPLETE
=================================================
Architecture: $ARCH
Website: https://$DOMAIN
Grocery: https://grocery.$DOMAIN
Admin: https://admin.$DOMAIN
Jewelry: https://jewelry.$DOMAIN
Jewelry admin: https://jewelry-admin.$DOMAIN
Electronics: https://electronics.$DOMAIN
Electronics admin: https://electronics-admin.$DOMAIN
Pharmacy: https://pharmacy.$DOMAIN
Pharmacy admin: https://pharmacy-admin.$DOMAIN
Mobile App Studio: https://apps.$DOMAIN
Grocery API: READY
Jewelry API: READY
Electronics API: READY
TLS: VALID
Nginx: HEALTHY
Docker: HEALTHY
Deployment log: $DEPLOY_LOG
Status: sudo bash deploy/ec2/server/ec2-status.sh
Doctor: sudo bash deploy/ec2/server/ec2-doctor.sh
=================================================
EOF
}

preflight
if [[ $MODE == verify ]]; then
  verify_configuration
  internal_ready; public_health; ok "Verification complete. Log: $DEPLOY_LOG"; exit 0
fi
prepare_configuration
migration_preflight
prepare_reviewed_frontend
FRONTEND_CANDIDATE=/var/www/rocento/current
[[ -z ${FRONTEND_DIGEST:-} ]] || FRONTEND_CANDIDATE="$WORK/public"
python3 "$ROOT/commerce-ops/scripts/release/deployment_gate.py" artifacts "${RELEASE_ARGS[@]}" --frontend "$FRONTEND_CANDIDATE"
# Activate client-IP limits before gateways opt into ingress throttling mode.
publish_ingress
start_store grocery
start_store jewelry
start_store electronics
start_store pharmacy
internal_ready
verify_release_migrations
prepare_storefront_images
if [[ ${PRESERVE_AI:-0} == 1 ]]; then
  python3 "$ROOT/deploy/ec2/server/ec2-preserve-ai.py" verify "$ROCENTO_AI_BASELINE"
fi
publish_nginx
info 'Demo seeding is separate: sudo bash deploy/ec2/server/ec2-seed-demo.sh --store all'
public_health
python3 "$ROOT/commerce-ops/scripts/maintenance/cleanup-demo-backend-images.py"
summary
