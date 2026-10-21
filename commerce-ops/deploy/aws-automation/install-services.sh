#!/bin/sh
# Run as root on the demo host after the root-only controller.env and tunnel key exist.
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=/opt/rocento-preview-control
install -m 600 "$source_dir/controller.py" "$root/controller.py"
python3 - "$root" <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1]); env=root/'controller.env'
values=dict(line.split('=',1) for line in env.read_text().splitlines() if '=' in line)
assert len(values['MOBILE_ANDROID_PREVIEW_WORKER_TOKEN']) >= 32
values.update(AWS_REGION='eu-central-1',ANDROID_EC2_INSTANCE_ID='i-0af639278db7286a9')
env.write_text(''.join(k+'='+v+'\n' for k,v in values.items()));env.chmod(0o600)
(root/'known_hosts').write_text('172.31.20.210 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM6z62ZqmBOM4yUqxsDBFGUAGR32IIvVd8ST3U6ywUN5\n')
PY
cat > /etc/systemd/system/rocento-android-tunnel.service <<'UNIT'
[Unit]
Description=Private forwarding-only connection to Android preview worker
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/bin/ssh -N -T -i /opt/rocento-preview-control/tunnel-key -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/opt/rocento-preview-control/known_hosts -o ExitOnForwardFailure=yes -o ConnectTimeout=5 -o ServerAliveInterval=15 -o ServerAliveCountMax=2 -L 127.0.0.1:19096:127.0.0.1:19096 ubuntu@172.31.20.210
Restart=always
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/rocento-android-controller.service <<'UNIT'
[Unit]
Description=Rocento scoped Android EC2 lifecycle controller
After=network-online.target
Wants=network-online.target
[Service]
EnvironmentFile=/opt/rocento-preview-control/controller.env
Environment=PYTHONUNBUFFERED=1
ExecStart=/opt/rocento-preview-control/venv/bin/python /opt/rocento-preview-control/controller.py
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now rocento-android-tunnel rocento-android-controller
