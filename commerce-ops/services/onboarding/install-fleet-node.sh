#!/usr/bin/env bash
# Run on a fresh Ubuntu merchant VM during pinned release installation.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run as root on the fresh merchant VM' >&2; exit 1; }
[[ ! -e /opt/rocento-merchants/ports.json && ! -e /opt/rocento-onboarding/config/api.env ]] || {
  echo 'Refusing to install a node containing merchant or control-plane state' >&2; exit 1;
}
root=$(cd "$(dirname "$0")/../../.." && pwd)
docker compose version >/dev/null
command -v nginx >/dev/null
command -v cloud-init >/dev/null
command -v iptables >/dev/null
command -v nft >/dev/null
install -d -m 755 /usr/local/lib/rocento /etc/rocento/merchant-provisioning
install -m 755 "$root/commerce-ops/cloud/host/fleet_node.py" /usr/local/lib/rocento/fleet-node.py
install -m 755 "$root/commerce-ops/cloud/host/merchant_executor.py" /usr/local/lib/rocento/merchant-executor.py
install -m 644 "$root/commerce-ops/cloud/host/merchant_templates.py" /usr/local/lib/rocento/merchant_templates.py
install -m 755 "$root/commerce-ops/cloud/host/tenant_controls.py" /usr/local/lib/rocento/tenant-controls.py
install -m 644 "$root/commerce-ops/workflows/release/release_readiness.py" /usr/local/lib/rocento/release_readiness.py
install -m 644 "$root/commerce-ops/services/onboarding/merchant-default.conf" /usr/local/lib/rocento/merchant-default.conf
install -m 644 "$root/commerce-ops/services/onboarding/metadata-firewall.nft" /etc/rocento/metadata-firewall.nft
install -m 644 "$root/commerce-ops/services/onboarding/metadata-firewall.service" /etc/systemd/system/rocento-metadata-firewall.service
install -d -m 755 /etc/systemd/system/docker.service.d
cat > /etc/systemd/system/docker.service.d/rocento-metadata.conf <<'EOF'
[Unit]
Requires=rocento-metadata-firewall.service
After=rocento-metadata-firewall.service
EOF
systemctl daemon-reload
systemctl enable --now rocento-metadata-firewall.service
echo 'Node tools installed; release verification is still required.'
