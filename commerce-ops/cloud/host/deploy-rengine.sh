#!/usr/bin/env bash
# Deploy only the diagnostics service; never restart commerce or AI services.
set -Eeuo pipefail
ROOT=/opt/rocento
SOURCE=
while (($#)); do
  case "$1" in
    --root|--source) [[ $# -ge 2 ]] || exit 2; case "$1" in --root) ROOT=$2;; --source) SOURCE=$2;; esac; shift 2;;
    *) echo 'Usage: sudo bash deploy/ec2/server/ec2-deploy-rengine.sh [--root path] [--source path]' >&2; exit 2;;
  esac
done
[[ $EUID == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
[[ -d "$ROOT/deploy/ec2" ]] || { echo 'Existing commerce installation required.' >&2; exit 1; }
exec 9>"$ROOT/deploy/ec2/setup.lock"
flock -n 9 || { echo 'Another deployment is active. Retry after it completes.' >&2; exit 1; }
python3 "${SOURCE:-$ROOT}/commerce-ops/workflows/release/deployment_gate.py" check --source "${SOURCE:-$ROOT}" --operation rengine
for store in grocery jewelry electronics pharmacy; do
  docker network inspect "rocento-${store}_assistant-private" "rocento-${store}_default" >/dev/null
done
[[ -s /etc/nginx/ssl/rocento-origin.pem && -s /etc/nginx/ssl/rocento-origin.key ]]
if [[ -n "$SOURCE" ]]; then
  for gate_file in deployment_gate.py release_readiness.py; do
    install -D -m 644 "$SOURCE/commerce-ops/workflows/release/$gate_file" "$ROOT/commerce-ops/workflows/release/$gate_file"
  done
  [[ -f "$SOURCE/commerce-web/apps/rengine/server.mjs" && -f "$SOURCE/commerce-ops/compose/overlays/cloud/compose.rengine.yaml" && -f "$SOURCE/commerce-ops/services/rengine/nginx.conf" ]]
  install -d "$ROOT/commerce-web/apps/rengine" "$ROOT/commerce-ops/compose/overlays/cloud" "$ROOT/commerce-ops/services/rengine"
  rsync -a --chown=ubuntu:ubuntu --delete --exclude='.env*' --exclude='node_modules' "$SOURCE/commerce-web/apps/rengine/" "$ROOT/commerce-web/apps/rengine/"
  install -o ubuntu -g ubuntu -m 644 "$SOURCE/commerce-ops/compose/overlays/cloud/compose.rengine.yaml" "$ROOT/commerce-ops/compose/overlays/cloud/compose.rengine.yaml"
  install -o ubuntu -g ubuntu -m 644 "$SOURCE/commerce-ops/services/rengine/nginx.conf" "$ROOT/commerce-ops/services/rengine/nginx.conf"
  install -D -o ubuntu -g ubuntu -m 755 "$SOURCE/commerce-ops/cloud/host/deploy-rengine.sh" "$ROOT/commerce-ops/cloud/host/deploy-rengine.sh"
  install -D -o ubuntu -g ubuntu -m 755 "$SOURCE/commerce-ops/deploy/ec2/server/ec2-deploy-rengine.sh" "$ROOT/deploy/ec2/server/ec2-deploy-rengine.sh"
fi
# Keep persistent credentials outside the rsynced application source.
python3 - "$ROOT" <<'PYSETUP'
import os, pathlib, secrets, sys
root=pathlib.Path(sys.argv[1]); private=root/'deploy/rengine-private'
private.mkdir(mode=0o700,exist_ok=True)
data=private/'data'; data.mkdir(mode=0o700,exist_ok=True); os.chown(data,1000,1000)
key=private/'key'
if not key.exists():
    if (data/'connections.enc').exists(): raise SystemExit('Missing encryption key for existing connections; provide the existing key before deploying.')
    key.write_bytes(secrets.token_bytes(32)); key.chmod(0o400); os.chown(key,1000,1000)
env=private/'operator.env'
if not env.exists():
    values={}
    for line in (root/'deploy/ec2/bootstrap.env').read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            k,v=line.split('=',1); values[k.strip()]=v.strip().strip('"\'')
    email=values.get('GROCERY_ADMIN_EMAIL','')
    if not email or any(c in email for c in '\r\n$'): raise SystemExit('Configure a valid operator email before deploying.')
    env.write_text('RENGINE_OWNER_STORE=grocery\nRENGINE_OWNER_EMAIL='+email+'\n');env.chmod(0o600)
PYSETUP
cd "$ROOT"
docker compose --project-directory commerce-ops/compose -f commerce-ops/compose/overlays/cloud/compose.rengine.yaml config --quiet
python3 "${SOURCE:-$ROOT}/commerce-ops/workflows/release/deployment_gate.py" artifacts --source "${SOURCE:-$ROOT}" --operation rengine
docker compose --project-directory commerce-ops/compose -f commerce-ops/compose/overlays/cloud/compose.rengine.yaml up -d --no-build --wait --wait-timeout 90
curl --fail --silent http://127.0.0.1:3190/health
install -m 644 commerce-ops/services/rengine/nginx.conf /etc/nginx/sites-available/rengine
ln -sfn /etc/nginx/sites-available/rengine /etc/nginx/sites-enabled/rengine
nginx -t
systemctl reload nginx
# Origin certificate validation is delegated to Cloudflare. This checks routing locally.
code=000
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  code=$(curl --noproxy '*' --silent --insecure --resolve rengine.rocento.com:443:127.0.0.1 -o /dev/null -w '%{http_code}' https://rengine.rocento.com/) || code=000
  [[ $code != 200 ]] || break
  # Nginx reload returns before the new worker generation begins accepting.
  sleep 1
done
[[ $code == 200 ]] || { echo "rengine origin returned HTTP $code" >&2; exit 1; }
echo "rengine deployed."
