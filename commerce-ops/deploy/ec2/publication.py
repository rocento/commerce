#!/usr/bin/env python3
"""Opt-in merchant storefront proxy. Does not alter existing demo/admin vhosts."""
import argparse
import re


def merchant_nginx(host, gateway_port=8080, renderer_port=8081):
    labels = host.split('.')
    if (len(host) > 253 or len(labels) < 2 or
            all(label.isdigit() for label in labels) or
            any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label)
                or label in ('localhost', 'local', 'internal', 'admin', 'demo', 'staging', 'stage')
                or label.endswith('-admin') or label.startswith('admin-') for label in labels)):
        raise ValueError('Use an operator-approved public merchant DNS hostname')
    if not 1024 <= gateway_port <= 65535 or not 1024 <= renderer_port <= 65535:
        raise ValueError('Use a valid private gateway port')
    return f'''# Opt-in production merchant only. Keep demo/admin configuration separate.
# Install exactly one rejecting default per ingress; do not duplicate default_server.
server {{
    listen 443 ssl;
    server_name {host};
    if ($host != {host}) {{ return 421; }}
    ssl_certificate /etc/nginx/ssl/rocento-origin.pem;
    ssl_certificate_key /etc/nginx/ssl/rocento-origin.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    root /var/www/rocento/current/storefront;
    location ~ ^/(assets|brand|fonts|data)/ {{
        try_files $uri =404;
    }}
    location = /api {{ return 308 /api/; }}
    location /api/ {{
        proxy_pass http://127.0.0.1:{gateway_port}/;
        proxy_set_header Host {host};
        proxy_set_header X-Forwarded-Host "";
        proxy_set_header Forwarded "";
        add_header X-Robots-Tag "noindex, nofollow" always;
        add_header Cache-Control "no-store" always;
    }}
    location / {{
        proxy_pass http://127.0.0.1:{renderer_port};
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host "";
        proxy_set_header Forwarded "";
        proxy_cache off;
        # Preserve the gateway's dynamic X-Robots-Tag and Cache-Control.
    }}
}}
'''


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True)
    parser.add_argument('--gateway-port', type=int, default=8080)
    parser.add_argument('--renderer-port', type=int, default=8081)
    args = parser.parse_args()
    print(merchant_nginx(args.host, args.gateway_port, args.renderer_port), end='')
