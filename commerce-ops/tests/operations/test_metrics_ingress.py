"""Metrics ingress policy for every generated demo virtual host."""
import importlib.util
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('metrics_ingress_config', ROOT / 'commerce-ops/deploy/ec2/configure.py')
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)


class MetricsIngressConfigurationTests(unittest.TestCase):
    def test_every_api_host_blocks_metrics_without_changing_gateway_forwarding(self):
        rendered = config.nginx('example.test')
        expected = {
            'grocery': 8080, 'admin': 8080,
            'jewelry': 58080, 'jewelry-admin': 58080,
            'electronics': 59080, 'electronics-admin': 59080,
            'pharmacy': 60080, 'pharmacy-admin': 60080,
        }
        for host, port in expected.items():
            with self.subTest(host=host):
                name = f'server_name {host}.example.test;'
                start = rendered.index(name)
                following = rendered.find('\nserver {', start)
                server = rendered[start:following if following != -1 else None]
                self.assertIn('location = /api/metrics { return 404; }', server)
                self.assertIn('location ^~ /api/metrics/ { return 404; }', server)
                self.assertNotIn('location /api/metrics {', server)
                self.assertNotIn('location ^~ /api/metrics {', server)
                api = re.search(r'location /api/ \{([^}]+)\}', server).group(1)
                self.assertIn(f'proxy_pass http://127.0.0.1:{port}/;', api)
                self.assertIn('limit_req zone=rocento_auth burst=10 nodelay;', api)
                self.assertIn('proxy_set_header X-Forwarded-For $remote_addr;', api)
        self.assertEqual(rendered.count('location = /api/metrics { return 404; }'), len(expected))
        self.assertEqual(rendered.count('location ^~ /api/metrics/ { return 404; }'), len(expected))


if __name__ == '__main__':
    unittest.main()
