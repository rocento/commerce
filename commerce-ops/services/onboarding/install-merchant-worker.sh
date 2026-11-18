#!/usr/bin/env bash
# Run as root from the uploaded repository. Does not approve any release.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run as root on the onboarding host' >&2; exit 1; }
root=$(cd "$(dirname "$0")/../../.." && pwd)
assets="$root/commerce-ops/services/onboarding"
command -v terraform >/dev/null || { echo "Install reviewed Terraform >=1.10,<2 before installing the fleet worker" >&2; exit 1; }
install -d -m 755 /usr/local/lib/rocento /etc/rocento/merchant-provisioning
install -m 755 "$root/commerce-ops/cloud/host/merchant_executor.py" /usr/local/lib/rocento/merchant-executor.py
install -m 644 "$root/commerce-ops/cloud/host/merchant_templates.py" /usr/local/lib/rocento/merchant_templates.py
install -m 644 "$root/commerce-ops/cloud/controller/merchant_fleet.py" /usr/local/lib/rocento/merchant_fleet.py
install -m 644 "$root/commerce-ops/cloud/controller/fleet_terraform.py" /usr/local/lib/rocento/fleet_terraform.py
install -m 644 "$root/commerce-ops/cloud/controller/fleet_release.py" /usr/local/lib/rocento/fleet_release.py
install -m 755 "$root/commerce-ops/cloud/host/fleet_bootstrap.py" /usr/local/lib/rocento/fleet-bootstrap.py
install -d -m 755 /usr/local/lib/rocento/fleet-bootstrap-assets
install -m 644 "$assets/metadata-firewall.nft" "$assets/metadata-firewall.service" /usr/local/lib/rocento/fleet-bootstrap-assets/
for provider in aws gcp hetzner; do
  install -d -m 755 "/usr/local/lib/rocento/merchant-terraform/$provider"
  for file in main.tf.json .terraform.lock.hcl; do
    install -m 644 "$root/commerce-ops/cloud/controller/merchant-terraform/$provider/$file" "/usr/local/lib/rocento/merchant-terraform/$provider/$file"
  done
done
install -m 644 "$root/commerce-ops/cloud/controller/fleet_providers.py" /usr/local/lib/rocento/fleet_providers.py
install -m 755 "$root/commerce-ops/cloud/host/fleet_node.py" /usr/local/lib/rocento/fleet-node.py
install -m 755 "$root/commerce-ops/cloud/host/tenant_controls.py" /usr/local/lib/rocento/tenant-controls.py
install -m 644 "$assets/merchant-fleet.service" /etc/systemd/system/rocento-merchant-fleet.service
install -m 644 "$assets/merchant-fleet.timer" /etc/systemd/system/rocento-merchant-fleet.timer
# Fleet creation is opt-in: configure fleet.json, credentials and pinned releases,
# then enable the timer explicitly. This installer does not enable the fleet timer.

install -m 644 "$root/commerce-ops/workflows/release/release_readiness.py" /usr/local/lib/rocento/release_readiness.py
install -m 755 "$assets/verify-merchant-candidate.py" /usr/local/lib/rocento/verify-merchant-candidate.py
install -m 755 "$assets/onboarding-executor" /usr/local/lib/rocento/onboarding-executor
id rocento-provisioner >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin rocento-provisioner
visudo -cf "$assets/merchant-executor.sudoers"
install -m 440 "$assets/merchant-executor.sudoers" /etc/sudoers.d/rocento-merchant-executor
container=$(docker create rocento-onboarding-api:test)
trap 'docker rm "$container" >/dev/null' EXIT
docker cp "$container:/usr/local/bin/provisioning-worker" /usr/local/bin/.rocento-provisioning-worker.new
chown root:root /usr/local/bin/.rocento-provisioning-worker.new
chmod 755 /usr/local/bin/.rocento-provisioning-worker.new
mv /usr/local/bin/.rocento-provisioning-worker.new /usr/local/bin/rocento-provisioning-worker
python3 - <<'PY'
import json, os
from pathlib import Path
os.umask(0o077)
values={}
for line in Path('/opt/rocento-onboarding/config/api.env').read_text().splitlines():
    if line and not line.startswith('#') and '=' in line:
        key,value=line.split('=',1);values[key]=value.strip().strip('"').strip("'")
mapping={'SMTP_HOST':'SMTP_HOST','SMTP_PORT':'SMTP_PORT','SMTP_USERNAME':'SMTP_USER','SMTP_PASSWORD':'SMTP_PASSWORD','NOTIFICATION_FROM':'MAIL_FROM'}
result={key:values[source] for key,source in mapping.items()}
path=Path('/etc/rocento/merchant-provisioning/smtp.json')
if path.exists() and json.loads(path.read_text())!=result:
    raise SystemExit('Existing merchant SMTP settings differ; review rotation separately')
if not path.exists():
    path.write_text(json.dumps(result));path.chmod(0o600)
PY
install -m 644 "$assets/merchant-default.conf" /etc/nginx/conf.d/merchant-default.conf
nginx -t
systemctl reload nginx
install -m 644 "$assets/merchant-worker.service" /etc/systemd/system/rocento-merchant-worker.service
systemctl daemon-reload
# Never run the Compose worker and host worker as separate active owners.
docker compose -f "$assets/compose.yaml" stop provisioning-worker
systemctl enable rocento-merchant-worker.service
systemctl restart rocento-merchant-worker.service
systemctl is-active rocento-merchant-worker.service
