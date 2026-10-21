import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('merchant_docs_policy', ROOT / 'commerce-ops/deploy/ec2/configure.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class MerchantDocsIngressTests(unittest.TestCase):
    def test_viewer_and_private_spec_boundaries(self):
        config = policy.nginx('rocento.com')
        self.assertEqual(config.count(policy.merchant_api_docs_locations()), 4)
        self.assertEqual(config.count(policy.storefront_private_docs_block()), 4)
        self.assertEqual(config.count(policy.private_api_spec_location()), 8)
        viewer = policy.merchant_api_docs_locations()
        for directive in ('private, no-store', "frame-ancestors 'self'", "form-action 'none'", 'nosniff', 'try_files $uri $uri/ =404'):
            self.assertIn(directive, viewer)
        self.assertNotIn('proxy_pass', viewer)
        self.assertNotIn('openapi.json', viewer)

    def test_upgrade_preserves_unrelated_configuration_and_is_idempotent(self):
        full = policy.nginx('rocento.com')
        old = full.replace(policy.merchant_api_docs_locations(), '').replace(policy.storefront_private_docs_block(), '')
        old += '\n# unrelated deployment setting\n'
        updated = policy.secure_merchant_api_docs_nginx(old, 'rocento.com')
        self.assertEqual(updated, full + '\n# unrelated deployment setting\n')
        self.assertEqual(policy.secure_merchant_api_docs_nginx(updated, 'rocento.com'), updated)

    def test_ambiguous_existing_policy_fails_closed(self):
        config = policy.nginx('rocento.com')
        viewer = policy.merchant_api_docs_locations()
        altered = config.replace(viewer, viewer.replace('private, no-store', 'public', 1), 1)
        with self.assertRaises(ValueError):
            policy.secure_merchant_api_docs_nginx(altered, 'rocento.com')


if __name__ == '__main__':
    unittest.main()
