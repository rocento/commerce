import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from demo_presets import PRESETS
from grocery_palette import palette, sync


class ThemeAPI:
    def __init__(self):
        self.config = json.loads((PRESETS / 'grocery/theme.json').read_text())
        self.config['tokens']['color.primary'] = '#146c43'
        self.config['tokens']['color.surface'] = '#f5f7f2'
        self.config['pages']['home'][0]['settings']['heading'] = 'Keep our custom heading'
        self.theme = {'id': 'theme-id', 'owner_channel': 'storefront', 'revision': 7,
                      'published_version': 'old', 'configuration': self.config}
        self.versions = {'old': {'configuration': copy.deepcopy(self.config)}}
        self.assignment = {'channel': 'storefront', 'theme_id': 'theme-id', 'revision': 4, 'rules': []}
        preset = json.loads((PRESETS / 'grocery/preset.json').read_text())
        self.products = [{'sku': p['sku']} for p in preset['products']]
        self.categories = [{'slug': c['slug']} for c in preset['categories']]
        self.writes = []
        self.fail_publish = False

    def call(self, method, path, body=None):
        if method != 'GET':
            self.writes.append((method, path))
        if path.startswith('/v1/admin/catalog/products?'):
            offset = int(path.split('offset=')[1])
            result = self.products[offset:offset + 50]
        elif path == '/v1/catalog/categories':
            result = self.categories
        elif path == '/v1/admin/themes/assignments':
            result = [self.assignment]
        elif '/versions/' in path:
            result = self.versions[path.rsplit('/', 1)[1]]
        elif path.endswith('/publish'):
            if self.fail_publish:
                raise RuntimeError('Publish interrupted')
            assert body['expected_revision'] == self.theme['revision']
            self.theme['revision'] += 1
            self.theme['published_version'] = str(self.theme['revision'])
            result = {'configuration': copy.deepcopy(self.theme['configuration'])}
            self.versions[self.theme['published_version']] = result
        elif path == '/v1/admin/themes/theme-id':
            if method == 'PUT':
                assert body['expected_revision'] == self.theme['revision']
                self.theme['revision'] += 1
                self.theme['configuration'] = copy.deepcopy(body['configuration'])
            result = self.theme
        else:
            raise AssertionError((method, path))
        return copy.deepcopy(result)


class GroceryPaletteTests(unittest.TestCase):
    def test_updates_only_palette_and_reruns_without_writes(self):
        api = ThemeAPI()
        before = copy.deepcopy(api.theme['configuration'])
        before['tokens'].update(palette())
        self.assertTrue(sync(api, apply=True)['changed'])
        self.assertEqual(api.theme['configuration'], before)
        self.assertEqual(api.versions[api.theme['published_version']]['configuration'], before)
        self.assertEqual(len(api.writes), 2)
        self.assertFalse(sync(api, apply=True)['changed'])
        self.assertEqual(len(api.writes), 2)

    def test_check_makes_no_theme_writes(self):
        api = ThemeAPI()
        self.assertFalse(sync(api)['matches'])
        self.assertEqual(api.writes, [])

    def test_preserves_additional_demo_test_products(self):
        api = ThemeAPI()
        api.products.append({'sku': 'QA-PRODUCT'})
        api.categories.append({'slug': 'qa-category'})
        self.assertTrue(sync(api, apply=True)['matches'])
        self.assertEqual(api.products[-1], {'sku': 'QA-PRODUCT'})

    def test_accepts_the_original_local_grocery_seed(self):
        api = ThemeAPI()
        api.products = [{'sku': sku} for sku in ('DEMO-APL-001', 'DEMO-BAN-001', 'DEMO-BRD-001', 'QA-PRODUCT')]
        self.assertTrue(sync(api, apply=True)['matches'])

    def test_unpublished_content_is_not_accidentally_published(self):
        api = ThemeAPI()
        api.theme['configuration']['pages']['home'][0]['settings']['heading'] = 'Unpublished campaign'
        with self.assertRaisesRegex(ValueError, 'Unpublished non-palette'):
            sync(api, apply=True)
        self.assertEqual(api.writes, [])

    def test_can_fix_draft_without_publishing_when_live_palette_matches(self):
        api = ThemeAPI()
        api.versions['old']['configuration']['tokens'].update(palette())
        api.theme['configuration']['pages']['home'][0]['settings']['heading'] = 'Unpublished campaign'
        self.assertTrue(sync(api, apply=True)['matches'])
        self.assertEqual(api.writes, [('PUT', '/v1/admin/themes/theme-id')])
        self.assertEqual(api.theme['configuration']['pages']['home'][0]['settings']['heading'], 'Unpublished campaign')
        self.assertEqual(api.theme['published_version'], 'old')

    def test_interrupted_publish_recovers_without_resaving(self):
        api = ThemeAPI()
        api.fail_publish = True
        with self.assertRaisesRegex(RuntimeError, 'interrupted'):
            sync(api, apply=True)
        api.fail_publish = False
        self.assertTrue(sync(api, apply=True)['matches'])
        self.assertEqual(sum(method == 'PUT' for method, _ in api.writes), 1)

    def test_rejects_other_catalog_empty_store_and_targeting_before_writes(self):
        for case in ('other', 'empty', 'rules'):
            with self.subTest(case=case):
                api = ThemeAPI()
                if case == 'other':
                    api.products = [{'sku': 'ANOTHER-MERCHANT'}]
                elif case == 'empty':
                    api.products = []
                else:
                    api.assignment['rules'] = [{'theme_id': 'targeted-theme'}]
                with self.assertRaises(ValueError):
                    sync(api, apply=True)
                self.assertEqual(api.writes, [])

    def test_complete_seed_enforces_palette_only_for_enabled_grocery(self):
        root = Path(__file__).resolve().parents[3]
        script = (root / 'commerce-ops/deploy/ec2/server/ec2-seed-demo.sh').read_text()
        function = script.split('bootstrap_and_seed() {', 1)[1].split('mkdir -p /var/log/rocento/seeds', 1)[0]
        harness = 'bootstrap_and_seed() {' + function + """
ROOT=/repo
DOMAIN=example.test
DEFAULT_CERT=/protected/origin.pem
DELIVERY_ONLY=0
EXPAND_COVERAGE=0
GROCERY_ADMIN_EMAIL=test@example.test
GROCERY_ADMIN_PASSWORD=test-only-password
JEWELRY_ADMIN_EMAIL=test@example.test
JEWELRY_ADMIN_PASSWORD=test-only-password
temporary_seed_hosts() { :; }
restore_seed_hosts() { :; }
admin_email() { printf '%s' test@example.test; }
ok() { :; }
info() { :; }
touch() { :; }
python3() {
  test "$DEMO_ADMIN_EMAIL" = test@example.test
  test "$DEMO_SSL_CA_FILE" = /protected/origin.pem
  printf '%s\\n' "$*"
}
SEED_TARGET=grocery
DEMO_ADMIN_ENFORCE=0
bootstrap_and_seed
DEMO_ADMIN_ENFORCE=1
bootstrap_and_seed
SEED_TARGET=jewelry
bootstrap_and_seed
"""
        result = subprocess.run(['bash', '-eu', '-c', harness], check=True, text=True, capture_output=True)
        lines = result.stdout.splitlines()
        self.assertEqual(len(lines), 3)
        self.assertTrue(all('--complete' in line for line in lines))
        self.assertNotIn('--sync-palette', lines[0])
        self.assertIn('--sync-palette', lines[1])
        self.assertNotIn('--sync-palette', lines[2])


if __name__ == '__main__':
    unittest.main()
