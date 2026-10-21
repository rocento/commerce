#!/usr/bin/env bash
set -euo pipefail
# Run from this repository on the production host, after reviewing the files.
if [[ $(id -u) != 0 ]]; then echo 'Run with sudo' >&2; exit 1; fi
exec 9>/opt/rocento/deploy/ec2/setup.lock
flock -n 9 || { echo 'Another deployment is running' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
case "$source_dir" in
    /opt/rocento/commerce-ops/deploy/health-dashboard|/opt/rocento/deploy/health-dashboard) ;;
    *) echo 'Install from /opt/rocento/commerce-ops/deploy/health-dashboard or /opt/rocento/deploy/health-dashboard' >&2; exit 1 ;;
esac
api_dir=/opt/rocento/commerce-api/health-api
web_dir=/opt/rocento/commerce-web/apps/health
[[ -f "$api_dir/server.py" && -f "$api_dir/collector.py" ]] || { echo 'Missing commerce-api/health-api source; upload it under /opt/rocento first' >&2; exit 1; }
[[ -s "$web_dir/index.html" && -s "$web_dir/app.js" && -s "$web_dir/style.css" ]] || { echo 'Missing commerce-web/apps/health frontend; upload it under /opt/rocento first' >&2; exit 1; }
getent passwd rocento-health >/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin rocento-health
install -d -m 0755 /var/lib/rocento-health
python3 -m py_compile "$api_dir/server.py" "$api_dir/collector.py"
for unit in rocento-health.service rocento-health-collector.service rocento-health-collector.timer; do
    install -m 0644 "$source_dir/$unit" "/etc/systemd/system/$unit"
done
systemd-analyze verify /etc/systemd/system/rocento-health.service /etc/systemd/system/rocento-health-collector.service /etc/systemd/system/rocento-health-collector.timer
install -m 0644 "$source_dir/nginx.conf" /etc/nginx/sites-available/rocento-health
ln -sfn /etc/nginx/sites-available/rocento-health /etc/nginx/sites-enabled/rocento-health
nginx -t
systemctl daemon-reload
systemctl start rocento-health-collector.service
systemctl enable --now rocento-health-collector.timer
systemctl enable rocento-health.service
systemctl restart rocento-health.service
systemctl reload nginx
systemctl is-active rocento-health.service rocento-health-collector.timer
