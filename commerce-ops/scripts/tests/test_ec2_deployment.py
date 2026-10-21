"""Deployment checks that do not start containers or change the host."""
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError
from urllib.robotparser import RobotFileParser

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('ec2_config', ROOT / 'commerce-ops/deploy/ec2/configure.py')
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)


class EC2DeploymentTests(unittest.TestCase):
    def test_delivery_lookup_is_public_bounded_and_credential_free(self):
        rendered = config.nginx('example.com')
        self.assertEqual(rendered.count('location = /api/v1/location-address {'), 5)
        self.assertEqual(config.delivery_geocoding_nginx(rendered, 'example.com'), rendered)
        self.assertEqual(rendered.count('proxy_pass_request_headers off;'), 5)
        self.assertEqual(rendered.count('proxy_ssl_verify on;'), 5)
        self.assertIn('rate=1r/s', rendered)
        self.assertIn('proxy_cache_lock on;', rendered)
        self.assertIn('if ($request_method != GET) { return 405; }', rendered)
        self.assertIn('access_log off;', rendered)
        self.assertIn('radius=0.2$delivery_geocode_language', rendered)
        self.assertNotIn('lang=ar', rendered)

    def test_detached_configuration_targets_active_checkout(self):
        script = (ROOT / 'commerce-ops/deploy/ec2/server/ec2-up.sh').read_text()
        function = 'prepare_configuration() {' + script.split('prepare_configuration() {', 1)[1].split('\nverify_configuration()', 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'active'
            stage = Path(directory) / 'upload'
            config_dir = root / 'deploy/ec2'
            config_dir.mkdir(parents=True)
            stage.mkdir()
            (config_dir / 'configure.py').write_text('''import argparse
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument('mode')
p.add_argument('--domain')
p.add_argument('--directory', type=Path, default=Path('deploy/ec2'))
a = p.parse_args()
a.directory.mkdir(parents=True, exist_ok=True)
for store in ('grocery', 'jewelry', 'electronics', 'pharmacy'):
    (a.directory / (store + '.env')).write_text('test-only=true\\n')
''')
            harness = '''set -euo pipefail
PRESERVE_AI=0
DOMAIN=rocento.com
STATE="$ROOT/deploy/ec2/state"
docker() { return 1; }
compose() { test -f "$ROOT/deploy/ec2/$1.env"; }
ok() { :; }
fail() { echo "$*" >&2; exit 1; }
'''
            result = subprocess.run(['bash', '-c', harness + function + '\nprepare_configuration\n'],
                                    cwd=stage, env={**os.environ, 'ROOT': str(root)}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((config_dir / 'grocery.env').is_file())
            self.assertFalse((stage / 'deploy').exists())

    def test_analytics_worker_release_and_delivery_mode_follow_gateway(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            for mode in ('console', 'smtp'):
                if mode == 'smtp':
                    smtp = path / 'notifications.env'
                    smtp.write_text('SMTP_PASSWORD=private-test-value\n')
                    smtp.chmod(0o600)
                config.prepare(path, 'rocento.com')
                rendered = (path / 'common.yaml').read_text()
                # Split on a service boundary, not its indented attributes.
                worker = re.split(r'\n  [a-z][a-z-]*:', rendered.split('  analytics-worker:\n', 1)[1])[0]
                self.assertIn('image: rocento-backend:release', worker)
                self.assertIn(f'NOTIFICATION_MODE: {mode}', worker)
                self.assertNotIn('env_file:', worker)
                self.assertNotIn('private-test-value', rendered)

    def test_first_language_install_precedes_start_and_skips_shared_or_preserved_ai(self):
        script = (ROOT / 'commerce-ops/deploy/ec2/server/ec2-up.sh').read_text()
        function = 'start_store() {' + script.split('start_store() {', 1)[1].split('\ninternal_ready()', 1)[0]
        harness = r"""
BUILD=auto
RESTART=0
SHARED_AI_MIGRATED=1
backend_fingerprint() { echo backend; }
fingerprint() { echo backend; }
state_value() { echo backend; }
state_set() { :; }
image_present() { return 0; }
sha256sum() { echo hash; }
engagement_import_state() { echo complete; }
validate_assistant_proxies() { :; }
start_store_preserving_ai() { echo preserved; }
fail() { exit 1; }
info() { :; }
skip() { :; }
ok() { :; }
python3() { :; }
docker() { echo healthy; }
compose() {
  if [[ $* == *"ps -q ai-postgres"* ]]; then echo database-id; return; fi
  echo "compose $*"
  if [[ $FAIL_INSTALL == 1 && $* == *scripts/install-empty.ts ]]; then return 9; fi
}
start_store grocery
"""
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'deploy/ec2').mkdir(parents=True)
            shared_marker = root / 'deploy/ec2/grocery-shared-ai.env'
            for shared, preserve, failure in ((False, False, False), (False, False, True), (True, False, False), (False, True, False)):
                with self.subTest(shared=shared, preserve=preserve, failure=failure):
                    if shared:
                        shared_marker.touch()
                    else:
                        shared_marker.unlink(missing_ok=True)
                    result = subprocess.run(['bash', '-e', '-c', function + harness], text=True, capture_output=True,
                        env={**os.environ, 'ROOT': folder, 'PRESERVE_AI': str(int(preserve)), 'FAIL_INSTALL': str(int(failure))})
                    self.assertEqual(result.returncode, 9 if failure else 0, result.stderr)
                    self.assertEqual('scripts/install-empty.ts' in result.stdout, not shared and not preserve)
                    if failure:
                        self.assertNotIn('up -d --no-build --wait', result.stdout)
                    elif not shared and not preserve:
                        self.assertLess(result.stdout.index('scripts/install-empty.ts'), result.stdout.index('up -d --no-build --wait'))

    def test_engagement_import_status_distinguishes_first_import_and_query_failures(self):
        script = (ROOT / 'commerce-ops/deploy/ec2/server/ec2-up.sh').read_text()
        function = 'engagement_import_state() {' + script.split('engagement_import_state() {', 1)[1].split('\nvalidate_assistant_proxies()', 1)[0]
        harness = '''
fail() { echo "$*" >&2; exit 1; }
compose() {
  if [[ $* == *to_regclass* ]]; then
    [[ $PRESENT != error ]] || return 7
    echo "$PRESENT"
  else
    [[ $INITIALIZED != error ]] || return 8
    echo "$INITIALIZED"
  fi
}
engagement_import_state grocery
'''
        for present, initialized, code, output in (
            ('f', '', 0, 'pending'), ('t', 'f', 0, 'pending'),
            ('t', 't', 0, 'complete'), ('error', '', 7, ''),
            ('t', 'error', 8, ''), ('unexpected', '', 1, ''), ('t', 'unexpected', 1, ''),
        ):
            with self.subTest(present=present, initialized=initialized):
                result = subprocess.run(['bash', '-eu', '-c', function + harness],
                                        env={**os.environ, 'PRESENT': present, 'INITIALIZED': initialized},
                                        text=True, capture_output=True)
                self.assertEqual(result.returncode, code, result.stderr)
                self.assertEqual(result.stdout.strip(), output)

    def test_unchanged_deployment_keeps_gateway_up_but_import_and_restart_are_honored(self):
        script = (ROOT / 'commerce-ops/deploy/ec2/server/ec2-up.sh').read_text()
        function = 'start_store() {' + script.split('start_store() {', 1)[1].split('\ninternal_ready()', 1)[0]
        harness = '''
ROOT=/unused
BUILD=auto
backend_fingerprint() { echo backend; }
fingerprint() { echo backend; }
state_value() { echo backend; }
state_set() { echo state-written; }
image_present() { return 0; }
sha256sum() { echo hash; }
engagement_import_state() { [[ $IMPORT != error ]] || return 7; echo "$IMPORT"; }
validate_assistant_proxies() { :; }
fail() { exit 1; }
info() { :; }
skip() { :; }
ok() { :; }
python3() { :; }
compose() {
  if [[ $* == *"ps -q ai-postgres"* ]]; then echo database-id; return; fi
  echo "compose $*"
}
start_store grocery
'''
        for state, restart in (('complete', '0'), ('pending', '0'), ('complete', '1'), ('error', '0')):
            with self.subTest(import_state=state, restart=restart):
                result = subprocess.run(['bash', '-e', '-c', function + harness],
                                        env={**os.environ, 'IMPORT': state, 'RESTART': restart},
                                        text=True, capture_output=True)
                self.assertEqual(result.returncode, 7 if state == 'error' else 0, result.stderr)
                self.assertEqual('stop api-gateway engagement-worker' in result.stdout, state == 'pending')
                self.assertEqual('compose grocery restart' in result.stdout, restart == '1')
                self.assertEqual('state-written' in result.stdout, state != 'error')
                if state == 'pending':
                    self.assertLess(result.stdout.index('stop api-gateway'), result.stdout.index('up -d --no-build --wait'))

    def test_engagement_credentials_survive_reconfiguration_and_are_store_specific(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            config.prepare(destination, 'rocento.com')
            initial = {store: (destination / f'{store}.env').read_text()
                       for store in ('grocery', 'jewelry', 'electronics', 'pharmacy')}
            passwords = [re.search(r'^ENGAGEMENT_POSTGRES_PASSWORD=(.+)$', env, re.M).group(1)
                         for env in initial.values()]
            self.assertEqual(len(set(passwords)), 4)
            config.prepare(destination, 'rocento.com')
            for store, env in initial.items():
                self.assertEqual((destination / f'{store}.env').read_text(), env)
                self.assertEqual((destination / f'{store}.env').stat().st_mode & 0o777, 0o600)
            common = (destination / 'common.yaml').read_text()
            self.assertIn('engagement-worker:', common)
            self.assertIn('rocento-backend:release', common)

    def test_reviewed_backend_is_never_rebuilt_for_stores(self):
        script = (ROOT / 'commerce-ops/deploy/ec2/server/ec2-up.sh').read_text()
        function = 'start_store() {' + script.split('start_store() {', 1)[1].split('\ninternal_ready()', 1)[0]
        harness = '''
ROOT=/unused
BUILD=force
RESTART=0
engagement_import_state() { echo complete; }
backend_fingerprint() { echo new; }
fingerprint() { echo runtime; }
state_value() { echo old; }
state_set() { :; }
sha256sum() { echo hash; }
validate_assistant_proxies() { :; }
fail() { exit 1; }
info() { :; }
skip() { :; }
ok() { :; }
python3() { :; }
docker() { echo "docker $*"; }
compose() {
  if [[ $* == *"ps -q ai-postgres"* ]]; then echo database-id; return; fi
  echo "compose $*"
}
for store in grocery jewelry electronics pharmacy; do start_store "$store"; done
'''
        result = subprocess.run(['bash', '-e', '-c', function + harness], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count('docker build -t rocento-backend:release /unused/backend'), 0)
        self.assertEqual(result.stdout.count(' build ai-service ai-postgres commerce-language-engine'), 0)
        for store in ('grocery', 'jewelry', 'electronics', 'pharmacy'):
            self.assertIn(f'compose {store} up -d --no-build --wait', result.stdout)

    def test_public_api_docs_have_scoped_security_headers(self):
        rendered = config.nginx('rocento.com')
        corporate = rendered.split('server_name rocento.com;', 1)[1].split('\nserver {', 1)[0]
        reference = corporate.split('location ^~ /docs/api/reference/ {', 1)[1].split('}', 1)[0]
        for directive in ("default-src 'none'", "script-src 'self'", "connect-src 'self'",
                          "form-action 'none'", "frame-ancestors 'self'"):
            self.assertIn(directive, reference)
        self.assertNotIn("script-src 'self' 'unsafe-inline'", reference)
        for location in ('/docs/api/reference/', '/docs/api/'):
            block = corporate.split(f'location ^~ {location} {{', 1)[1].split('}', 1)[0]
            for header in ('X-Content-Type-Options "nosniff"', 'X-Frame-Options "SAMEORIGIN"',
                           'Referrer-Policy "no-referrer"', 'Cache-Control "no-cache"'):
                self.assertIn(f'add_header {header} always;', block)
        # The Next page must retain hydration; the strict script policy only
        # applies to the self-hosted static Swagger frame.
        page = corporate.split('location ^~ /docs/api/ {', 1)[1].split('}', 1)[0]
        self.assertNotIn('script-src', page)
        self.assertEqual(rendered.count('BEGIN Rocento public API documentation'), 1)

    def test_raw_contract_is_blocked_on_every_external_gateway_host(self):
        rendered = config.nginx('rocento.com')
        for host in ('grocery', 'admin', 'jewelry', 'jewelry-admin', 'electronics', 'electronics-admin', 'pharmacy', 'pharmacy-admin'):
            block = rendered.split(f'server_name {host}.rocento.com;', 1)[1].split('\nserver {', 1)[0]
            self.assertIn('location = /api/openapi.json { return 404; }', block)
            self.assertIn('location ^~ /api/openapi.json/ { return 404; }', block)
            self.assertIn('location /api/ {', block)

    def test_docs_patch_preserves_existing_routing_and_refuses_ambiguous_layouts(self):
        secured = config.nginx('rocento.com')
        old = secured.replace(config.api_docs_locations(), '').replace(config.private_api_spec_location(), '')
        old += '\n# existing production-specific configuration remains untouched\n'
        patched = config.secure_api_docs_nginx(old, 'rocento.com')
        self.assertEqual(patched.replace(config.api_docs_locations(), '').replace(config.private_api_spec_location(), ''), old)
        self.assertEqual(config.secure_api_docs_nginx(patched, 'rocento.com'), patched)
        for invalid in (old.replace('current/website', 'legacy/website'),
                        old.replace('server_name grocery.rocento.com;', 'server_name other.example.com;'),
                        old.replace('    location /api/ {', '    location /api/v1/ {', 1),
                        old + config.api_docs_locations()):
            with self.subTest(config=invalid[-100:]), self.assertRaises(ValueError):
                config.secure_api_docs_nginx(invalid, 'rocento.com')

    def test_crawler_routes_follow_store_policy_without_serving_the_app_shell(self):
        rendered = config.nginx('rocento.com')
        for host in ('grocery', 'admin', 'jewelry', 'jewelry-admin', 'electronics', 'electronics-admin', 'pharmacy', 'pharmacy-admin'):
            with self.subTest(host=host):
                block = rendered.split(f'server_name {host}.rocento.com;', 1)[1].split('\nserver {', 1)[0]
                robots = re.search(r'location = /robots\.txt \{(.*?)\n    \}', block, re.DOTALL).group(1)
                self.assertIn('default_type text/plain;', robots)
                self.assertIn('X-Robots-Tag "noindex, nofollow" always;', robots)
                self.assertNotIn('try_files', robots)
                directives = re.search(r'return 200 "([^"]*)";', robots).group(1)
                self.assertEqual(directives, 'User-agent: *\nAllow: /\n' if 'admin' not in host else 'User-agent: *\nDisallow: /\n')
                policy = RobotFileParser()
                policy.parse(directives.splitlines())
                for user_agent in ('Googlebot', 'GPTBot', '*'):
                    for path in ('/', '/products/demo-ring', '/api/v1/catalog/media/demo/content'):
                        self.assertEqual(policy.can_fetch(user_agent, f'https://{host}.rocento.com{path}'), 'admin' not in host)
                for path in ('/llms.txt', '/sitemap.xml') + (('/ai-catalog.json',) if 'admin' in host else ()):
                    route = re.search(r'location = ' + re.escape(path) + r' \{(.*?)\}', block).group(1)
                    self.assertIn('return 404;', route)
                    self.assertNotIn('try_files', route)
                self.assertRegex(block, r'location \^~ /sitemaps/ \{\s*return 404;\s*\}')
                self.assertIn('try_files $uri $uri/ /index.html;', block)

    def test_auth_attempts_are_limited_without_throttling_refresh_or_logout(self):
        rendered = config.nginx('rocento.com')
        rule = rendered.split('map $uri $rocento_auth_key {', 1)[1].split('}', 1)[0]
        self.assertIn('default "";', rule)
        expression = next(line.strip().split(' ', 1)[0][1:] for line in rule.splitlines() if line.strip().startswith('~'))
        for realm in ('customer', 'admin'):
            for action in ('login', 'register', 'request-verification', 'verify', 'forgot-password', 'reset-password'):
                self.assertRegex(f'/api/v1/{realm}/auth/{action}', expression)
            for action in ('refresh', 'logout'):
                self.assertIsNone(re.search(expression, f'/api/v1/{realm}/auth/{action}'))
        self.assertIn('"$host:$binary_remote_addr"', rule)
        self.assertIn('zone=rocento_auth:10m rate=20r/m;', rendered)
        self.assertEqual(rendered.count('limit_req zone=rocento_auth burst=10 nodelay;'), 9)
        self.assertEqual(rendered.count('limit_req_status 429;'), 14)
        self.assertEqual(rendered.count('add_header Retry-After 3 always;'), 9)
        self.assertEqual(rendered.count('error_page 429 = @auth_rate_limited;'), 8)
        self.assertIn('return 429 \'{"error":"Too many authentication requests or public API requests; retry shortly"}\';', rendered)

    def test_shopping_chat_source_budget_is_separate_from_other_api_budgets(self):
        rendered = config.nginx('rocento.com')
        rule = rendered.split('map $uri $rocento_assistant_key {', 1)[1].split('}', 1)[0]
        self.assertIn('default "";', rule)
        self.assertIn('/api/v1/assistant/chat "$host:$binary_remote_addr";', rule)
        self.assertNotIn('/assistant-tools/', rule)
        for name, rate in [('auth', 20), ('support', 6), ('assistant', 32), ('memory', 40), ('analytics', 240)]:
            self.assertIn(f'zone=rocento_{name}:10m rate={rate}r/m;', rendered)

    def test_only_cloudflare_networks_can_override_the_ingress_client_ip(self):
        rendered = config.nginx('rocento.com')
        sources = re.findall(r'^set_real_ip_from ([^;]+);$', rendered, re.MULTILINE)
        self.assertEqual(tuple(sources), config.CLOUDFLARE_NETWORKS)
        networks = [ipaddress.ip_network(value) for value in sources]
        self.assertEqual(len(networks), 22)
        self.assertIn('real_ip_header CF-Connecting-IP;', rendered)
        self.assertIn('real_ip_recursive off;', rendered)
        for address in ('127.0.0.1', '172.18.0.1', '192.168.1.1', '198.51.100.10', '::1', '2001:db8::1'):
            self.assertFalse(any(ipaddress.ip_address(address) in network for network in networks))
        self.assertNotIn('$http_cf_connecting_ip', rendered)
        self.assertNotIn('$http_x_forwarded_for', rendered)
        self.assertNotIn('$proxy_add_x_forwarded_for', rendered)
        self.assertEqual(rendered.count('proxy_set_header X-Forwarded-For $remote_addr;'), 9)

    def test_ingress_mode_is_scoped_to_managed_loopback_gateway_deployments(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(config, 'prepare_assistant'):
                config.prepare(Path(directory), 'rocento.com')
            common = (Path(directory) / 'common.yaml').read_text()
            gateway = common.split('  api-gateway:', 1)[1].split('  export-worker:', 1)[0]
            self.assertIn('AUTH_IP_RATE_LIMIT_MODE: ingress', gateway)
            for compose in ('commerce-ops/compose/compose.yaml', 'commerce-ops/compose/compose.jewelry.yaml',
                            'commerce-ops/compose/compose.electronics.yaml'):
                gateway = (ROOT / compose).read_text().split('  api-gateway:', 1)[1].split('\n  storefront:', 1)[0]
                self.assertRegex(gateway, r'127\.0\.0\.1:\d+:8080')

    def test_ingress_reload_precedes_gateways_and_failure_prevents_replacement(self):
        script = (ROOT / 'commerce-ops/deploy/ec2/server/ec2-up.sh').read_text()
        # Execute the real main sequence with harmless function stubs. Keeping
        # comments in the tail avoids relying on an exact source-text sequence.
        tail = 'preflight\n' + script.rsplit('\npreflight\n', 1)[1]
        harness = '''set -e
MODE=deploy
DEPLOY_LOG=test-log
preflight() { printf 'preflight\\n'; }
prepare_configuration() { printf 'prepare\\n'; }
migration_preflight() { printf 'migrations\\n'; }
build_frontend() { printf 'build_frontend\\n'; }
publish_ingress() {
  printf 'reload_ingress\\n'
  [[ $FAIL_INGRESS_RELOAD != 1 ]]
}
start_store() { printf 'start_store %s\\n' "$1"; }
internal_ready() { printf 'internal_ready\\n'; }
verify_release_migrations() { printf 'verify_migrations\\n'; }
prepare_storefront_images() { printf 'prepare_images\\n'; }
publish_nginx() { printf 'publish_frontend\\n'; }
info() { :; }
public_health() { printf 'public_health\\n'; }
python3() { if [[ $* == *deployment_gate.py* ]]; then printf 'release_gate\\n'; else printf 'legacy_cleanup\\n'; fi; }
summary() { printf 'summary\\n'; }
'''
        for fail in (False, True):
            with self.subTest(reload_fails=fail):
                result = subprocess.run(['bash', '-c', harness + f'FAIL_INGRESS_RELOAD={int(fail)}\n' + tail], capture_output=True, text=True)
                events = result.stdout.splitlines()
                if fail:
                    self.assertNotEqual(result.returncode, 0, result.stderr)
                    self.assertIn('reload_ingress', events)
                    self.assertFalse(any(event.startswith('start_store ') for event in events))
                    self.assertNotIn('publish_frontend', events)
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual([event for event in events if event.startswith('start_store ')], ['start_store grocery', 'start_store jewelry', 'start_store electronics', 'start_store pharmacy'])
                    for store in ('grocery', 'jewelry', 'electronics', 'pharmacy'):
                        self.assertLess(events.index('reload_ingress'), events.index(f'start_store {store}'))
                    self.assertLess(events.index('verify_migrations'), events.index('publish_frontend'))
                    self.assertLess(events.index('verify_migrations'), events.index('prepare_images'))
                    self.assertLess(events.index('public_health'), events.index('legacy_cleanup'))
                    self.assertLess(events.index('prepare_images'), events.index('publish_frontend'))

    def test_frontend_promotes_reviewed_export_with_contract_build_recipe(self):
        script = (ROOT / 'commerce-ops/deploy/ec2/server/ec2-up.sh').read_text()
        function = script.split('build_frontend() {', 1)[1].split('\nimage_present()', 1)[0]
        self.assertIn('fingerprint "$ROOT/commerce-web" "$ROOT/commerce-api/rocento-api/openapi.json"', function)
        self.assertIn('/etc/rocento/release/frontend', function)
        self.assertLess(function.index('deployment_gate.py'), function.index('cp -a'))
        self.assertNotIn('docker run', function)
        build = (ROOT / 'commerce-ops/deploy/ec2/build-frontend.sh').read_text()
        self.assertLess(build.index('pnpm install --frozen-lockfile'), build.index('pnpm generate:api'))
        self.assertLess(build.index('pnpm generate:api'), build.index('pnpm --filter @rocento/website build'))
        package = json.loads((ROOT / 'commerce-web/package.json').read_text())
        self.assertIn('../commerce-api/rocento-api/openapi.json', package['scripts']['generate:api'])

    def test_hashed_assets_are_immutable_but_documents_and_api_remain_uncached(self):
        rendered = config.nginx('rocento.com')
        for host in ('grocery', 'jewelry', 'electronics', 'pharmacy'):
            block = rendered.split(f'server_name {host}.rocento.com;', 1)[1].split('\nserver {', 1)[0]
            assets = block.split('location ^~ /assets/ {', 1)[1].split('}', 1)[0]
            self.assertIn('try_files $uri =404;', assets)
            self.assertIn('gzip_static on;', assets)
            self.assertIn('max-age=31536000, immutable', assets)
            self.assertIn('X-Robots-Tag "noindex, nofollow" always', assets)
            html = block.split('location / {', 1)[1].split('}', 1)[0]
            api = block.split('location /api/ {', 1)[1].split('}', 1)[0]
            self.assertIn('Cache-Control "no-cache"', html)
            self.assertIn('Cache-Control $rocento_api_cache_control always', api)
            self.assertIn('default "no-store";', rendered)
            self.assertIn('private, no-store, no-transform', rendered)
            self.assertNotIn('immutable', api)

    def test_assistant_mount_changes_recreate_services_and_record_only_success(self):
        script = (ROOT / 'commerce-ops/deploy/ec2/server/ec2-up.sh').read_text()
        # Include the real proxy-validation dependency used by start_store.
        function = 'validate_assistant_proxies() {' + script.split('validate_assistant_proxies() {', 1)[1].split('\ninternal_ready()', 1)[0]
        for previous, fail in [('old', False), ('new', False), ('old', True)]:
            with self.subTest(previous=previous, fail=fail):
                harness = function + """
ROOT=/unused
BUILD=auto
RESTART=0
engagement_import_state() { echo complete; }
backend_fingerprint() { echo backend; }
fingerprint() { echo new; }
state_value() {
  if [[ $1 == *assistant-runtime* ]]; then echo "$PREVIOUS"; else echo backend; fi
}
state_set() { echo "state $1 $2"; }
image_present() { return 0; }
sha256sum() { echo hash; }
fail() { exit 1; }
info() { :; }
skip() { :; }
ok() { :; }
python3() { echo "migrate $*"; }
compose() {
  if [[ $* == *"ps -q ai-postgres"* ]]; then echo ai-database-id; return; fi
  echo "compose $*"
  if [[ $* == *--force-recreate* && $FAIL == 1 ]]; then return 1; fi
}
start_store grocery
"""
                result = subprocess.run(
                    ['bash', '-e', '-c', f'PREVIOUS={previous}\nFAIL={int(fail)}\n' + harness],
                    capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, int(fail), result.stderr)
                self.assertEqual('--force-recreate' in result.stdout, previous != 'new')
                if previous != 'new':
                    self.assertIn('--no-deps --no-build --force-recreate', result.stdout)
                    self.assertIn('ai-service assistant-ingress assistant-tools assistant-provider', result.stdout)
                self.assertEqual('state grocery-assistant-runtime.sha256 new' in result.stdout, previous != 'new' and not fail)
                self.assertEqual('state grocery-backend.sha256 backend' in result.stdout, not fail)
                self.assertLess(result.stdout.index('migrate '), result.stdout.index(' up -d --no-build --wait'))

    def test_start_failure_reports_gateway_logs_without_recording_success(self):
        script = (ROOT / 'commerce-ops/deploy/ec2/server/ec2-up.sh').read_text()
        function = 'validate_assistant_proxies() {' + script.split('validate_assistant_proxies() {', 1)[1].split('\ninternal_ready()', 1)[0]
        harness = function + """
ROOT=/unused
BUILD=auto
RESTART=0
engagement_import_state() { echo complete; }
backend_fingerprint() { echo backend; }
state_value() { echo backend; }
state_set() { echo unexpected-state-write; }
image_present() { return 0; }
fail() { echo "$*"; exit 1; }
skip() { :; }
python3() { echo "migrate $*"; }
compose() {
  if [[ $* == *"ps -q ai-postgres"* ]]; then echo ai-database-id; return; fi
  echo "compose $*"
  if [[ $* == *"up -d --no-build --wait"* ]]; then return 1; fi
}
start_store grocery
"""
        result = subprocess.run(['bash', '-e', '-c', harness], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('logs --tail=60 api-gateway', result.stdout)
        self.assertIn('logs --tail=60 ai-service', result.stdout)
        self.assertIn('Do not reset persistent data or migration checksums', result.stdout)
        self.assertNotIn('unexpected-state-write', result.stdout)

    def test_assistant_migrations_preflight_and_readiness_gate_publication(self):
        script = (ROOT / 'commerce-ops/deploy/ec2/server/ec2-up.sh').read_text()
        functions = 'validate_assistant_proxies() {' + script.split('validate_assistant_proxies() {', 1)[1].split('\ninternal_ready()', 1)[0]
        sequence = 'preflight\n' + script.rsplit('\npreflight\n', 1)[1]
        harness = functions + """
ROOT=/unused
BUILD=auto
RESTART=0
MODE=full
DEPLOY_LOG=test-log
engagement_import_state() { echo complete; }
backend_fingerprint() { echo backend; }
fingerprint() { echo new; }
state_value() {
  if [[ $1 == *assistant-runtime* ]]; then echo old; else echo backend; fi
}
state_set() { echo "state $1 $2"; }
image_present() { return 0; }
sha256sum() { echo hash; }
fail() { echo "$*"; exit 1; }
info() { :; }
skip() { :; }
ok() { echo "$*"; }
python3() {
  echo "python3 $*"
  if [[ $FAILURE == migration && $* == *conversations-setup.py* ]]; then return 1; fi
}
compose() {
  if [[ $* == *"ps -q ai-postgres"* ]]; then
    [[ $FAILURE == missing-database ]] || echo ai-database-id
    return 0
  fi
  echo "compose $*"
  if [[ $FAILURE == database && $* == *"up -d --no-deps --no-build --wait --wait-timeout 300 ai-postgres"* ]]; then return 1; fi
  if [[ $FAILURE == preflight && $* == *agentic-preflight.py* ]]; then return 1; fi
  if [[ $FAILURE == ready && $* == *http://localhost:8000/ready* ]]; then return 1; fi
}
preflight() { :; }
prepare_configuration() { :; }
migration_preflight() { :; }
build_frontend() { :; }
publish_ingress() { :; }
internal_ready() { :; }
verify_release_migrations() { :; }
prepare_storefront_images() { :; }
publish_nginx() { echo frontend-published; }
public_health() { :; }
summary() { :; }
"""
        for failure in ('database', 'missing-database', 'migration', 'preflight', 'ready', ''):
            with self.subTest(failure=failure):
                result = subprocess.run(
                    ['bash', '-e', '-c', harness + sequence], text=True, capture_output=True,
                    env={**os.environ, 'FAILURE': failure},
                )
                self.assertEqual(result.returncode, int(bool(failure)), result.stderr)
                if failure:
                    self.assertNotIn('state grocery-', result.stdout)
                    self.assertNotIn('frontend-published', result.stdout)
                    self.assertNotIn('grocery stack running', result.stdout)
                    if failure != 'ready':
                        self.assertNotIn(' up -d --no-build --wait', result.stdout)
                    else:
                        self.assertIn('logs --tail=60 ai-service commerce-language-engine', result.stdout)
                else:
                    database = result.stdout.index('up -d --no-deps --no-build --wait --wait-timeout 300 ai-postgres')
                    migration = result.stdout.index('conversations-setup.py --container ai-database-id')
                    preflight = result.stdout.index('agentic-preflight.py')
                    full_start = result.stdout.index('up -d --no-build --wait --wait-timeout 300')
                    self.assertLess(database, migration)
                    self.assertLess(migration, preflight)
                    self.assertLess(preflight, full_start)
                    readiness = result.stdout.index('http://localhost:8000/ready')
                    self.assertLess(readiness, result.stdout.index('state grocery-assistant-runtime'))
                    self.assertLess(readiness, result.stdout.index('state grocery-backend'))
                    self.assertLess(readiness, result.stdout.index('frontend-published'))

    def test_managed_assistant_readiness_requires_ready_language_and_storage(self):
        prefix = "python -c '\nimport json\nimport urllib.request\n"
        probes = []
        for path in ('commerce-ops/deploy/ec2/server/ec2-up.sh', 'commerce-ops/deploy/ec2/server/ec2-deploy-ai.sh'):
            source = (ROOT / path).read_text()
            probes.append('import json\nimport urllib.request\n' + source.split(prefix, 1)[1].split("\n'", 1)[0])
        self.assertEqual(probes[0], probes[1])
        cases = [
            ('ready', {'status': 'ready', 'components': {'language': 'ready', 'storage': 'ready'}, 'recommendations': 'model-unavailable'}, None, True),
            ('no-store', {'status': 'ready', 'components': {'language': 'ready', 'storage': 'not_configured'}}, None, False),
            ('bad-store', {'status': 'unavailable', 'components': {'language': 'ready', 'storage': 'unavailable'}}, None, False),
            ('bad-language', {'status': 'ready', 'components': {'language': 'unavailable', 'storage': 'ready'}}, None, False),
            ('not-ready', {'status': 'disabled', 'components': {'language': 'ready', 'storage': 'ready'}}, None, False),
            ('malformed', b'not JSON', None, False),
            ('oversized', b'x' * 4097, None, False),
            ('bad-shape', [], None, False),
            ('http-failure', None, HTTPError('http://localhost:8000/ready', 503, 'Unavailable', None, None), False),
            ('timeout', None, TimeoutError('internal error details'), False),
        ]
        for label, body, error, succeeds in cases:
            with self.subTest(case=label):
                response = MagicMock()
                response.read.return_value = body if isinstance(body, bytes) else json.dumps(body).encode()
                with patch('urllib.request.urlopen') as urlopen:
                    urlopen.return_value.__enter__.return_value = response
                    if error:
                        urlopen.side_effect = error
                    if succeeds:
                        exec(compile(probes[0], '<readiness-probe>', 'exec'), {})
                    else:
                        with self.assertRaisesRegex(SystemExit, '^Assistant dependencies are not ready$'):
                            exec(compile(probes[0], '<readiness-probe>', 'exec'), {})
                    urlopen.assert_called_once_with('http://localhost:8000/ready', timeout=5)
                    if not error:
                        response.read.assert_called_once_with(4097)

    def test_existing_assistant_engine_activation_survives_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = {}
            for store in ('grocery', 'jewelry', 'electronics', 'pharmacy'):
                secrets = root / 'assistant' / store
                secrets.mkdir(parents=True)
                for name in ('private.pem', 'public.pem', 'store-admin-password', 'store-runtime-password'):
                    (secrets / name).write_text('existing-test-value')
                path = root / f'{store}-assistant.env'
                value = 'ASSISTANT_TENANT_ID=test-tenant\nAI_FEATURE_FLAGS=typed_errors,grounded_intent,commerce_core,commerce_meaning,commerce_planning\nAI_MODEL_INPUT_MICROS_PER_1K=400\nAI_MODEL_OUTPUT_MICROS_PER_1K=1600\n'
                path.write_text(value)
                expected[path] = value
            config.prepare_assistant(root)
            for path, value in expected.items():
                self.assertEqual(path.read_text(), value)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_full_catalog_is_enabled_only_for_demo_deployments(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            with patch.object(config, 'prepare_assistant'), patch.dict('os.environ', {'DEMO_ADMIN_ENFORCE': '1'}):
                config.prepare(path, 'rocento.com')
                for store in ('grocery', 'jewelry', 'electronics', 'pharmacy'):
                    self.assertIn('DEMO_FULL_CATALOG: "true"', (path / f'{store}.yaml').read_text())
                    self.assertIn('DEMO_CITY_CATALOG: "true"', (path / f'{store}.yaml').read_text())
            with patch.object(config, 'prepare_assistant'), patch.dict('os.environ', {'DEMO_ADMIN_ENFORCE': '0'}):
                config.prepare(path, 'rocento.com')
                self.assertIn('DEMO_FULL_CATALOG: "false"', (path / 'grocery.yaml').read_text())

    def test_demo_admin_enforcement_is_scoped_to_standalone_seed(self):
        script = (ROOT / 'commerce-ops/deploy/ec2/server/ec2-seed-demo.sh').read_text()
        function = script.split('enforce_demo_administrators() {', 1)[1].split('\nbootstrap_and_seed()', 1)[0]
        harness = "enforce_demo_administrators() {" + function + """
DEMO_ADMIN_ENFORCE=1
SKIP_SEED=1
SEED_TARGET=electronics
STORES=(electronics)
for store in GROCERY JEWELRY ELECTRONICS; do
  export "${store}_ADMIN_EMAIL=info@example.test"
  export "${store}_ADMIN_PASSWORD=test-only-password"
done
compose() {
  [[ $BOOTSTRAP_ADMIN_PASSWORD == test-only-password ]] || return 1
  printf '%s\n' "$*"
}
ok() { :; }
enforce_demo_administrators
[[ -z ${BOOTSTRAP_ADMIN_PASSWORD+x} ]]
"""
        result = subprocess.run(['bash', '-eu', '-c', harness], check=True, capture_output=True, text=True)
        lines = result.stdout.splitlines()
        self.assertEqual(len(lines), 1)
        for store, line in zip(('electronics',), lines):
            self.assertEqual(line, f'{store} exec -T -e BOOTSTRAP_ADMIN_PASSWORD api-gateway seed-admin --enforce-demo-admin --email info@example.test')

    def test_smtp_is_opt_in_and_secrets_are_not_rendered(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            config.prepare(path, 'rocento.com')
            self.assertIn('NOTIFICATION_MODE: console', (path / 'common.yaml').read_text())
            smtp = path / 'notifications.env'
            smtp.write_text('SMTP_PASSWORD=test-secret-$literal\n')
            smtp.chmod(0o600)
            config.prepare(path, 'rocento.com')
            rendered = (path / 'common.yaml').read_text()
            self.assertIn('NOTIFICATION_MODE: smtp', rendered)
            self.assertIn('APP_ENV: production', rendered)
            self.assertIn('format: raw', rendered)
            self.assertNotIn('test-secret', rendered)
            smtp.chmod(0o644)
            with self.assertRaises(ValueError):
                config.prepare(path, 'rocento.com')

    def test_preserves_secrets_on_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            config.prepare(path, 'rocento.com')
            before = {s: (path / f'{s}.env').read_bytes() for s in ('grocery', 'jewelry', 'electronics', 'pharmacy')}
            assistant_before = {p: p.read_bytes() for p in path.rglob('*') if p.is_file() and ('assistant' in str(p.relative_to(path)))}
            self.assertNotEqual(before['grocery'], before['jewelry'])
            config.prepare(path, 'rocento.com')
            for file, value in assistant_before.items():
                self.assertEqual(file.read_bytes(), value)
            self.assertNotEqual((path / 'grocery-assistant.env').read_bytes(), (path / 'jewelry-assistant.env').read_bytes())
            for store in before:
                self.assertEqual(before[store], (path / f'{store}.env').read_bytes())
                self.assertEqual((path / f'{store}.env').stat().st_mode & 0o777, 0o600)

    def test_rejects_config_injection(self):
        for domain in ('example.com;bad', 'https://rocento.com', 'bad\nname.com', '-bad.com', '*.rocento.com'):
            with self.subTest(domain=domain), self.assertRaises(ValueError):
                config.validate_domain(domain)

    def test_nginx_routes_isolated_apis(self):
        text = config.nginx('rocento.com')
        self.assertEqual(text.count('proxy_pass http://127.0.0.1:8080/;'), 2)
        self.assertEqual(text.count('proxy_pass http://127.0.0.1:58080/;'), 2)
        self.assertEqual(text.count('proxy_pass http://127.0.0.1:59080/;'), 2)
        self.assertIn('server_name electronics.rocento.com;', text)
        self.assertIn('root /var/www/rocento/current/electronics-admin;', text)
        self.assertNotIn('proxy_set_header Origin', text)
        self.assertIn('root /var/www/rocento/current/website;', text)

    def test_shell_syntax_and_help(self):
        for path in ('commerce-ops/deploy/ec2/server/ec2-up.sh', 'commerce-ops/deploy/ec2/server/ec2-bootstrap.sh',
                     'commerce-ops/deploy/ec2/server/ec2-seed-demo.sh', 'commerce-ops/deploy/ec2/server/ec2-compose.sh',
                     'commerce-ops/deploy/ec2/server/ec2-status.sh', 'commerce-ops/deploy/ec2/server/ec2-doctor.sh',
                     'commerce-ops/deploy/ec2/build-frontend.sh'):
            subprocess.run(['bash', '-n', str(ROOT / path)], check=True)
        result = subprocess.run(['bash', str(ROOT / 'commerce-ops/deploy/ec2/server/ec2-up.sh'), '--help'], capture_output=True, text=True, check=True)
        self.assertIn('--verify-only', result.stdout)
        self.assertIn('ec2-seed-demo.sh', result.stdout)
        self.assertIn('--rebuild', result.stdout)
        self.assertNotIn('read -rp', (ROOT / 'commerce-ops/deploy/ec2/server/ec2-up.sh').read_text())
        self.assertNotIn('read -rsp', (ROOT / 'commerce-ops/deploy/ec2/server/ec2-up.sh').read_text())
        bad = subprocess.run(['bash', str(ROOT / 'commerce-ops/deploy/ec2/server/ec2-up.sh'), '--cert'], capture_output=True, text=True)
        self.assertNotEqual(bad.returncode, 0)
        seed_help = subprocess.run(['bash', str(ROOT / 'commerce-ops/deploy/ec2/server/ec2-seed-demo.sh'), '--help'], capture_output=True, text=True, check=True)
        self.assertIn('--store', seed_help.stdout)
        for script, flag in [('commerce-ops/deploy/ec2/server/ec2-up.sh', '--seed-only'),
                              ('commerce-ops/deploy/aws-deploy/deploy.sh', '--seed-demo')]:
            rejected = subprocess.run(['bash', str(ROOT / script), flag], capture_output=True, text=True)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn('ec2-seed-demo.sh', rejected.stderr)
        deploy = (ROOT / 'commerce-ops/deploy/ec2/server/ec2-up.sh').read_text()
        for operation in ('bootstrap_and_seed', 'seed_demo_enrichment', 'enforce_demo_palette', 'enforce_demo_administrators'):
            self.assertNotIn(operation, deploy)

    def test_arm64_bootstrap_and_scoped_seed_tls_are_supported(self):
        deploy = (ROOT / 'commerce-ops/deploy/ec2/server/ec2-up.sh').read_text()
        self.assertIn('aarch64|arm64', deploy)
        self.assertNotIn('== x86_64', deploy)
        seed = (ROOT / 'commerce-ops/deploy/ec2/server/ec2-seed-demo.sh').read_text()
        self.assertIn('temporary_seed_hosts', seed)
        self.assertIn('restore_seed_hosts', seed)
        self.assertIn('cp /etc/hosts "$HOSTS_BACKUP"', seed)
        self.assertIn('DEMO_SSL_CA_FILE', seed)
        self.assertIn('verify_configuration', deploy)
        self.assertIn('backend_fingerprint', deploy)
        self.assertIn('Another Rocento deployment is already active', deploy)
        example = (ROOT / 'commerce-ops/deploy/ec2/bootstrap.env.example').read_text()
        self.assertIn('GROCERY_ADMIN_PASSWORD=', example)
        self.assertIn('JEWELRY_ADMIN_PASSWORD=', example)
        seed_client = (ROOT / 'commerce-assets/demo/demo_seed.py').read_text()
        self.assertIn('ssl.create_default_context(cafile=ca_file)', seed_client)
        self.assertNotIn('_create_unverified_context', seed_client)

    @unittest.skipUnless(shutil.which('docker'), 'Docker Compose CLI unavailable')
    def test_compose_merged_configs_without_starting_containers(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            config.prepare(path, 'rocento.com')
            for store, port in (('grocery', 8080), ('jewelry', 58080), ('electronics', 59080), ('pharmacy', 60080)):
                command = ['docker', 'compose', '--env-file', str(path / f'{store}.env'), '--env-file', str(path / f'{store}-assistant.env'),
                           '-p', f'rocento-{store}', '-f', str(ROOT / 'commerce-ops/compose/compose.yaml')]
                if store != 'grocery':
                command += ['-f', str(ROOT / f'commerce-ops/compose/compose.{store}.yaml')]
                command += ['-f', str(ROOT / 'commerce-ops/compose/compose.assistant.yaml'), '-f', str(ROOT / 'commerce-ops/compose/compose.assistant-admin.yaml'), '-f', str(path / 'common.yaml'), '-f', str(path / f'{store}.yaml'), '-f', str(ROOT / 'commerce-ops/deploy/ec2/assistant.yaml'), '-f', str(ROOT / 'commerce-ops/compose/compose.language-engine.yaml'), 'config', '--format', 'json']
                result = subprocess.run(command, capture_output=True, text=True, check=True)
                model = json.loads(result.stdout)
                services = model['services']
                self.assertNotIn('storefront', services)
                self.assertNotIn('admin', services)
                self.assertNotIn('ai-health', services)
                gateway = services['api-gateway']
                self.assertEqual(gateway['image'], 'rocento-backend:release')
                self.assertEqual(services['ai-service']['image'], 'rocento-ai-service:release')
                self.assertEqual(services['ai-postgres']['image'], 'rocento-ai-postgres:release')
                self.assertEqual(services['commerce-language-engine']['image'], 'rocento-language-engine:release')
                self.assertEqual(services['export-worker']['image'], gateway['image'])
                self.assertEqual(services['export-worker']['healthcheck']['test'], ['CMD', 'export-worker', '--health'])
                self.assertNotIn('build', gateway)
                self.assertNotIn('build', services['export-worker'])
                self.assertNotIn('ASSISTANT_ENABLED', gateway['environment'])
                self.assertNotIn('ASSISTANT_ENABLED', services['ai-service']['environment'])
                self.assertEqual(gateway['environment']['ASSISTANT_TENANT_ID'], services['ai-service']['environment']['ASSISTANT_TENANT_ID'])
                self.assertEqual(model['volumes']['assistant-config']['name'], f'rocento-{store}_assistant-config')
                for name in ('ai-service', 'ai-postgres', 'assistant-ingress', 'assistant-tools', 'assistant-provider'):
                    self.assertFalse(services[name].get('ports'))
                self.assertEqual(int(gateway['ports'][0]['published']), port)
                self.assertEqual(gateway['environment']['COOKIE_SECURE'], 'true')
                self.assertEqual(gateway['environment']['AUTH_IP_RATE_LIMIT_MODE'], 'ingress')
                self.assertEqual(gateway['environment']['STOREFRONT_URL'], f'https://{store}.rocento.com')
                for service in services.values():
                    self.assertEqual(service['restart'], 'unless-stopped')
                    for mapping in service.get('ports', []):
                        self.assertEqual(mapping['host_ip'], '127.0.0.1')
                self.assertEqual(model['volumes']['postgres-data']['name'], f'rocento-{store}_postgres-data')


if __name__ == '__main__':
    unittest.main()
