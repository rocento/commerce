"""Native Nginx auth-throttling regressions in a disposable container.

Run with AUTH_INGRESS_NGINX_TESTS=1 and a local Docker daemon. No application
containers, databases, host ports, or deployed Nginx configuration are changed.
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
spec = importlib.util.spec_from_file_location('auth_ingress_config', ROOT / 'commerce-ops/deploy/ec2/configure.py')
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)


@unittest.skipUnless(os.environ.get('AUTH_INGRESS_NGINX_TESTS') == '1', 'requires opt-in Docker Nginx fixture')
class AuthIngressTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='commerce-auth-ingress-')
        cls.addClassCleanup(cls.directory.cleanup)
        cls.container = f'commerce-auth-ingress-{uuid4().hex[:12]}'
        rendered = config.nginx('example.test')
        # Preserve the generated map, trusted networks, and API locations. Test
        # listeners use HTTP and one fixture upstream instead of application APIs.
        rendered = rendered.replace('listen 80;', 'listen 18081;')
        rendered = rendered.replace('listen 443 ssl;', 'listen 8080;')
        rendered = re.sub(r'^\s+ssl_(certificate|certificate_key|protocols) .*\n', '', rendered, flags=re.MULTILINE)
        rendered = re.sub(r'proxy_pass http://127\.0\.0\.1:\d+/;', 'proxy_pass http://127.0.0.1:18082/;', rendered)
        fixture = '''pid /tmp/nginx.pid;
error_log /dev/stderr warn;
events {}
http {
    access_log off;
    client_body_temp_path /tmp/client_body;
    proxy_temp_path /tmp/proxy;
'''
        fixture += rendered
        # Only this exact fixture source emulates a Cloudflare connection. The
        # other loopback source remains untrusted for spoofing regressions.
        fixture += '''
    set_real_ip_from 127.0.0.2;
    server {
        listen 18082;
        location / { return 200 "$http_x_forwarded_for"; }
    }
}
'''
        path = Path(cls.directory.name) / 'nginx.conf'
        path.write_text(fixture)
        path.chmod(0o644)
        subprocess.run([
            'docker', 'run', '--detach', '--name', cls.container,
            '--entrypoint', 'nginx', '--mount', f'type=bind,source={path},target=/etc/nginx/nginx.conf,readonly',
            'nginxinc/nginx-unprivileged:1.28-alpine', '-g', 'daemon off;',
        ], check=True, capture_output=True, text=True)
        cls.addClassCleanup(subprocess.run, ['docker', 'rm', '--force', cls.container], capture_output=True)
        subprocess.run(['docker', 'exec', cls.container, 'nginx', '-t'], check=True, capture_output=True, text=True)

    def request(self, path, client_ip, *, trusted=True, host='grocery.example.test', method='POST', port=8080):
        result = subprocess.run([
            'docker', 'exec', self.container, 'curl', '--silent', '--show-error',
            '--include', '--path-as-is', '--max-time', '5', '--interface', '127.0.0.2' if trusted else '127.0.0.1',
            '--header', f'Host: {host}', '--header', f'CF-Connecting-IP: {client_ip}',
            '--header', 'X-Forwarded-For: 203.0.113.200', '--request', method,
            f'http://127.0.0.1:{port}{path}',
        ], check=True, capture_output=True, text=True)
        headers, _, body = result.stdout.partition('\n\n')
        status = int(headers.splitlines()[0].split()[1])
        return status, headers, body

    def test_untrusted_caller_cannot_override_the_client_ip(self):
        for spoofed in ('198.51.100.100', '198.51.100.101'):
            status, _, body = self.request('/api/v1/customer/auth/login', spoofed, trusted=False)
            self.assertEqual(status, 200)
            self.assertEqual(body, '127.0.0.1')

    def test_burst_exhaustion_is_independent_between_clients_and_hosts(self):
        statuses = [self.request('/api/v1/customer/auth/login', '198.51.100.10')[0] for _ in range(15)]
        self.assertEqual(statuses[0], 200)
        self.assertIn(429, statuses)
        status, headers, body = self.request('/api/v1/customer/auth/login', '198.51.100.10')
        self.assertEqual(status, 429)
        self.assertIn('Retry-After: 3', headers)
        self.assertIn('application/json', headers)
        self.assertIn('Too many authentication requests', body)
        self.assertEqual(self.request('/api/v1/customer/auth/login', '198.51.100.11')[0], 200)
        self.assertEqual(self.request('/api/v1/customer/auth/login', '198.51.100.10', host='jewelry.example.test')[0], 200)

    def test_refresh_and_logout_do_not_consume_auth_attempt_burst(self):
        for action in ('refresh', 'logout'):
            for _ in range(15):
                self.assertEqual(self.request(f'/api/v1/customer/auth/{action}', '198.51.100.12')[0], 200)
        self.assertEqual(self.request('/api/v1/customer/auth/login', '198.51.100.12')[0], 200)

    def test_public_source_budgets_cover_normalized_paths_and_isolate_clients(self):
        for name, path, encoded in (
            ('support', '/api/v1/support/tickets', '/api/v1/support/%74ickets'),
            ('assistant', '/api/v1/assistant/chat', '/api/v1/assistant/%63hat'),
        ):
            address = '198.51.100.30' if name == 'support' else '198.51.100.31'
            statuses = [self.request(path, address)[0] for _ in range(15)]
            self.assertIn(429, statuses)
            self.assertEqual(self.request(encoded, address)[0], 429)
            self.assertEqual(self.request(path, '198.51.100.32')[0], 200)
            self.assertEqual(self.request(path, address, host='jewelry.example.test')[0], 200)
        # Rotating claimed proxy headers on an untrusted connection cannot rotate
        # the quota; unrelated search and auth endpoints retain separate budgets.
        statuses = [self.request('/api/v1/support/tickets', f'203.0.113.{n}', trusted=False)[0] for n in range(15)]
        self.assertIn(429, statuses)
        self.assertEqual(self.request('/api/v1/search', '198.51.100.30', method='GET')[0], 200)
        self.assertEqual(self.request('/api/v1/customer/auth/login', '198.51.100.30')[0], 200)

    def test_analytics_has_its_own_source_budget(self):
        result = subprocess.run([
            'docker', 'exec', self.container, 'sh', '-c',
            'for n in $(seq 1 100); do curl --silent --max-time 5 '
            '--interface 127.0.0.2 --header "Host: grocery.example.test" '
            '--header "CF-Connecting-IP: 198.51.100.40" --request POST '
            '--output /dev/null --write-out "%{http_code}\\n" '
            'http://127.0.0.1:8080/api/v1/analytics/events & done; wait',
        ], check=True, capture_output=True, text=True)
        statuses = [int(value) for value in result.stdout.splitlines()]
        self.assertIn(429, statuses)
        self.assertEqual(self.request('/api/v1/analytics/%65vents', '198.51.100.40')[0], 429)
        self.assertEqual(self.request('/api/v1/analytics/events', '198.51.100.41')[0], 200)

    def test_metrics_are_private_on_every_store_and_admin_host(self):
        paths = (
            '/api/metrics', '/api/metrics?probe=1', '/api/metrics/',
            '/api/metrics/child', '/api/%6detrics', '/api/met%72ics',
            '/api%2fmetrics', '/api/metrics%2f', '//api//metrics',
            '/api/v1/../metrics', '/api/metrics/%2e%2e/metrics',
        )
        hosts = ('grocery', 'admin', 'jewelry', 'jewelry-admin', 'electronics', 'electronics-admin')
        for host in hosts:
            for path in paths:
                with self.subTest(host=host, path=path):
                    status, _, _ = self.request(path, '198.51.100.20', host=f'{host}.example.test', method='GET')
                    self.assertEqual(status, 404)
            with self.subTest(host=host, path='/api/metricsfoo'):
                self.assertEqual(self.request('/api/metricsfoo', '198.51.100.20', host=f'{host}.example.test', method='GET')[0], 200)
            with self.subTest(host=host, path='/api/v1/search'):
                self.assertEqual(self.request('/api/v1/search', '198.51.100.20', host=f'{host}.example.test', method='GET')[0], 200)

    def test_internal_metrics_upstream_remains_available(self):
        self.assertEqual(self.request('/metrics', '198.51.100.20', method='GET', port=18082)[0], 200)


if __name__ == '__main__':
    unittest.main()
