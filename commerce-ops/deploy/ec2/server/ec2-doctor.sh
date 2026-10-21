#!/usr/bin/env bash
# Read-only diagnostics with actionable checks for the common EC2/Cloudflare failures.
set -Eeuo pipefail

. "$(dirname -- "${BASH_SOURCE[0]}")/repository-root.sh"
ROOT=$(find_repo_root)
BOOTSTRAP="$ROOT/deploy/ec2/bootstrap.env"
[[ $EUID == 0 ]] || { echo 'ERROR: Run with sudo: sudo bash deploy/ec2/server/ec2-doctor.sh' >&2; exit 1; }
[[ -f $BOOTSTRAP ]] || { echo "ERROR: Missing $BOOTSTRAP. Copy commerce-ops/deploy/ec2/bootstrap.env.example to deploy/ec2/bootstrap.env and chmod 600 it." >&2; exit 1; }
domain=$(awk -F= '$1 == "DOMAIN" {print substr($0, length($1)+2); exit}' "$BOOTSTRAP")
cert=$(awk -F= '$1 == "ORIGIN_CERT" {print substr($0, length($1)+2); exit}' "$BOOTSTRAP")
key=$(awk -F= '$1 == "ORIGIN_KEY" {print substr($0, length($1)+2); exit}' "$BOOTSTRAP")
problem=0
pass() { echo "[OK] $*"; }
issue() { echo "[FAIL] $*"; problem=1; }
compose() { bash "$ROOT/deploy/ec2/server/ec2-compose.sh" "$@"; }

echo 'Rocento Deployment Doctor'
echo
case "$(uname -m)" in x86_64|aarch64|arm64) pass "Architecture: $(uname -m)" ;; *) issue "Unsupported architecture: $(uname -m). Use x86_64 or aarch64." ;; esac
disk=$(df -Pm "$ROOT" | awk 'NR==2 {print $4}')
(( disk >= 30000 )) && pass "Disk: $((disk / 1000))GB available" || issue "Disk: only $((disk / 1000))GB available; expand the EBS volume to leave at least 30GB."
memory=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
(( memory >= 4096 )) && pass "Memory: $((memory / 1024))GB" || issue "Memory: only $((memory / 1024))GB; use an instance with at least 4GB RAM."
docker info >/dev/null 2>&1 && pass 'Docker healthy' || issue 'Docker unavailable; run systemctl status docker.'
docker compose version >/dev/null 2>&1 && pass "Docker Compose $(docker compose version --short)" || issue 'Docker Compose plugin missing.'
nginx -t >/dev/null 2>&1 && pass 'Nginx configuration valid' || issue 'Nginx configuration invalid; run nginx -t.'
systemctl is-active --quiet nginx && pass 'Nginx running' || issue 'Nginx is not running; run systemctl status nginx.'
[[ -s $cert && -s $key ]] && pass 'TLS files present' || issue 'Origin certificate/key missing; check ORIGIN_CERT and ORIGIN_KEY in bootstrap.env.'
if [[ -s $cert && -s $key ]]; then
  openssl x509 -in "$cert" -noout -checkend 86400 >/dev/null && pass 'TLS certificate valid' || issue 'TLS certificate is expired or expires within 24 hours.'
  cert_pub=$(mktemp); key_pub=$(mktemp); trap 'rm -f "$cert_pub" "$key_pub"' EXIT
  openssl x509 -in "$cert" -pubkey -noout > "$cert_pub" && openssl pkey -in "$key" -pubout > "$key_pub" && cmp -s "$cert_pub" "$key_pub" && pass 'TLS certificate/key match' || issue 'TLS certificate and private key do not match.'
fi
for spec in 'grocery 8080' 'jewelry 58080' 'electronics 59080' 'pharmacy 60080'; do
  set -- $spec
  if python3 "$ROOT/deploy/ec2/server/ec2-check.py" ready --url "http://127.0.0.1:$2/ready"; then :; else issue "${1^} API is unavailable. Run: sudo bash deploy/ec2/server/ec2-compose.sh $1 logs --tail=100 api-gateway"; fi
done
for host in "$domain" "grocery.$domain" "admin.$domain" "jewelry.$domain" "jewelry-admin.$domain" "electronics.$domain" "electronics-admin.$domain" "pharmacy.$domain" "pharmacy-admin.$domain" "apps.$domain"; do
  python3 "$ROOT/deploy/ec2/server/ec2-check.py" dns --host "$host" || issue "DNS missing for $host."
  python3 "$ROOT/deploy/ec2/server/ec2-check.py" public --host "$host" || issue "Public HTTPS issue for $host. For redirect loops set Cloudflare SSL/TLS to Full (strict)."
done
echo
(( problem == 0 )) && echo 'Doctor found no deployment failures.' || echo 'Doctor found failures. Resolve the remediation above, then rerun sudo bash deploy/ec2/server/ec2-up.sh.'
exit "$problem"
