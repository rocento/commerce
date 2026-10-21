"""Ensure shipping schemes retain privacy resources and isolated commerce fixtures."""
from contextlib import redirect_stdout
import io
from pathlib import Path
import plistlib
import runpy
import sys
import unittest
from unittest.mock import patch

MOBILE = Path(__file__).resolve().parents[2]


class IOSReleaseWiringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        generator = MOBILE / 'tools/generate_xcode_project.py'
        with patch.object(sys, 'argv', [str(generator), '--check']), redirect_stdout(io.StringIO()):
            cls.objects = runpy.run_path(str(generator))['objects']

    def test_every_app_bundles_the_required_reason_manifest(self):
        manifest = plistlib.loads((MOBILE / 'ios/Storefront/PrivacyInfo.xcprivacy').read_bytes())
        categories = {item['NSPrivacyAccessedAPIType']: item['NSPrivacyAccessedAPITypeReasons']
                      for item in manifest['NSPrivacyAccessedAPITypes']}
        self.assertIn('CA92.1', categories['NSPrivacyAccessedAPICategoryUserDefaults'])
        apps = [obj for obj in self.objects.values()
                if obj.get('productType') == 'com.apple.product-type.application']
        self.assertEqual({app['name'] for app in apps},
                         {'Market', 'Boutique', 'Rocento', 'Electronics', 'Jewelry', 'Pharmacy'})
        for app in apps:
            with self.subTest(app=app['name']):
                resources = [self.objects[phase] for phase in app['buildPhases']
                             if self.objects[phase]['isa'] == 'PBXResourcesBuildPhase']
                paths = [self.objects[self.objects[entry]['fileRef']]['path']
                         for phase in resources for entry in phase['files']]
                self.assertIn('Storefront/PrivacyInfo.xcprivacy', paths)

    def test_merchant_apps_link_published_settings_and_fixtures_stay_local(self):
        apps = [obj for obj in self.objects.values()
                if obj.get('productType') == 'com.apple.product-type.application']
        for app in apps:
            merchant = app['name'] not in ('Market', 'Boutique')
            dependencies = [self.objects[key]['productName']
                            for key in app['packageProductDependencies']]
            self.assertEqual('RocentoAppBuilder' in dependencies, merchant)
            sources = [self.objects[phase] for phase in app['buildPhases']
                       if self.objects[phase]['isa'] == 'PBXSourcesBuildPhase']
            paths = [self.objects[self.objects[entry]['fileRef']]['path']
                     for phase in sources for entry in phase['files']]
            self.assertEqual('Integrations/AppBuilder/StorefrontIntegration.swift' in paths, merchant)
            self.assertEqual('Integrations/Standalone/StorefrontIntegration.swift' in paths, not merchant)

    def test_every_shipping_test_target_has_explicit_commerce_fixture_metadata(self):
        info = plistlib.loads((MOBILE / 'ios/StorefrontUITests/Info.plist').read_bytes())
        self.assertEqual(info['RocentoProduction'], '$(ROCENTO_PRODUCTION)')
        tests = [obj for obj in self.objects.values()
                 if obj.get('productType') == 'com.apple.product-type.bundle.ui-testing']
        for target in tests:
            preview = target['name'] in {'MarketUITests', 'BoutiqueUITests'}
            configs = self.objects[target['buildConfigurationList']]['buildConfigurations']
            for config in configs:
                with self.subTest(target=target['name'], config=config):
                    settings = self.objects[config]['buildSettings']
                    self.assertEqual(settings['ROCENTO_PRODUCTION'], 'NO' if preview else 'YES')
                    self.assertEqual(settings['INFOPLIST_FILE'], 'StorefrontUITests/Info.plist')


if __name__ == '__main__':
    unittest.main()
