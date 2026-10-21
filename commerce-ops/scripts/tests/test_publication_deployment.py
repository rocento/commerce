"""Publication configuration checks; never starts services or changes deployments."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

publication = load('publication', 'commerce-ops/deploy/ec2/publication.py')
legacy = load('legacy', 'commerce-ops/deploy/ec2/configure.py')

class PublicationDeploymentTests(unittest.TestCase):
    def test_merchant_html_forwards_policy_and_apis_remain_protected(self):
        config = publication.merchant_nginx('shop.example.test', 58080, 58081)
        html = config.split('    location / {')[1]
        self.assertIn('proxy_pass http://127.0.0.1:58081;', html)
        self.assertNotIn('try_files', html)
        self.assertNotIn('add_header X-Robots-Tag', html)
        self.assertIn('proxy_cache off', html)
        self.assertIn('if ($host != shop.example.test) { return 421; }', config)
        self.assertIn('add_header X-Robots-Tag "noindex, nofollow" always', config)
        self.assertIn('proxy_set_header X-Forwarded-Host ""', config)

    def test_admin_defaults_are_preserved(self):
        config = legacy.nginx('example.test')
        for host in ['admin', 'jewelry-admin', 'electronics-admin']:
            section = config.split(f'server_name {host}.example.test;')[1].split('server {')[0]
            self.assertIn('client_max_body_size 25m;\n    add_header X-Robots-Tag "noindex, nofollow" always', section)

    def test_all_demo_public_uris_are_indexable_and_internal_fallbacks_stay_private(self):
        config = legacy.nginx('example.test')
        policy = config.split('map $request_uri $rocento_storefront_robots {')[1].split('}')[0]
        self.assertIn('default "noindex, nofollow";', policy)
        import re
        patterns = re.findall(r'~(\S+) "index, follow";', policy)
        def indexable(uri):
            return any(re.search(pattern, uri) for pattern in patterns)
        for uri in ['/', '/?utm_source=client', '/products/apples', '/categories/fruit/', '/pages/about?lang=en']:
            self.assertTrue(indexable(uri), uri)
        for uri in ['/account', '/account/orders/123', '/cart', '/checkout', '/api/v1/catalog/products', '/login', '/delivery-location', '/missing-page']:
            self.assertFalse(indexable(uri), uri)
        for host in ['grocery', 'jewelry', 'electronics']:
            with self.subTest(host=host):
                storefront = config.split(f'server_name {host}.example.test;')[1].split('server {')[0]
                html = storefront.split('    location / {')[1].split('    location = /api')[0]
                self.assertIn('add_header X-Robots-Tag $rocento_storefront_robots always;', html)
                self.assertIn('try_files $uri $uri/ /index.html;', html)
                api = storefront.split('    location /api/ {')[1]
                self.assertIn('add_header X-Robots-Tag "noindex, nofollow" always;', api)

    def test_host_and_port_cannot_inject_configuration(self):
        for host in ['localhost','127.0.0.1','admin.example.test','shop.local','x; include evil','shop.example:443','staging.example.test']:
            with self.assertRaises(ValueError): publication.merchant_nginx(host)
        for port in [80, 0, 65536]:
            with self.assertRaises(ValueError): publication.merchant_nginx('shop.example.test', port)
