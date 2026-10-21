"""Standards-aware validation, complete route inventory and client semantics."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from jsonschema import RefResolver
from openapi_schema_validator import OAS30Validator
from openapi_spec_validator import OpenAPIV30SpecValidator

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location('contract_checks', ROOT / 'commerce-api/rocento-api/crates/api-gateway/openapi/contract_checks.py')
CHECKS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKS)


class OpenApiContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.full = json.loads((ROOT / 'commerce-api/rocento-api/openapi.json').read_text())
        cls.public = json.loads((ROOT / 'commerce-corporate-site/public/docs/api/openapi.json').read_text())
        cls.merchant = json.loads((ROOT / 'commerce-api/rocento-api/merchant-openapi.json').read_text())

    def validator(self, schema, contract=None):
        return OAS30Validator(schema, resolver=RefResolver.from_schema(contract or self.full), format_checker=OAS30Validator.FORMAT_CHECKER)

    def test_documents_conform_to_openapi_30(self):
        for contract in [self.full, self.public, self.merchant]:
            with self.subTest(title=contract['info']['title']):
                OpenAPIV30SpecValidator(contract).validate()
                CHECKS.validate_paths(contract)

    def test_every_gateway_route_is_documented_or_exactly_excluded(self):
        CHECKS.validate_route_coverage(self.full, ROOT / 'commerce-api/rocento-api/crates/api-gateway/src')
        self.assertTrue(all(CHECKS.ROUTE_EXCLUSIONS.values()))
        self.assertFalse(any(path.startswith('/v1/') for path, _ in CHECKS.ROUTE_EXCLUSIONS))

    def test_new_routes_and_missing_template_parameters_fail_closed(self):
        source = copy.deepcopy(self.full)
        del source['paths']['/v1/admin/exports']
        with self.assertRaisesRegex(ValueError, 'Route coverage'):
            CHECKS.validate_route_coverage(source, ROOT / 'commerce-api/rocento-api/crates/api-gateway/src')
        source = copy.deepcopy(self.full)
        source['paths']['/v1/admin/markets/{market}/{kind}/{id}']['get']['parameters'] = []
        with self.assertRaisesRegex(ValueError, 'path parameters'):
            CHECKS.validate_paths(source)
        with tempfile.TemporaryDirectory() as directory:
            route = Path(directory, 'routes.rs')
            route.write_text('pub const PATH: &str = "/v1/new"; Router::new().route(PATH, get(read).post(write).delete(remove))')
            self.assertEqual(CHECKS.router_operations(Path(directory)), {('/v1/new', method) for method in ['get', 'post', 'delete']})
            route.write_text('''
#[cfg(test)] mod fixtures {
    fn router() { Router::new().route("/fixture", get(|| async { "braces { }" })); }
}
#[cfg(feature = "optional")] fn live() { Router::new().route("/live", get(read)); }
''')
            self.assertEqual(CHECKS.router_operations(Path(directory)), {('/live', 'get')})
            route.write_text('Router::new().route(dynamic_path(), get(read))')
            with self.assertRaisesRegex(ValueError, 'route path'):
                CHECKS.router_operations(Path(directory))

    def test_runtime_null_order_fields_and_referenced_arrays_validate(self):
        # Serde Option fields without skip_serializing_if return JSON null for
        # undispatched orders and orders without a managed fulfillment plan.
        for contract in [self.full, self.public, self.merchant]:
            for name in ['dispatch', 'fulfillment_plan']:
                schema = contract['components']['schemas']['OrderDetail']['properties'][name]
                self.validator(schema, contract).validate(None)
                self.assertFalse(self.validator(schema, contract).is_valid('not an object'))
                self.assertFalse(self.validator(schema, contract).is_valid({}))
        raw = {'components': {'schemas': {'Strings': {'type': 'array', 'items': {'type': 'string'}}}}}
        normalized = CHECKS.normalize_nullable({'$ref': '#/components/schemas/Strings', 'nullable': True})
        for valid in [None, [], ['a']]:
            self.validator(normalized, raw).validate(valid)
        self.assertFalse(self.validator(normalized, raw).is_valid([1]))
        self.assertFalse(self.validator(normalized, raw).is_valid({}))

    def test_no_nullable_reference_siblings_or_invalid_dialect_keywords(self):
        def visit(value):
            if isinstance(value, dict):
                self.assertFalse('$ref' in value and 'nullable' in value)
                self.assertNotEqual(value.get('required'), [])
                self.assertNotIn('const', value)
                for child in value.values():
                    visit(child)
            elif isinstance(value, list):
                for child in value:
                    visit(child)
        for contract in [self.full, self.public, self.merchant]:
            visit(contract)

    def test_export_filters_allow_omitted_or_null_serde_options(self):
        schema = self.full['components']['schemas']['GridRequest']
        for value in [{}, {'category_id': None, 'active': None, 'limit': None}]:
            self.validator(schema).validate(value)
        for value in [{'q': None}, {'descending': None}, {'active': 'false'}, {'limit': 201}]:
            self.assertFalse(self.validator(schema).is_valid(value))

    def test_review_and_profile_constraints_match_documented_boundaries(self):
        review = self.full['components']['schemas']['ReviewInput']
        valid = {'display_name': 'A' * 80, 'rating': 5, 'title': 'T' * 200, 'body': 'B' * 4000}
        self.validator(review).validate(valid)
        for key, invalid in [('rating', 0), ('rating', 6), ('display_name', 'A' * 81), ('title', ' '), ('body', '')]:
            with self.subTest(key=key, invalid=invalid):
                self.assertFalse(self.validator(review).is_valid({**valid, key: invalid}))
        for field, limit in [('display_name', 80), ('title', 200), ('body', 4000)]:
            self.assertIn(f'{limit} UTF-8 bytes', review['properties'][field]['description'])
            # JSON Schema maxLength counts characters, not Rust String bytes.
            # A 41-character Arabic name needs 82 bytes: the additional runtime
            # byte limit is explicit, never misrepresented as maxLength alone.
        self.assertEqual(len(('ع' * 41).encode('utf-8')), 82)
        profile = self.full['components']['schemas']['ProfileInput']
        valid = {'first_name': '', 'last_name': '', 'gender': '', 'attributes': {}, 'date_of_birth': '2000-01-01'}
        self.validator(profile).validate(valid)
        for key, invalid in [('gender', 'unsupported'), ('date_of_birth', 'tomorrow'), ('first_name', 'a' * 121)]:
            self.assertFalse(self.validator(profile).is_valid({**valid, key: invalid}))

    def test_catalog_context_and_private_tool_auth_are_explicit(self):
        for contract in [self.full, self.public]:
            for path in ['/v1/catalog/products/{id}', '/v1/catalog/products/{id}/family', '/v1/catalog/bestsellers', '/v1/search']:
                operation = contract['paths'][path]['get']
                self.assertEqual(operation['security'], [{'customerBearer': []}, {}])
                self.assertIn('401', operation['responses'])
                self.assertIn('X-Storefront-Locale', [p['name'] for p in operation['parameters']])
        for path, methods in self.full['paths'].items():
            if path.startswith('/v1/assistant-tools/'):
                for operation in methods.values():
                    self.assertEqual(operation['security'], [{'assistantCapability': []}])

    def test_notification_rules_preserve_legacy_inputs_and_bound_structured_conditions(self):
        schemas = self.full['components']['schemas']
        program = {'name': 'Order acknowledgement', 'description': '', 'channel': 'in_app',
            'trigger_kind': 'purchase', 'title_template': 'Thank you', 'body_template': 'Your order is recorded.',
            'status': 'draft', 'delay_minutes': 0, 'lookback_days': 7, 'cooldown_hours': 24,
            'suppress_after_purchase': False}
        self.validator(schemas['NotificationProgramInput']).validate(program)
        condition = {'field': 'order.total', 'operator': 'gte', 'value': '100.01', 'currency': 'EGP'}
        self.validator(schemas['NotificationProgramInput']).validate({**program, 'conditions': {'match': 'all', 'rules': [condition]}})
        for group in [{'match': 'sometimes', 'rules': []}, {'match': 'any', 'rules': []}, {'match': 'all', 'rules': [condition] * 11},
                      {'match': 'all', 'rules': [{**condition, 'sql': 'SELECT customer'}]},
                      {'match': 'all', 'rules': [{**condition, 'field': 'customer.password'}]},
                      {'match': 'all', 'rules': [{**condition, 'value': 100.01}]},
                      {'match': 'all', 'rules': [{**condition, 'currency': 'egp'}]},
                      {'match': 'all', 'rules': [{'field': 'order.total', 'operator': 'gte', 'value': '1.00'}]},
                      {'match': 'all', 'rules': [{'field': 'customer.verified', 'operator': 'contains', 'value': 'true'}]},
                      {'match': 'all', 'rules': [{'field': 'customer.order_count', 'operator': 'eq', 'value': '1e5'}]}]:
            self.assertFalse(self.validator(schemas['NotificationConditions']).is_valid(group))
        result = {'index': 0, 'field': 'order.total', 'operator': 'gte', 'expected': '100.01 EGP',
                  'actual': None, 'matched': False, 'reason': 'No amount is available for this event.'}
        self.validator(schemas['NotificationConditionResult']).validate(result)
        for private in ['NotificationConditions', 'NotificationConditionField', 'NotificationConditionResult']:
            self.assertNotIn(private, self.public['components']['schemas'])
            self.assertIn(private, self.merchant['components']['schemas'])

    def test_campaign_drafts_and_audience_rules_remain_private_and_bounded(self):
        schemas = self.full['components']['schemas']
        rules = {'segment_ids': [], 'segment_match': 'all', 'trigger_kind': None,
            'conditions': {'match': 'all', 'rules': []}, 'delay_minutes': 0,
            'lookback_days': 7, 'cooldown_hours': 0, 'max_deliveries': 1,
            'suppress_after_purchase': False}
        announcement = {'title': 'A welcome message', 'body': 'Welcome back.', 'audience': 'customers',
            'expires_at': '2026-11-01T12:00:00Z'}
        draft = {'name': 'Welcome', 'description': '', 'version': 0, 'announcement': announcement}
        self.validator(schemas['NotificationCampaignInput']).validate(draft)
        self.validator(schemas['NotificationCampaignInput']).validate({**draft, 'announcement': {
            **announcement, 'audience_rules': rules}})
        self.validator(schemas['NotificationAnnouncementInput']).validate({**announcement,
            'audience_rules': None, 'idempotency_key': 'b37d5b29-a4ef-4a18-881b-49a4cf8bb738'})
        for change in [{'segment_match': 'unknown'}, {'trigger_kind': 'custom.event'},
                       {'delay_minutes': 43201}, {'lookback_days': 0}, {'cooldown_hours': 2161},
                       {'max_deliveries': 101}, {'customer_id': 'caller-supplied'},
                       {'segment_ids': ['b37d5b29-a4ef-4a18-881b-49a4cf8bb738'] * 2},
                       {'segment_ids': [f'b37d5b29-a4ef-4a18-881b-{i:012d}' for i in range(21)]}]:
            with self.subTest(change=change):
                self.assertFalse(self.validator(schemas['NotificationAudienceRules']).is_valid({**rules, **change}))
        self.assertFalse(self.validator(schemas['NotificationCampaignAnnouncement']).is_valid({
            **announcement, 'idempotency_key': 'b37d5b29-a4ef-4a18-881b-49a4cf8bb738'}))
        for name in ['NotificationAudienceRules', 'NotificationCampaignInput', 'NotificationCampaign',
                     'NotificationCampaignList', 'NotificationCampaignActivateInput']:
            self.assertNotIn(name, self.public['components']['schemas'])
            self.assertIn(name, self.merchant['components']['schemas'])
        base = '/v1/admin/marketing/notifications/campaigns'
        for path, method in [(base, 'get'), (base, 'post'), (base + '/{id}', 'get'),
                             (base + '/{id}', 'put'), (base + '/{id}/activate', 'post')]:
            operation = self.merchant['paths'][path][method]
            self.assertEqual(operation['security'], [{'adminSession': []}])
            self.assertIn('notifications.read', operation['description'])
            self.assertNotIn(path, self.public['paths'])
        activation = self.merchant['paths'][base + '/{id}/activate']['post']
        self.assertIn('notifications.write', self.merchant['paths'][base]['post']['description'])
        self.assertIn('notifications.write', self.merchant['paths'][base + '/{id}']['put']['description'])
        self.assertIn('notifications.publish', activation['description'])
        self.assertIn('200', activation['responses'])
        self.assertIn('201', activation['responses'])
        self.assertIn('409', activation['responses'])

    def test_overload_preserves_endpoint_responses_and_documents_shared_quotas(self):
        spec = importlib.util.spec_from_file_location('admission_contract', ROOT / 'commerce-api/rocento-api/crates/api-gateway/openapi/admission_contract.py')
        admission = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(admission)
        custom_paths = copy.deepcopy(self.full['paths'])
        snapshot_unavailable = custom_paths['/v1/publication/snapshot']['get']['responses']['503']
        custom = {'type': 'object', 'properties': {'unavailable': {'type': 'boolean'}}, 'required': ['unavailable'], 'additionalProperties': False}
        snapshot_unavailable['content']['application/json']['schema'] = custom
        admission.extend(custom_paths)
        alternatives = custom_paths['/v1/publication/snapshot']['get']['responses']['503']['content']
        self.assertEqual(alternatives['application/json']['schema'], {'anyOf': [custom, {'$ref': '#/components/schemas/Error'}]})
        self.assertEqual(alternatives['text/plain'], self.full['paths']['/v1/publication/snapshot']['get']['responses']['503']['content']['text/plain'])
        for contract in [self.full, self.public, self.merchant]:
            for path, methods in contract['paths'].items():
                if path in ['/health', '/ready', '/metrics']:
                    continue
                for operation in methods.values():
                    unavailable = operation['responses']['503']
                    self.assertEqual(unavailable['headers']['Retry-After']['schema']['enum'], [3])
                    self.assertIn('application/json', unavailable['content'])
                    self.assertIn('idempotency key', unavailable['description'])
        self.assertEqual(self.full['paths']['/ready']['get']['responses']['503']['content']['application/json']['schema'], {'$ref': '#/components/schemas/Readiness'})
        self.assertIn('text/plain', self.full['paths']['/v1/publication/snapshot']['get']['responses']['503']['content'])
        self.assertIn('Password hashing', self.full['paths']['/v1/customer/auth/login']['post']['responses']['503']['description'])
        expected = {
            ('/v1/support/tickets', 'post'): ('support_guest', 20, 100, 2000),
            ('/v1/assistant/chat', 'post'): ('assistant_visitor', 120, 480, 3000),
            ('/v1/analytics/events', 'post'): ('analytics_visitor', 1000, 4000, 100000),
        }
        expected.update({(path, method): ('assistant_visitor', 120, 600, 12000)
            for path, methods in self.full['paths'].items()
            if path == '/v1/assistant/memory' or path.startswith('/v1/assistant/memory/') for method in methods})
        for (path, method), (cookie, subject, source, aggregate) in expected.items():
            operation = self.full['paths'][path][method]
            self.assertEqual(operation['responses']['429']['headers']['Retry-After']['schema']['enum'], [900])
            self.assertTrue(any(p['in'] == 'cookie' and p['name'] == cookie for p in operation['parameters']))
            self.assertIn(f'{subject} requests per customer or visitor;', operation['description'])
            self.assertIn(f'{source} per direct connection source in peer mode;', operation['description'])
            self.assertIn(f'{aggregate} per installation by default.', operation['description'])
            self.assertTrue(any('Set-Cookie' in r.get('headers', {}) for status, r in operation['responses'].items() if status.startswith('2')))


if __name__ == '__main__':
    unittest.main()
