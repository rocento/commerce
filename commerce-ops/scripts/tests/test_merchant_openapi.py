"""The authenticated reference must not become an alternate full-schema download."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("merchant_openapi", ROOT / "commerce-ops/scripts/generate_merchant_openapi.py")
MERCHANT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MERCHANT)


class MerchantOpenApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = json.loads((ROOT / "commerce-api/rocento-api/openapi.json").read_text())

    def test_checked_in_contract_matches_review_and_preserves_input(self):
        source = copy.deepcopy(self.source)
        result = MERCHANT.build_merchant_contract(source)
        self.assertEqual(source, self.source)
        self.assertEqual(result, json.loads(MERCHANT.OUTPUT.read_text()))
        self.assertEqual(result["servers"], [{"url": "/api", "description": "Gateway on the provisioned merchant origin. Customer operations use that merchant's storefront origin."}])
        expected = set(MERCHANT.MERCHANT_OPERATIONS) | {(p, m) for p, m, *_ in MERCHANT.public.OPERATIONS}
        self.assertEqual(expected, {(p, m) for p, methods in result["paths"].items() for m in methods})
        self.assertIn(MERCHANT.DOCS_PATH, result["paths"])
        self.assertIn("api.docs.read", result["paths"][MERCHANT.DOCS_PATH]["get"]["description"])
        self.assertIn("default", result["paths"]["/v1/admin/users"]["get"]["responses"])

    def test_internal_and_future_admin_routes_remain_private(self):
        source = copy.deepcopy(self.source)
        source["paths"]["/v1/admin/future"] = {"get": {"description": "PRIVATE_CANARY"}}
        source["paths"]["/v1/admin/users"]["delete"] = {"description": "PRIVATE_CANARY"}
        result = MERCHANT.build_merchant_contract(source)
        self.assertNotIn("PRIVATE_CANARY", json.dumps(result))
        for path in result["paths"]:
            self.assertFalse(path.startswith(("/v1/assistant", "/v1/agents/", "/v1/admin/assistant/")))
            self.assertNotIn(path, {"/ready", "/health", "/metrics", "/openapi.json", "/v1/admin/reports/trace-probe", "/v1/admin/reports/assistant"})
        self.assertNotIn("agentProof", result["components"]["securitySchemes"])
        self.assertNotIn("AssistantProviderInput", result["components"]["schemas"])

    def test_mobile_previews_and_push_registration_remain_internal(self):
        contract = MERCHANT.build_merchant_contract(self.source)
        private = {
            path for path in self.source['paths']
            if path.startswith(('/v1/mobile/', '/v1/merchants/'))
            or path == '/v1/customer/push-devices/{id}'
        }
        self.assertTrue(private)
        self.assertTrue(private.isdisjoint(contract['paths']))
        self.assertFalse(any(name.startswith(('Mobile', 'CustomerPush')) for name in contract['components']['schemas']))

    def test_delivery_fee_rules_are_merchant_only_and_keep_execution_permissions(self):
        contract = MERCHANT.build_merchant_contract(self.source)
        public = MERCHANT.public.build_public_contract(self.source)
        for suffix, method, permission in [
            ('delivery-fee-choices', 'get', 'fulfillment.settings.read'),
            ('delivery-fee-rules', 'get', 'fulfillment.settings.read'),
            ('delivery-fee-rules', 'put', 'fulfillment.settings.write'),
        ]:
            path = '/v1/admin/settings/' + suffix
            operation = contract['paths'][path][method]
            self.assertEqual(operation['security'], [{'adminSession': []}])
            self.assertIn(permission, operation['description'])
            self.assertNotIn(path, public['paths'])
            if method == 'put':
                self.assertTrue(any(p['name'] == 'X-Commerce-Request' and p['required'] for p in operation['parameters']))

    def test_private_dependencies_remote_refs_and_secrets_fail_closed(self):
        for ref in ("#/components/schemas/AssistantProviderInput", "https://external.example/schema.json", "#/components/parameters/private"):
            source = copy.deepcopy(self.source)
            source["components"]["schemas"]["Admin"]["properties"]["unexpected"] = {"$ref": ref}
            with self.subTest(reference=ref), self.assertRaises(ValueError):
                MERCHANT.build_merchant_contract(source)
        for key in ("api_key", "password_hash", "client_secret", "private_key", "signing_key"):
            source = copy.deepcopy(self.source)
            source["components"]["schemas"]["Admin"]["properties"][key] = {"type": "string"}
            with self.subTest(field=key), self.assertRaisesRegex(ValueError, "Sensitive merchant fields"):
                MERCHANT.build_merchant_contract(source)

    def test_native_publication_is_permissioned_and_immutable(self):
        contract = MERCHANT.build_merchant_contract(self.source)
        base = '/v1/admin/marketing/notifications'
        for path in [base + '/publications', base + '/records/{id}/publish', base + '/publications/{id}/withdraw']:
            operation = contract['paths'][path]['post']
            self.assertEqual(operation['security'], [{'adminSession': []}])
            self.assertIn('notifications.publish', operation['description'])
            self.assertIn('409', operation['responses'])
        deletion = contract['paths'][base + '/publications/{id}']['delete']
        self.assertEqual(deletion['security'], [{'adminSession': []}])
        for permission in ('notifications.read', 'notifications.publish', 'customers.read and orders.read'):
            self.assertIn(permission, deletion['description'])
        self.assertIn('409', deletion['responses'])
        self.assertEqual(deletion['responses']['200']['content']['application/json']['schema']['$ref'],
                         '#/components/schemas/NotificationDeleteResult')
        self.assertNotIn(base + '/publications/{id}', MERCHANT.public.build_public_contract(self.source)['paths'])
        personal = contract['paths'][base + '/records/{id}/publish']['post']
        self.assertIn('customers.read and orders.read', personal['description'])
        self.assertIn('201', personal['responses'])
        self.assertIn('200', personal['responses'])
        schemas = contract['components']['schemas']
        self.assertNotIn('customer_id', schemas['NotificationPublicationOptions']['properties'])
        self.assertNotIn('body', schemas['NotificationPublicationOptions']['properties'])
        self.assertEqual(schemas['NotificationAnnouncementInput']['properties']['audience']['enum'], ['all', 'guests', 'customers'])

    def test_source_examples_defaults_and_external_execution_metadata_are_stripped(self):
        source = copy.deepcopy(self.source)
        operation = source["paths"]["/v1/admin/auth/login"]["post"]
        for key in ("example", "examples", "externalDocs", "servers", "callbacks", "links", "x-internal"):
            operation[key] = "CREDENTIAL_CANARY"
        source["components"]["schemas"]["AdminCredentials"]["properties"]["password"].update(default="CREDENTIAL_CANARY", example="CREDENTIAL_CANARY")
        result = MERCHANT.build_merchant_contract(source)
        self.assertNotIn("CREDENTIAL_CANARY", json.dumps(result))
        self.assertTrue(result["components"]["schemas"]["AdminCredentials"]["properties"]["password"]["writeOnly"])
        self.assertIn("default", result["paths"]["/v1/admin/auth/login"]["post"]["responses"])

    def test_authentication_identity_and_guards_cannot_change_silently(self):
        for change in ("auth", "identity", "missing", "scheme", "path", "marker"):
            source = copy.deepcopy(self.source)
            operation = source["paths"]["/v1/admin/users/{id}"]["put"]
            if change == "auth": operation["security"] = []
            elif change == "identity": operation["operationId"] = "unknown"
            elif change == "missing": del source["paths"]["/v1/admin/users/{id}"]["put"]
            elif change == "scheme": source["components"]["securitySchemes"]["adminSession"]["name"] = "customer_refresh"
            elif change == "path": operation["parameters"] = [p for p in operation["parameters"] if p["in"] != "path"]
            else: operation["parameters"] = [p for p in operation["parameters"] if p.get("name") != "X-Commerce-Request"]
            with self.subTest(change=change), self.assertRaises(ValueError):
                MERCHANT.build_merchant_contract(source)

    def test_reference_closure_contains_only_reachable_local_schemas(self):
        result = MERCHANT.build_merchant_contract(self.source)
        schemas = result["components"]["schemas"]
        pending = list(MERCHANT.public.references(result["paths"]))
        seen = set()
        while pending:
            ref = pending.pop()
            self.assertTrue(ref.startswith(MERCHANT.public.SCHEMA_REF))
            name = ref.removeprefix(MERCHANT.public.SCHEMA_REF)
            self.assertIn(name, schemas)
            if name not in seen:
                seen.add(name)
                pending.extend(MERCHANT.public.references(schemas[name]))
        self.assertEqual(seen, set(schemas))

    def test_raw_full_contract_is_not_registered_by_the_gateway(self):
        # The executable main builds the complete router; do not reintroduce a
        # unauthenticated handler even if ingress also blocks the raw path.
        main = (ROOT / "commerce-api/rocento-api/crates/api-gateway/src/main.rs").read_text()
        self.assertNotIn('"/openapi.json"', main)
        self.assertNotIn('include_str!("../../../openapi.json")', main)
        self.assertIn('api_gateway::api_reference::router(identity.clone())', main)


if __name__ == "__main__":
    unittest.main()
