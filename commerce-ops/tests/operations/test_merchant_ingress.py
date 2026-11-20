"""Verify merchant ingress boundaries with a disposable, unpublished Nginx.

Run with MERCHANT_INGRESS_NGINX_TESTS=1 and a local Docker daemon. Uses only its
randomly named container; never installs host ingress or touches tenant data.
"""
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location(
    'merchant_ingress_executor', ROOT / 'commerce-ops/cloud/host/merchant_executor.py')
executor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(executor)


@unittest.skipUnless(os.environ.get('MERCHANT_INGRESS_NGINX_TESTS') == '1',
                     'requires opt-in Docker Nginx fixture')
class MerchantIngressTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='commerce-merchant-ingress-')
        cls.addClassCleanup(cls.directory.cleanup)
        cls.container = f'commerce-merchant-ingress-{uuid4().hex[:12]}'
        job = dict(tenantId=str(uuid4()), artifactDigest='sha256:' + 'a' * 64,
                   storefrontHost='fixture.rocento.com', adminHost='fixture-admin.rocento.com')
        second_job = dict(job, tenantId=str(uuid4()), storefrontHost='other.rocento.com',
                          adminHost='other-admin.rocento.com')
        rendered = ''.join(executor.nginx_config(item, {'gatewayPort': 18082}, Path('/fixture-artifacts'))
                           for item in (job, second_job))
        # Keep the generated location selection and proxy directives, replacing
        # only the TLS listener/certificate paths with an internal HTTP listener.
        rendered = rendered.replace('listen 443 ssl;', 'listen 8080;')
        rendered = re.sub(r'^\s+ssl_(certificate|certificate_key) .*\n', '',
                          rendered, flags=re.MULTILINE)
        # The production analytics bucket refills every 250 ms, shorter than
        # a Docker exec round-trip on a busy developer machine. Keep the same
        # zones, keys, locations and bursts but slow refill in this routing
        # fixture so normalized-path assertions cannot race a fresh token.
        rendered = re.sub(r'(limit_req_zone[^;\n]* rate=)[0-9]+r/m;',
                          r'\g<1>1r/m;', rendered)
        # This exact source emulates Cloudflare in the fixture. Other loopback
        # sources remain untrusted; production CIDRs are otherwise unchanged.
        rendered = rendered.replace(' real_ip_header CF-Connecting-IP;',
                                    ' set_real_ip_from 127.0.0.2;\n real_ip_header CF-Connecting-IP;')
        fixture = '''pid /tmp/nginx.pid;
error_log /dev/stderr warn;
events {}
http {
 access_log off;
 client_body_temp_path /tmp/client_body;
 proxy_temp_path /tmp/proxy;
'''
        fixture += rendered
        fixture += '''
 server {
  listen 18082;
  location = /v1/admin/api-reference/openapi.json { return 401; }
  location = /v1/proxy-headers { return 200 "$http_x_forwarded_for|$http_forwarded|$http_x_real_ip|$http_cf_connecting_ip"; }
  location / { return 200 "$uri"; }
 }
}
'''
        path = Path(cls.directory.name) / 'nginx.conf'
        path.write_text(fixture)
        path.chmod(0o644)
        # Register cleanup before creation, so a failed syntax check cannot
        # leave a fixture behind. No ports are published to the host.
        cls.addClassCleanup(subprocess.run, ['docker', 'rm', '--force', cls.container],
                            capture_output=True)
        subprocess.run([
            'docker', 'run', '--detach', '--name', cls.container,
            '--entrypoint', 'nginx', '--mount',
            f'type=bind,source={path},target=/etc/nginx/nginx.conf,readonly',
            'nginxinc/nginx-unprivileged:1.28-alpine', '-g', 'daemon off;',
        ], check=True, capture_output=True, text=True)
        syntax = subprocess.run(['docker', 'exec', cls.container, 'nginx', '-t'],
                                capture_output=True, text=True)
        if syntax.returncode:
            logs = subprocess.run(['docker', 'logs', cls.container], capture_output=True, text=True)
            raise RuntimeError('Disposable Nginx failed: ' + syntax.stderr + logs.stderr)

    def response(self, path, *, host='fixture.rocento.com', port=8080,
                 client_ip='198.51.100.99', trusted=True, method='GET'):
        response = subprocess.run([
            'docker', 'exec', self.container, 'curl', '--silent', '--show-error',
            '--include', '--path-as-is', '--max-time', '5', '--header', f'Host: {host}',
            '--interface', '127.0.0.2' if trusted else '127.0.0.1',
            '--header', f'CF-Connecting-IP: {client_ip}',
            '--header', f'X-Forwarded-For: {client_ip}',
            '--header', f'Forwarded: for={client_ip}', '--header', f'X-Real-IP: {client_ip}',
            '--request', method,
            f'http://127.0.0.1:{port}{path}',
        ], check=True, capture_output=True, text=True)
        headers, _, body = response.stdout.partition('\n\n')
        return int(headers.splitlines()[0].split()[1]), headers, body

    def request(self, path, **options):
        status, _, body = self.response(path, **options)
        return status, body

    def burst(self, path, client_ip, count=100):
        result = subprocess.run([
            'docker', 'exec', self.container, 'sh', '-c',
            'i=0; while [ "$i" -lt "$3" ]; do curl --silent --show-error --max-time 5 '
            '--interface 127.0.0.2 --header "Host: fixture.rocento.com" '
            '--header "CF-Connecting-IP: $2" --request POST '
            '--output /dev/null --write-out "%{http_code}\\n" '
            '"http://127.0.0.1:8080$1" & i=$((i+1)); done; wait',
            'fixture-burst', path, client_ip, str(count),
        ], check=True, capture_output=True, text=True)
        statuses = [int(value) for value in result.stdout.splitlines()]
        self.assertEqual(len(statuses), count)
        self.assertLessEqual(set(statuses), {200, 429})
        return statuses

    def test_private_endpoints_reject_normalized_and_encoded_paths_on_both_hosts(self):
        for name, encoded in [('metrics', '%6detrics'), ('openapi.json', '%6fpenapi.json')]:
            paths = (
                f'/api/{name}', f'/api/{name}?probe=1', f'/api/{name}/',
                f'/api/{name}/child', f'/api/{encoded}', f'/api%2f{name}',
                f'/api/{name}%2f', f'//api//{name}', f'/api/v1/../{name}',
                f'/api/{name}/%2e%2e/{name}',
            )
            for host in ('fixture.rocento.com', 'fixture-admin.rocento.com'):
                for path in paths:
                    with self.subTest(host=host, path=path):
                        self.assertEqual(self.request(path, host=host)[0], 404)

    def test_private_loopback_upstream_and_unrelated_public_routes_remain_available(self):
        for name in ('metrics', 'openapi.json'):
            self.assertEqual(self.request('/' + name, port=18082), (200, '/' + name))
        for host in ('fixture.rocento.com', 'fixture-admin.rocento.com'):
            for path in ('/api/metricsfoo', '/api/openapi.jsonfoo', '/api/v1/search', '/api/ready'):
                with self.subTest(host=host, path=path):
                    self.assertEqual(self.request(path, host=host), (200, path.removeprefix('/api')))

    def test_merchant_reference_is_admin_only_and_keeps_upstream_authentication(self):
        for path in (
            '/api/v1/admin/api-reference/openapi.json',
            '/api/v1/admin/api-reference/%6fpenapi.json',
            '/api/v1/admin/api-reference/child',
            '/api/v1/admin/%61pi-reference/openapi.json',
            '/api/v1/admin/api-reference%2fopenapi.json',
        ):
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 404)
        for path in ('/api/v1/admin/api-reference/openapi.json',
                     '/api/v1/admin/api-reference/%6fpenapi.json'):
            self.assertEqual(self.request(path, host='fixture-admin.rocento.com')[0], 401)

    def test_auth_limits_separate_verified_clients_hosts_and_tenants(self):
        path = '/api/v1/customer/auth/login'
        statuses = [self.request(path, client_ip='198.51.100.10', method='POST')[0] for _ in range(15)]
        self.assertEqual(statuses[0], 200)
        self.assertIn(429, statuses)
        status, headers, body = self.response('/api/v1/customer/auth/%6cogin',
                                              client_ip='198.51.100.10', method='POST')
        self.assertEqual(status, 429)
        self.assertIn('Retry-After: 3', headers)
        self.assertIn('Cache-Control: no-store', headers)
        self.assertIn('application/json', headers)
        self.assertIn('Too many authentication requests', body)
        self.assertEqual(self.request(path, client_ip='198.51.100.11')[0], 200)
        self.assertEqual(self.request(path, client_ip='198.51.100.10', host='fixture-admin.rocento.com')[0], 200)
        self.assertEqual(self.request(path, client_ip='198.51.100.10', host='other.rocento.com')[0], 200)

    def test_untrusted_proxy_headers_cannot_rotate_auth_budgets(self):
        path = '/api/v1/admin/auth/login'
        statuses = [self.request(path, client_ip=f'203.0.113.{n}', trusted=False,
                                 host='fixture-admin.rocento.com', method='POST')[0] for n in range(1, 16)]
        self.assertEqual(statuses[0], 200)
        self.assertIn(429, statuses)
        self.assertEqual(self.request(path, client_ip='203.0.113.200', trusted=False,
                                      host='fixture-admin.rocento.com')[0], 429)
        self.assertEqual(self.request(path, client_ip='198.51.100.12',
                                      host='fixture-admin.rocento.com')[0], 200)
        for trusted in (False, True):
            self.assertEqual(self.request('/api/v1/proxy-headers', trusted=trusted), (200, '|||'))

    def test_refresh_logout_and_unrelated_routes_do_not_consume_auth_bursts(self):
        for action in ('refresh', 'logout'):
            for _ in range(15):
                self.assertEqual(self.request('/api/v1/customer/auth/' + action,
                                              client_ip='198.51.100.13', method='POST')[0], 200)
        for _ in range(15):
            self.assertEqual(self.request('/api/v1/search', client_ip='198.51.100.13')[0], 200)
        self.assertEqual(self.request('/api/v1/customer/auth/login', client_ip='198.51.100.13')[0], 200)

    def test_each_public_source_budget_is_independent_and_covers_normalized_paths(self):
        for number, path, encoded in (
            (20, '/api/v1/support/tickets', '/api/v1/support/%74ickets'),
            (21, '/api/v1/assistant/chat', '/api/v1/assistant/%63hat'),
            (22, '/api/v1/assistant/memory', '/api/v1/assistant/%6demory/record'),
            (23, '/api/v1/analytics/events', '/api/v1/analytics/%65vents'),
        ):
            client_ip = f'198.51.100.{number}'
            with self.subTest(path=path):
                self.assertIn(429, self.burst(path, client_ip))
                self.assertEqual(self.request(encoded, client_ip=client_ip, method='POST')[0], 429)
                self.assertEqual(self.request(path, client_ip='198.51.100.24', method='POST')[0], 200)
                self.assertEqual(self.request(path, client_ip=client_ip, host='other.rocento.com', method='POST')[0], 200)
                self.assertEqual(self.request('/api/v1/search', client_ip=client_ip)[0], 200)
                self.assertEqual(self.request('/api/v1/customer/auth/login', client_ip=client_ip)[0], 200)


if __name__ == '__main__':
    unittest.main()
