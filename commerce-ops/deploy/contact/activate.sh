#!/usr/bin/env bash
# Activate a staged company website/contact release without rebuilding stores.
set -Eeuo pipefail
exec 9>/opt/rocento/deploy/ec2/setup.lock
flock -n 9 || { echo 'Another deployment is running'; exit 1; }
stage=/home/ubuntu/.rocento-contact-stage
test -s "$stage/website/about/index.html"
test -s "$stage/contact.env"
previous=$(readlink -f /var/www/rocento/current)
[[ $previous == /var/www/rocento/releases/release-* && -d $previous/website ]]
release=$(mktemp -d /var/www/rocento/releases/release-XXXXXXXX)
cp -a "$previous/." "$release/"
cp -a "$stage/website/." "$release/website/"
find "$release" -type d -exec chmod 755 {} +
find "$release" -type f -exec chmod 644 {} +
install -d -m 755 /opt/rocento-contact
install -d -m 700 /etc/rocento
install -m 600 "$stage/contact.env" /etc/rocento/contact.env
install -m 644 "$stage/server.py" /opt/rocento-contact/server.py
install -m 644 "$stage/rocento-contact.service" /etc/systemd/system/rocento-contact.service
systemctl daemon-reload
systemctl enable --now rocento-contact
systemctl restart rocento-contact
systemctl is-active --quiet rocento-contact
backup=$(mktemp /etc/nginx/rocento-contact-backup.XXXXXXXX)
cp /etc/nginx/sites-available/rocento "$backup"
python3 - <<'PY'
from pathlib import Path
p = Path('/etc/nginx/sites-available/rocento')
text = p.read_text()
anchor = '    root /var/www/rocento/current/website;'
if text.count(anchor) != 1:
    raise SystemExit('Cannot identify the website Nginx block safely')
if 'location = /api/contact' not in text:
    text = text.replace(anchor, anchor + '''
    location = /api/contact {
        client_max_body_size 32k;
        proxy_pass http://127.0.0.1:8095;
        proxy_set_header Host $host;
        proxy_read_timeout 45s;
        add_header Cache-Control "no-store" always;
    }''')
    p.write_text(text)
PY
if ! nginx -t; then cp "$backup" /etc/nginx/sites-available/rocento; exit 1; fi
ln -sfn "$release" /var/www/rocento/current.next
mv -Tf /var/www/rocento/current.next /var/www/rocento/current
if ! systemctl reload nginx; then
  ln -sfn "$previous" /var/www/rocento/current.next
  mv -Tf /var/www/rocento/current.next /var/www/rocento/current
  cp "$backup" /etc/nginx/sites-available/rocento
  systemctl reload nginx
  exit 1
fi
echo 'Company website and contact service activated; previous release retained.'
