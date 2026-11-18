"""Pure merchant Compose and Nginx rendering; no host IO or credentials."""
import uuid

# Reviewed 2026-11-12 against https://www.cloudflare.com/ips-v4 and
# https://www.cloudflare.com/ips-v6. This template module ships with the executor;
# never add loopback/private networks or arbitrary proxy header trust here.
CLOUDFLARE_NETWORKS = (
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22',
    '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
    '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22',
    '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
    '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
    '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32',
    '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29',
    '2c0f:f248::/32',
)

def render_compose(job, binding, inventory, publication_path):
    images = inventory['images']
    health = {'interval': '3s', 'timeout': '3s', 'retries': 20, 'start_period': '10s'}
    services = {}
    def service(name, image, env, memory, **extra):
        if image == 'api':
            extra.update(cap_drop=['ALL'], security_opt=['no-new-privileges:true'])
        services[name] = dict(image=images[image], restart='unless-stopped',
                              environment=env, mem_limit=memory, pids_limit=256,
                              networks=['tenant'], **extra)
    db = {'POSTGRES_DB': 'commerce', 'POSTGRES_USER': 'commerce', 'POSTGRES_PASSWORD': '${DB_PASSWORD:?}'}
    service('postgres', 'postgres', db, '768m', volumes=['postgres:/var/lib/postgresql/data'], healthcheck=dict(health, test=['CMD-SHELL', 'pg_isready -U commerce -d commerce']))
    service('engagement-postgres', 'postgres', db, '384m', volumes=['engagement:/var/lib/postgresql/data'], healthcheck=dict(health, test=['CMD-SHELL', 'pg_isready -U commerce -d commerce']))
    service('nats', 'nats', {}, '256m', command=['-js', '-sd', '/data'], volumes=['nats:/data'])
    # Host-derived indexing defaults can exceed this tenant's 512 MiB cgroup.
    # Leave room for search, task handling and mapped pages; the hard cap and
    # runtime OOM/restart checks still govern actual memory use.
    service('meilisearch', 'meili', {'MEILI_MASTER_KEY': '${MEILI_KEY:?}', 'MEILI_ENV': 'production',
        'MEILI_NO_ANALYTICS': 'true', 'MEILI_MAX_INDEXING_MEMORY': '134217728',
        'MEILI_MAX_INDEXING_THREADS': '1'}, '512m', volumes=['meili:/meili_data'])
    service('minio', 'minio', {'MINIO_ROOT_USER': 'commerce', 'MINIO_ROOT_PASSWORD': '${S3_PASSWORD:?}'}, '512m', command=['server', '/data'], volumes=['minio:/data'])
    service('clickhouse', 'clickhouse', {'CLICKHOUSE_DB': 'commerce_analytics', 'CLICKHOUSE_USER': 'commerce', 'CLICKHOUSE_PASSWORD': '${ANALYTICS_PASSWORD:?}'}, '2g', volumes=['clickhouse:/var/lib/clickhouse'], healthcheck=dict(health, test=['CMD', 'wget', '--spider', '-q', 'http://127.0.0.1:8123/ping']))
    services['clickhouse']['pids_limit'] = 1024
    env = {
        'DATABASE_URL': 'postgres://commerce:${DB_PASSWORD:?}@postgres:5432/commerce',
        'ENGAGEMENT_DATABASE_URL': 'postgres://commerce:${DB_PASSWORD:?}@engagement-postgres:5432/commerce',
        'APP_ENV': 'production', 'COOKIE_SECURE': 'true',
        'PUBLICATION_ENVIRONMENT': 'production', 'PUBLICATION_NOINDEX': 'true',
        # Empty only during the migration command; gateway startup fails closed.
        'PUBLICATION_INSTALLATION_ID': '${PUBLICATION_INSTALLATION_ID:-}',
        'PUBLICATION_APPROVED_ORIGIN': 'https://' + job['storefrontHost'] + '/',
        'PUBLICATION_INDEX_PATH': '/srv/publication/index.html',
        # nginx_config enforces per-client source limits before Docker proxying;
        # the gateway retains its database-backed account and tenant quotas.
        'AUTH_IP_RATE_LIMIT_MODE': 'ingress',
        # Support grids/routes require this tenant scope; assistant signing keys remain absent.
        'ASSISTANT_TENANT_ID': job['tenantId'],
        'AUTH_SECRET': '${AUTH_SECRET:?}', 'NOTIFICATION_MODE': 'smtp',
        'META_CREDENTIAL_KEY': '${META_CREDENTIAL_KEY:-}',
        'STOREFRONT_URL': 'https://' + job['storefrontHost'],
        'ALLOWED_ORIGINS': 'https://' + job['storefrontHost'] + ',https://' + job['adminHost'],
        'NATS_URL': 'nats://nats:4222', 'MEILI_URL': 'http://meilisearch:7700', 'MEILI_MASTER_KEY': '${MEILI_KEY:?}',
        'S3_ENDPOINT': 'http://minio:9000', 'S3_ACCESS_KEY': 'commerce', 'S3_SECRET_KEY': '${S3_PASSWORD:?}',
        'CLICKHOUSE_URL': 'http://clickhouse:8123', 'CLICKHOUSE_USER': 'commerce', 'CLICKHOUSE_PASSWORD': '${ANALYTICS_PASSWORD:?}',
    }
    for key in ('SMTP_HOST', 'SMTP_PORT', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'NOTIFICATION_FROM'):
        env[key] = '${' + key + ':?}'
    service('api-gateway', 'api', env, '1g', ports=[f'127.0.0.1:{binding["gatewayPort"]}:8080'],
            volumes=[{'type': 'bind', 'source': str(publication_path),
                      'target': '/srv/publication/index.html', 'read_only': True,
                      'bind': {'create_host_path': False}}],
            depends_on={'clickhouse': {'condition': 'service_healthy'}, 'postgres': {'condition': 'service_healthy'}, 'engagement-postgres': {'condition': 'service_healthy'}, **{k: {'condition': 'service_started'} for k in ('minio', 'nats', 'meilisearch')}},
            healthcheck=dict(health, test=['CMD', 'curl', '-fsS', 'http://localhost:8080/ready']))
    for worker, memory, probe in (
        ('analytics-worker', '512m', ['CMD', 'curl', '-fsS', 'http://localhost:8082/ready']),
        ('engagement-worker', '256m', ['CMD', 'engagement-worker', '--health']),
        ('export-worker', '512m', ['CMD', 'export-worker', '--health']),
    ):
        service(worker, 'api', env.copy(), memory, command=[worker],
                depends_on={'api-gateway': {'condition': 'service_healthy'}},
                healthcheck=dict(health, test=probe))
    return {'name': 'merchant-' + job['tenantId'], 'services': services,
            'networks': {'tenant': {}}, 'volumes': {name: {} for name in ('postgres', 'engagement', 'nats', 'meili', 'minio', 'clickhouse')}}



def nginx_config(job, binding, release):
    # Files are included together in Nginx's http context. Namespace every map
    # and zone so a new tenant cannot redefine another tenant's limits.
    # Keep variable names short enough for Nginx's default variables hash while
    # retaining the full UUID instead of truncating it and risking collisions.
    namespace = 'm' + uuid.UUID(job['tenantId']).hex
    result = f'''# Per-client budgets use only the direct peer or verified Cloudflare client IP.
map $uri ${namespace}_a {{
 default "";
 ~^/api/v1/(customer|admin)/auth/(login|register|request-verification|verify|forgot-password|reset-password)$ "$host:$binary_remote_addr";
}}
limit_req_zone ${namespace}_a zone={namespace}_auth:10m rate=20r/m;
map $uri ${namespace}_s {{
 default "";
 /api/v1/support/tickets "$host:$binary_remote_addr";
}}
map $uri ${namespace}_c {{
 default "";
 /api/v1/assistant/chat "$host:$binary_remote_addr";
}}
map $uri ${namespace}_m {{
 default "";
 ~^/api/v1/assistant/memory(?:/|$) "$host:$binary_remote_addr";
}}
map $uri ${namespace}_e {{
 default "";
 /api/v1/analytics/events "$host:$binary_remote_addr";
}}
limit_req_zone ${namespace}_s zone={namespace}_support:10m rate=6r/m;
limit_req_zone ${namespace}_c zone={namespace}_assistant:10m rate=32r/m;
limit_req_zone ${namespace}_m zone={namespace}_memory:10m rate=40r/m;
limit_req_zone ${namespace}_e zone={namespace}_analytics:10m rate=240r/m;
'''
    cloudflare = '\n'.join(' set_real_ip_from ' + network + ';' for network in CLOUDFLARE_NETWORKS)
    for kind, host in [('storefront', job['storefrontHost']), ('admin', job['adminHost'])]:
        merchant_reference = '''
 # Merchant reference is available only through the authenticated admin host.
 location = /api/v1/admin/api-reference/openapi.json { return 404; }
 location ^~ /api/v1/admin/api-reference/ { return 404; }
''' if kind == 'storefront' else ''
        result += f'''server {{
 listen 443 ssl;
 server_name {host};
 ssl_certificate /opt/rocento-onboarding/config/origin.pem;
 ssl_certificate_key /opt/rocento-onboarding/config/origin.key;
{cloudflare}
 real_ip_header CF-Connecting-IP;
 real_ip_recursive off;
 root {release}/artifacts/{kind};
 add_header X-Robots-Tag "noindex, nofollow" always;
 location = /__rocento_identity {{
   default_type application/json;
   add_header Cache-Control "no-store" always;
   return 200 '{{"tenantId":"{job['tenantId']}","artifactDigest":"{job['artifactDigest']}","surface":"{kind}"}}';
 }}
 # Match normalized paths before the general API proxy. Operational metrics
 # and the full first-party contract remain available only on loopback.
 location = /api/metrics {{ return 404; }}
 location ^~ /api/metrics/ {{ return 404; }}
 location = /api/openapi.json {{ return 404; }}
 location ^~ /api/openapi.json/ {{ return 404; }}
{merchant_reference}
 location /api/ {{
   limit_req zone={namespace}_auth burst=10 nodelay;
   limit_req zone={namespace}_support burst=10 nodelay;
   limit_req zone={namespace}_assistant burst=10 nodelay;
   limit_req zone={namespace}_memory burst=60 nodelay;
   limit_req zone={namespace}_analytics burst=60 nodelay;
   limit_req_status 429;
   error_page 429 = @merchant_rate_limited;
   proxy_pass http://127.0.0.1:{binding['gatewayPort']}/;
   proxy_set_header Host $host;
   proxy_set_header X-Forwarded-Proto https;
   proxy_set_header X-Forwarded-For "";
   proxy_set_header Forwarded "";
   proxy_set_header X-Real-IP "";
   proxy_set_header CF-Connecting-IP "";
   proxy_cache off;
 }}
 location @merchant_rate_limited {{
   default_type application/json;
   add_header Retry-After 3 always;
   add_header Cache-Control "no-store" always;
   return 429 '{{"error":"Too many authentication requests or public API requests; retry shortly"}}';
 }}
 location / {{ try_files $uri $uri/ /index.html; }}
}}
'''
    return result

