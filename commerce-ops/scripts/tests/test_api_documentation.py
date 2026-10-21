import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location('api_documentation', ROOT / 'commerce-ops/scripts/checks/check_api_documentation.py')
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class RouteScannerTests(unittest.TestCase):
    def test_chained_methods_local_constant_and_duplicate_registration(self):
        routes, _ = CHECK.scan_source('''
            const PATH: &str = "/v1/example";
            Router::new().route(PATH, get(read).post(write).layer(limit))
                .route("/v1/example", get(fallback));
        ''', 'example.rs')
        self.assertEqual(routes, {('/v1/example', 'get'), ('/v1/example', 'post')})

    def test_comments_strings_nested_bodies_do_not_invent_routes_or_methods(self):
        routes, _ = CHECK.scan_source(r'''
            // .route("/comment", post(ignore))
            /* nested /* .route("/comment2", get(ignore)) */ comment */
            let text = r#".route("/string", get(ignore))"#;
            Router::new().route("/real", get(|| async { value.get('(') }));
        ''', 'example.rs')
        self.assertEqual(routes, {('/real', 'get')})

    def test_dynamic_routes_and_method_routers_require_scanner_review(self):
        for source in [
            'Router::new().route(path, get(read));',
            'Router::new().route("/a", any(read));',
            'Router::new().route("/a", get(read).on(MethodFilter::PATCH, write));',
            'Router::new().nest("/a", routes);',
            'Router::new().route_service("/a", service);',
        ]:
            with self.subTest(source=source), self.assertRaises(ValueError):
                CHECK.scan_source(source, 'example.rs')

    def test_exact_non_router_policy_call_is_ignored(self):
        source = 'app.public_admission.route(request.uri().path(), request.method())'
        self.assertEqual(CHECK.scan_source(source, 'commerce-api/rocento-api/crates/api-gateway/src/identity.rs'), (set(), set()))
        with self.assertRaises(ValueError):
            CHECK.scan_source(source, 'another.rs')


class CoverageTests(unittest.TestCase):
    def setUp(self):
        self.routes = {('/public', 'get'): ['source.rs'], ('/private', 'get'): ['source.rs']}
        self.policy = {'version': 1, 'groups': [
            {'audience': 'public', 'reason': 'Reviewed public schema.', 'references': ['public', 'merchant'], 'operations': ['GET /public']},
            {'audience': 'merchant', 'reason': 'Requires administrator docs permission.', 'references': ['merchant'], 'operations': ['GET /private']},
        ], 'fallbacks': {}}
        self.full = {'paths': {'/public': {'get': {}}, '/private': {'get': {}}}}
        self.public = {'paths': {'/public': {'get': {}}}}
        self.merchant = copy.deepcopy(self.full)

    def run_inventory(self, **changes):
        arguments = dict(routes=self.routes, fallbacks=set(), policy=self.policy, full=self.full, public=self.public, merchant=self.merchant)
        arguments.update(changes)
        return CHECK.inventory(**arguments)

    def test_new_route_or_method_requires_explicit_audience_review(self):
        for operation in [('/new', 'get'), ('/public', 'post'), ('/openapi.json', 'get')]:
            with self.subTest(operation=operation), self.assertRaisesRegex(ValueError, 'unclassified'):
                self.run_inventory(routes={**self.routes, operation: ['source.rs']})

    def test_removed_route_cannot_leave_stale_documentation(self):
        with self.assertRaisesRegex(ValueError, 'obsolete'):
            self.run_inventory(routes={('/public', 'get'): ['source.rs']})

    def test_full_contract_must_cover_every_nonexempt_route(self):
        with self.assertRaisesRegex(ValueError, 'full reference disagrees'):
            self.run_inventory(full=self.public)

    def test_private_operation_cannot_leak_into_public_contract(self):
        with self.assertRaisesRegex(ValueError, 'public reference disagrees'):
            self.run_inventory(public=self.full)

    def test_merchant_projection_must_match_review(self):
        with self.assertRaisesRegex(ValueError, 'merchant reference disagrees'):
            self.run_inventory(merchant=self.public)

    def test_exemptions_require_explicit_reason(self):
        self.policy['groups'][0]['full_contract'] = False
        with self.assertRaisesRegex(ValueError, 'exemption requires'):
            self.run_inventory()

    def test_duplicate_classification_is_rejected(self):
        self.policy['groups'][1]['operations'].append('GET /public')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            self.run_inventory()

    def test_new_fallback_requires_review(self):
        with self.assertRaisesRegex(ValueError, 'fallbacks changed'):
            self.run_inventory(fallbacks={'source.rs:fallback(anything)'})

    def test_repository_inventory_matches_generated_references(self):
        read = lambda path: json.loads((ROOT / path).read_text())
        routes, fallbacks = CHECK.scan_gateway(ROOT / 'commerce-api/rocento-api/crates/api-gateway/src')
        actual = CHECK.inventory(routes, fallbacks, read('commerce-ops/scripts/checks/api_documentation_policy.json'), read('commerce-api/rocento-api/openapi.json'), read('commerce-corporate-site/public/docs/api/openapi.json'), read('commerce-api/rocento-api/merchant-openapi.json'))
        self.assertEqual(actual, read('commerce-api/api-documentation-inventory.json'))


if __name__ == '__main__':
    unittest.main()
