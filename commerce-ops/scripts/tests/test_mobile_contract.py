"""Cross-language fixture validation against the canonical mobile contract."""
import copy
import json
from pathlib import Path
import unittest
from jsonschema import Draft202012Validator, RefResolver
from openapi_schema_validator import OAS30Validator

ROOT = Path(__file__).resolve().parents[3]
CONTRACT = ROOT / 'commerce-api/rocento-api/crates/domain-mobile/contract/v1'


class MobileContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema = json.loads((CONTRACT / 'schema.json').read_text())
        cls.validator = Draft202012Validator(cls.schema)
        cls.fixture = json.loads((CONTRACT / 'fixtures/merchant-1.json').read_text())
        cls.openapi = json.loads((ROOT / 'commerce-api/rocento-api/openapi.json').read_text())

    def test_schema_and_both_merchant_fixtures(self):
        Draft202012Validator.check_schema(self.schema)
        Draft202012Validator.check_schema(json.loads((CONTRACT / 'build-manifest.schema.json').read_text()))
        projected = OAS30Validator(self.openapi['components']['schemas']['MobileConfig'], resolver=RefResolver.from_schema(self.openapi))
        for path in (CONTRACT / 'fixtures').glob('*.json'):
            fixture = json.loads(path.read_text())
            self.validator.validate(fixture)
            projected.validate(fixture)

    def test_unknown_props_code_and_unbounded_sections_are_rejected(self):
        for field, value in [('type', 'webView'), ('props', {'javascript': 'alert(1)'}), ('props', {'url': 'https://arbitrary.example'})]:
            fixture = copy.deepcopy(self.fixture)
            fixture['screens']['home']['sections'][0][field] = value
            self.assertFalse(self.validator.is_valid(fixture))
        fixture = copy.deepcopy(self.fixture)
        fixture['screens']['home']['sections'] *= 16
        self.assertFalse(self.validator.is_valid(fixture))
        fixture = copy.deepcopy(self.fixture)
        fixture['signingSecret'] = 'not-allowed'
        self.assertFalse(self.validator.is_valid(fixture))

    def test_complete_component_fixture_shapes(self):
        for kind, props in [('productGrid', {'collectionId': 'featured', 'titleKey': 'featured_title', 'columns': 2}), ('categoryGrid', {'categoryIds': ['fruit'], 'titleKey': 'featured_title'}), ('richText', {'textKey': 'featured_title'}), ('spacer', {'size': 'medium'})]:
            fixture = copy.deepcopy(self.fixture)
            fixture['screens']['home']['sections'] = [{'id': kind, 'type': kind, 'props': props}]
            self.validator.validate(fixture)

    def test_mobile_security_is_explicit(self):
        for path, methods in self.openapi['paths'].items():
            if path.startswith('/v1/merchants/{merchant}/app-'):
                for method, op in methods.items():
                    self.assertEqual(op['security'], [{'adminSession': []}])
                    if '/app-devices' in path:
                        self.assertIn('Production-only', op['description'])
                    elif '/app-config/' in path or '/app-builds' in path or (
                        method == 'post' and path.endswith(('/app-preview/sessions', '/app-preview/sessions/worker'))
                    ):
                        self.assertTrue(any(p['name'] == 'environment' and p['required'] for p in op['parameters']))
        self.assertEqual(self.openapi['paths']['/v1/mobile/config']['get']['security'], [{'mobileAppSession': []}])

    def test_preview_instance_is_fixed_scope_and_does_not_accept_resource_selectors(self):
        path = '/v1/merchants/{merchant}/app-preview/instance'
        operations = self.openapi['paths'][path]
        for method, op in operations.items():
            self.assertEqual(op['security'], [{'adminSession': []}])
            self.assertIn('start/stop requires owner membership', op['description'])
            self.assertFalse(any(p['in'] == 'query' for p in op['parameters']))
            if method == 'post':
                self.assertTrue(any(p['name'] == 'X-Commerce-Request' and p['required'] for p in op['parameters']))
        schemas = self.openapi['components']['schemas']
        action = OAS30Validator(schemas['MobilePreviewInstanceAction'])
        action.validate({'action': 'start'})
        action.validate({'action': 'stop'})
        self.assertFalse(action.is_valid({'action': 'terminate'}))
        self.assertFalse(action.is_valid({'action': 'start', 'instanceId': 'i-other'}))
        status = OAS30Validator(schemas['MobilePreviewInstance'])
        status.validate({'state': 'stopped', 'ready': False, 'activeSessions': None})
        status.validate({'state': 'running', 'ready': True, 'activeSessions': 0})
        self.assertFalse(status.is_valid({'state': 'running', 'ready': True, 'activeSessions': -1}))


if __name__ == '__main__':
    unittest.main()
