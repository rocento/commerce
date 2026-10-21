#!/usr/bin/env bash
# Read-only deployment status. It deliberately never prints bootstrap secrets.
set -Eeuo pipefail

. "$(dirname -- "${BASH_SOURCE[0]}")/repository-root.sh"
ROOT=$(find_repo_root)
BOOTSTRAP="$ROOT/deploy/ec2/bootstrap.env"
[[ $EUID == 0 ]] || { echo 'ERROR: Run with sudo: sudo bash deploy/ec2/server/ec2-status.sh' >&2; exit 1; }
[[ -f $BOOTSTRAP ]] || { echo "ERROR: Missing $BOOTSTRAP" >&2; exit 1; }

domain=$(awk -F= '$1 == "DOMAIN" {print substr($0, length($1)+2); exit}' "$BOOTSTRAP")
[[ -n $domain ]] || { echo 'ERROR: DOMAIN is missing from bootstrap.env' >&2; exit 1; }
compose() { bash "$ROOT/deploy/ec2/server/ec2-compose.sh" "$@"; }
report() { printf '%-24s %s\n' "$1" "$2"; }
api_status() {
  local store=$1 port=$2 result
  if result=$(python3 "$ROOT/deploy/ec2/server/ec2-check.py" ready --url "http://127.0.0.1:$port/ready" 2>&1); then
    report " $store API" ready
  else
    report " $store API" "unhealthy (${result#ERROR: })"
  fi
}
db_value() {
  compose "$1" exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atqc \"$2\"" 2>/dev/null || true
}

echo 'Rocento Deployment Status'
echo
report Architecture "$(uname -m)"
if docker info >/dev/null 2>&1; then report Docker healthy; else report Docker unhealthy; fi
if systemctl is-active --quiet nginx; then report Nginx healthy; else report Nginx unhealthy; fi
if openssl x509 -in /etc/nginx/ssl/rocento-origin.pem -noout -checkend 86400 >/dev/null 2>&1; then report TLS valid; else report TLS invalid-or-expiring; fi
echo
for item in 'grocery 8080' 'jewelry 58080' 'electronics 59080' 'pharmacy 60080'; do
  set -- $item
  store=$1; port=$2
  echo "${store^}"
  api_status "$store" "$port"
  report " $store PostgreSQL" "$(compose "$store" ps --format json postgres 2>/dev/null | grep -Eq '"Health"[[:space:]]*:[[:space:]]*"healthy"' && echo healthy || echo unknown)"
  report " $store Engagement DB" "$(compose "$store" ps --format json engagement-postgres 2>/dev/null | grep -Eq '"Health"[[:space:]]*:[[:space:]]*"healthy"' && echo healthy || echo unknown)"
  report " $store Engagement worker" "$(compose "$store" ps --format json engagement-worker 2>/dev/null | grep -Eq '"Health"[[:space:]]*:[[:space:]]*"healthy"' && echo healthy || echo unknown)"
  report " $store ClickHouse" "$(compose "$store" ps --format json clickhouse 2>/dev/null | grep -Eq '"Health"[[:space:]]*:[[:space:]]*"healthy"' && echo healthy || echo unknown)"
  report " $store Meilisearch" "$(compose "$store" ps --format json meilisearch 2>/dev/null | grep -Eq '"Health"[[:space:]]*:[[:space:]]*"healthy"' && echo healthy || echo unknown)"
  report " $store MinIO" "$(compose "$store" ps --format json minio 2>/dev/null | grep -Eq '"Health"[[:space:]]*:[[:space:]]*"healthy"' && echo healthy || echo unknown)"
  report " $store NATS" "$(compose "$store" ps --format json nats 2>/dev/null | grep -Eq '"Health"[[:space:]]*:[[:space:]]*"healthy"' && echo healthy || echo unknown)"
  admins=$(db_value "$store" 'SELECT count(*) FROM admin_iam.admin_users WHERE active;')
  products=$(db_value "$store" 'SELECT count(*) FROM catalog.products;')
  report " $store Admin" "${admins:-0} active"
  report " $store Demo" "${products:-0} products"
  echo
done
echo Public
for host in "$domain" "grocery.$domain" "admin.$domain" "jewelry.$domain" "jewelry-admin.$domain" "electronics.$domain" "electronics-admin.$domain" "pharmacy.$domain" "pharmacy-admin.$domain" "apps.$domain"; do
  if output=$(python3 "$ROOT/deploy/ec2/server/ec2-check.py" public --host "$host" 2>&1); then report " $host" 200; else report " $host" "failed (${output#ERROR: })"; fi
done
