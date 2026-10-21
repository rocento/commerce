#!/usr/bin/env bash
# Explicit demo data setup for an already deployed EC2 installation.
set -Eeuo pipefail
. "$(dirname -- "${BASH_SOURCE[0]}")/repository-root.sh"
ROOT=$(find_repo_root)
BOOTSTRAP="$ROOT/deploy/ec2/bootstrap.env"
DEFAULT_CERT=/etc/nginx/ssl/rocento-origin.pem
MODE=seed
SEED_TARGET=all
DELIVERY_AREAS_STDIN=0
DELIVERY_ONLY=0
EXPAND_COVERAGE=0
WORK=
HOSTS_BACKUP=
HOSTS_CHANGED=0
STAGE=preflight
say() { printf '%s %s\n' "$1" "$2"; }
ok() { say '[OK]' "$*"; }
info() { say '[INFO]' "$*"; }
fail() { say 'ERROR:' "$*" >&2; exit 1; }
compose() { bash "$ROOT/deploy/ec2/server/ec2-compose.sh" "$@"; }
usage() {
  cat <<'HELP'
Usage: sudo bash deploy/ec2/server/ec2-seed-demo.sh [--store all|grocery|jewelry|electronics|pharmacy] [--delivery-only] [--expand-coverage]

Explicitly seed an existing deployment using deploy/ec2/bootstrap.env.
Includes demo administrator setup, products, themes, category images and areas.
DEMO_ADMIN_ENFORCE=1 applies administrator enforcement to the selected stores
and synchronizes the grocery palette when grocery is selected.
Existing assigned themes and targeting rules are preserved while catalog data is seeded.
This command does not build, deploy, restart services or rewrite Nginx configuration.
--delivery-areas-stdin reads demo area JSON uploaded by the local launcher.
--delivery-only seeds delivery configuration and inventory for existing demo catalogs.
--expand-coverage adds missing Egypt zones without changing existing custom areas;
requires --delivery-only.
HELP
}
while (($#)); do
  case "$1" in
    --delivery-only) DELIVERY_ONLY=1; shift ;;
    --expand-coverage) EXPAND_COVERAGE=1; shift ;;
    --delivery-areas-stdin) DELIVERY_AREAS_STDIN=1; shift ;;
    --store)
      (($# >= 2)) || fail 'Missing store after --store.'
      case "$2" in all|grocery|jewelry|electronics|pharmacy) SEED_TARGET=$2 ;; *) fail "Unknown store: $2" ;; esac
      shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1. Run --help for usage." ;;
  esac
done
if (( EXPAND_COVERAGE && ! DELIVERY_ONLY )); then
  fail '--expand-coverage requires --delivery-only.'
fi
[[ $EUID == 0 ]] || fail 'Run with sudo: sudo bash deploy/ec2/server/ec2-seed-demo.sh'
. "$ROOT/deploy/ec2/server/ec2-bootstrap.sh"

cleanup() {
  local status=$?
  restore_seed_hosts || true
  [[ -z $WORK ]] || rm -rf -- "$WORK"
  if (( status != 0 )); then
    say 'ERROR:' "Demo seeding stopped during: $STAGE. Existing services were not redeployed. See $SEED_LOG."
  fi
}
temporary_seed_hosts() {
  STAGE=internal-https
  HOSTS_BACKUP="$WORK/hosts.before-seed"
  cp /etc/hosts "$HOSTS_BACKUP"
  awk -v d="$DOMAIN" '
    BEGIN { split("admin." d " jewelry-admin." d " electronics-admin." d " pharmacy-admin." d, names, " "); for (n in names) blocked[names[n]]=1 }
    { keep=1; for (i=2; i<=NF; i++) if ($i in blocked) keep=0; if (keep) print }
  ' /etc/hosts > "$WORK/hosts.filtered"
  cat >> "$WORK/hosts.filtered" <<EOF
# Managed temporary Rocento internal HTTPS seed route. Restored on exit.
127.0.0.1 admin.$DOMAIN jewelry-admin.$DOMAIN electronics-admin.$DOMAIN pharmacy-admin.$DOMAIN
EOF
  install -m 644 "$WORK/hosts.filtered" /etc/hosts
  HOSTS_CHANGED=1
  local store host
  for store in "${STORES[@]}"; do
    host=admin; [[ $store == grocery ]] || host="$store-admin"
    python3 "$ROOT/deploy/ec2/server/ec2-check.py" ready --url "https://$host.$DOMAIN/api/ready" --ca-file "$DEFAULT_CERT"
  done
  ok 'Internal HTTPS seed route (Nginx, loopback, certificate verification)'
}

restore_seed_hosts() {
  if (( HOSTS_CHANGED )) && [[ -n $HOSTS_BACKUP && -f $HOSTS_BACKUP ]]; then
    cp -f "$HOSTS_BACKUP" /etc/hosts
    HOSTS_CHANGED=0
  fi
}

admin_email() {
  compose "$1" exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SELECT lower(email) FROM admin_iam.admin_users ORDER BY created_at,id LIMIT 1"' | tr -d '[:space:]'
}

enforce_demo_administrators() {
  [[ ${DEMO_ADMIN_ENFORCE:-0} == 1 ]] || return 0
  local store prefix email_name password_name
  for store in "${STORES[@]}"; do
    STAGE="$store-demo-admin-enforcement"
    prefix=$(printf '%s' "$store" | tr '[:lower:]' '[:upper:]')
    email_name=${prefix}_ADMIN_EMAIL
    password_name=${prefix}_ADMIN_PASSWORD
    export BOOTSTRAP_ADMIN_PASSWORD="${!password_name}"
    compose "$store" exec -T -e BOOTSTRAP_ADMIN_PASSWORD api-gateway seed-admin \
      --enforce-demo-admin --email "${!email_name}"
    unset BOOTSTRAP_ADMIN_PASSWORD
    ok "$store configured as a single-administrator demo"
  done
}

bootstrap_and_seed() {
  temporary_seed_hosts
  local stores=(grocery jewelry electronics pharmacy) store email_name password_name found host
  local options
  [[ $SEED_TARGET == all ]] || stores=("$SEED_TARGET")
  for store in "${stores[@]}"; do
    email_name=$(printf '%s_ADMIN_EMAIL' "$store" | tr '[:lower:]' '[:upper:]')
    password_name=$(printf '%s_ADMIN_PASSWORD' "$store" | tr '[:lower:]' '[:upper:]')
    if (( DELIVERY_ONLY )); then
      STAGE="$store-delivery-seed"
      host=admin; [[ $store == grocery ]] || host="$store-admin"
      export DEMO_ADMIN_EMAIL="${!email_name}" DEMO_ADMIN_PASSWORD="${!password_name}" DEMO_SSL_CA_FILE="$DEFAULT_CERT"
      options=(--store "$store" --apply --api-base "https://$host.$DOMAIN/api")
      if (( EXPAND_COVERAGE )); then options+=(--expand-coverage); fi
      python3 "$ROOT/commerce-assets/demo/seed-delivery-areas.py" "${options[@]}"
      unset DEMO_ADMIN_EMAIL DEMO_ADMIN_PASSWORD DEMO_SSL_CA_FILE
      ok "$store delivery network seeded; catalog, themes and administrators preserved"
      continue
    fi
    STAGE="$store-admin-bootstrap"
    found=$(admin_email "$store")
    if [[ -z $found ]]; then
      export BOOTSTRAP_ADMIN_PASSWORD="${!password_name}"
      compose "$store" exec -T -e BOOTSTRAP_ADMIN_PASSWORD api-gateway seed-admin --email "${!email_name}"
      unset BOOTSTRAP_ADMIN_PASSWORD
      ok "$store administrator bootstrapped"
    elif [[ $found == "$(printf '%s' "${!email_name}" | tr '[:upper:]' '[:lower:]')" ]]; then
      ok "$store administrator matches bootstrap configuration"
    else
      fail "$store already has administrator $found, but $BOOTSTRAP configures ${!email_name}. Set $email_name to the existing email and rerun; deployment will not create a duplicate administrator."
    fi
    STAGE="$store-seed"
    host=admin; if [[ $store != grocery ]]; then host="$store-admin"; fi
    export DEMO_ADMIN_EMAIL="${!email_name}" DEMO_ADMIN_PASSWORD="${!password_name}" DEMO_SSL_CA_FILE="$DEFAULT_CERT"
    info "Refreshing $store demo through local verified HTTPS (Cloudflare is bypassed)"
    options=(--apply --publish --preserve-theme --complete)
    if [[ $store == grocery && ${DEMO_ADMIN_ENFORCE:-0} == 1 ]]; then
      options+=(--sync-palette)
    fi
    python3 "$ROOT/commerce-ops/scripts/seed-demo-storefront.py" "$store" "${options[@]}" --api-base "https://$host.$DOMAIN/api"
    ok "$store demo refreshed and verified"
    touch "$ROOT/deploy/ec2/$store.seeded"
    unset DEMO_ADMIN_EMAIL DEMO_ADMIN_PASSWORD DEMO_SSL_CA_FILE
  done
  restore_seed_hosts
}

mkdir -p /var/log/rocento/seeds
SEED_LOG="/var/log/rocento/seeds/$(date -u +%Y-%m-%dT%H-%M-%SZ).log"
exec > >(tee -a "$SEED_LOG") 2>&1
trap cleanup EXIT
load_bootstrap
python3 "$ROOT/commerce-ops/deploy/ec2/configure.py" validate-domain --domain "$DOMAIN"
for dependency in docker python3 flock; do
  command -v "$dependency" >/dev/null || fail "Missing $dependency. Run deployment first."
done
[[ -s $DEFAULT_CERT ]] || fail 'Origin certificate is missing. Run deployment first.'
exec 9>"$ROOT/deploy/ec2/setup.lock"
flock -n 9 || fail 'Another deployment or seed is active. Wait for it to finish.'
STORES=(grocery jewelry electronics pharmacy)
[[ $SEED_TARGET == all ]] || STORES=("$SEED_TARGET")
for store in "${STORES[@]}"; do
  [[ -f "$ROOT/deploy/ec2/$store.env" ]] || fail "$store is not deployed. Run deploy/ec2/server/ec2-up.sh first."
done
WORK=$(mktemp -d)
if (( DELIVERY_AREAS_STDIN )); then
  STAGE=delivery-area-upload
  export DEMO_DELIVERY_AREAS_FILE="$WORK/delivery-areas.json"
  cat > "$DEMO_DELIVERY_AREAS_FILE"
  [[ -s $DEMO_DELIVERY_AREAS_FILE ]] || fail 'Uploaded delivery-area definitions are empty.'
fi
STAGE=delivery-area-validation
python3 "$ROOT/commerce-assets/demo/seed-delivery-areas.py" --store "${STORES[0]}" >/dev/null
ok 'Demo delivery-area definitions validated'
temporary_seed_hosts
restore_seed_hosts
if (( ! DELIVERY_ONLY )); then enforce_demo_administrators; fi
bootstrap_and_seed
ok "Demo seeding complete for $SEED_TARGET. Log: $SEED_LOG"
