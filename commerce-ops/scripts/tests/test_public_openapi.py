"""Publication boundary and credential semantics of the public API reference."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("public_openapi", ROOT / "commerce-ops/scripts/contracts/generate_public_openapi.py")
PUBLIC = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PUBLIC)


class PublicOpenApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = json.loads((ROOT / "commerce-api/rocento-api/openapi.json").read_text())

    def test_committed_reference_is_current_and_does_not_mutate_the_source(self):
        before = copy.deepcopy(self.source)
        contract = PUBLIC.build_public_contract(self.source)
        self.assertEqual(self.source, before)
        self.assertEqual(json.loads(PUBLIC.OUTPUT.read_text()), contract)
        self.assertEqual(contract["info"]["title"], "Rocento Storefront and Customer API")
        self.assertIn("not a released, stable public integration API", contract["info"]["description"])
        self.assertEqual(contract["servers"][0]["variables"]["storefrontHost"]["default"], "storefront.example.com")

    def test_new_routes_methods_and_unused_private_components_stay_private(self):
        source = copy.deepcopy(self.source)
        canary = {"operationId": "private_canary", "responses": {}, "description": "DO_NOT_PUBLISH"}
        source["paths"]["/v1/catalog/new-public-looking-route"] = {"get": canary}
        source["paths"]["/v1/catalog/products/{id}"]["delete"] = canary
        source["components"]["schemas"]["PrivateCanary"] = {"description": "DO_NOT_PUBLISH"}
        contract = PUBLIC.build_public_contract(source)
        self.assertEqual({(path, method) for path, methods in contract["paths"].items() for method in methods}, {(path, method) for path, method, *_ in PUBLIC.OPERATIONS})
        self.assertNotIn("DO_NOT_PUBLISH", json.dumps(contract))
        self.assertFalse(any(path.startswith(("/v1/admin/", "/v1/assistant", "/v1/agents/")) for path in contract["paths"]))
        self.assertNotIn("/ready", contract["paths"])
        self.assertNotIn("/v1/catalog/media/{id}", contract["paths"])
        self.assertNotIn("adminSession", contract["components"]["securitySchemes"])
        self.assertNotIn("agentProof", contract["components"]["securitySchemes"])
        self.assertNotIn("Admin", contract["components"]["schemas"])

    def test_schema_dependencies_are_closed_and_exactly_reachable(self):
        contract = PUBLIC.build_public_contract(self.source)
        schemas = contract["components"]["schemas"]
        pending = list(PUBLIC.references(contract["paths"]))
        seen = set()
        while pending:
            reference = pending.pop()
            self.assertTrue(reference.startswith(PUBLIC.SCHEMA_REF))
            name = reference.removeprefix(PUBLIC.SCHEMA_REF)
            self.assertIn(name, schemas)
            if name not in seen:
                seen.add(name)
                pending.extend(PUBLIC.references(schemas[name]))
        self.assertEqual(seen, set(schemas))

    def test_current_gateway_operations_have_a_reviewed_public_or_private_audience(self):
        published = {(path, method) for path, method, *_ in PUBLIC.OPERATIONS}
        self.assertEqual(len(published), len(PUBLIC.OPERATIONS), "Duplicate publication decisions")
        unreviewed = {
            (path, method)
            for path, methods in self.source["paths"].items()
            for method in methods
            if method in {"get", "post", "put", "patch", "delete", "head", "options", "trace"}
            and (path, method) not in published
            and path not in PUBLIC.PRIVATE_PATHS
            and not path.startswith(PUBLIC.PRIVATE_PATH_PREFIXES)
        }
        self.assertEqual(unreviewed, set(), "New storefront routes require an explicit audience review")
        paths = PUBLIC.build_public_contract(self.source)["paths"]
        for path in (
            "/v1/catalog/schema", "/v1/catalog/attribute-definitions", "/v1/inventory/{id}",
            "/v1/customer/attribute-definitions", "/v1/customer/orders/{id}/extensions",
            "/v1/cart/bundles/{id}", "/v1/cart/items/{id}/measure",
            "/v1/fulfillment/plans", "/v1/fulfillment/reservations", "/v1/support/session",
            "/v1/customer/support/tickets", "/v1/theme/{channel}", "/v1/content/{key}",
            "/v1/delivery-areas", "/v1/languages/interface", "/v1/discovery/attribution",
        ):
            self.assertIn(path, paths)

    def test_private_route_families_cannot_be_accidentally_added_to_the_allowlist(self):
        for path in (
            "/v1/admin/orders", "/v1/assistant/chat", "/v1/assistant-tools/cart",
            "/v1/agents/actions", "/v1/cart/trust", "/v1/cart/proposals",
            "/v1/cart/shopping/{task}", "/v1/cart/saved-goals", "/v1/publication/snapshot",
            "/v1/catalog/media/{id}", "/ready",
            "/v1/mobile/config", "/v1/mobile/merchants",
            "/v1/merchants/{merchant}/assets", "/v1/merchants/{merchant}/app-config/draft",
            "/v1/merchants/{merchant}/app-preview/catalog",
            "/v1/merchants/{merchant}/app-preview/categories",
            "/v1/merchants/{merchant}/app-preview/instance",
            "/v1/merchants/{merchant}/app-preview/products/{product}",
            "/v1/customer/push-devices/{id}",
        ):
            with self.subTest(path=path), patch.object(PUBLIC, "OPERATIONS", PUBLIC.OPERATIONS + ((path, "get", "Wrong audience", "Do not publish", "public"),)):
                with self.assertRaisesRegex(ValueError, "Private API cannot be published"):
                    PUBLIC.build_public_contract(self.source)

    def test_fulfillment_requires_verified_customer_scope_and_documents_hold_expiry(self):
        paths = PUBLIC.build_public_contract(self.source)["paths"]
        protected = [
            (path, method) for path, method, tag, _, security in PUBLIC.OPERATIONS
            if tag == "Fulfillment" and security == "customer"
        ]
        self.assertEqual(len(protected), 8)
        for path, method in protected:
            self.assertEqual(paths[path][method]["security"], [{"customerBearer": []}])
            self.assertIn("Requires a verified customer account", paths[path][method]["description"])
            self.assertIn("ownership", paths[path][method]["description"])
        for path in ("/v1/fulfillment/plans", "/v1/fulfillment/reservations"):
            self.assertIn("idempotency_key", paths[path]["post"]["description"])
            self.assertIn("expires", paths[path]["post"]["description"])
            self.assertIn("409", paths[path]["post"]["description"])

    def test_guest_support_uses_its_own_cookie_and_never_an_anonymous_ticket_owner(self):
        contract = PUBLIC.build_public_contract(self.source)
        paths, schemes = contract["paths"], contract["components"]["securitySchemes"]
        self.assertEqual(paths["/v1/support/session"]["post"]["security"], [])
        ticket = paths["/v1/support/tickets"]["post"]
        self.assertEqual(ticket["security"], [{"customerBearer": []}, {"supportGuest": []}])
        self.assertNotIn({}, ticket["security"])
        self.assertEqual(schemes["supportGuest"]["name"], "support_guest")
        self.assertNotEqual(schemes["supportGuest"]["name"], schemes["guestCart"]["name"])
        self.assertIn("order must belong", ticket["description"])
        reply = paths["/v1/customer/support/tickets/{id}/messages"]["post"]
        self.assertEqual(reply["security"], [{"customerBearer": []}])
        self.assertIn("Omit status", reply["description"])

    def test_optional_customer_context_and_browser_evidence_are_not_identity_bypasses(self):
        paths = PUBLIC.build_public_contract(self.source)["paths"]
        for path, method in (
            ("/v1/inventory/{id}", "get"), ("/v1/delivery-area", "get"),
            ("/v1/fulfillment/capabilities", "get"), ("/v1/theme/{channel}", "get"),
            ("/v1/analytics/events", "post"),
        ):
            self.assertEqual(paths[path][method]["security"], [{"customerBearer": []}, {}])
            self.assertIn("must contain a valid customer bearer token", paths[path][method]["description"])
        attribution = paths["/v1/discovery/attribution"]["post"]
        self.assertIn("verified customer token and ownership", attribution["description"])
        self.assertIn("not trusted identity", attribution["description"])
        origin = [p for p in attribution["parameters"] if p.get("in") == "header" and p.get("name", "").lower() == "origin"]
        self.assertEqual(len(origin), 1)
        self.assertTrue(origin[0]["required"])
        self.assertIn("do not create carts, place orders or prove purchases", paths["/v1/analytics/events"]["post"]["description"])

    def test_native_inbox_requires_recipient_credentials_for_receipts_and_keeps_admin_data_private(self):
        contract = PUBLIC.build_public_contract(self.source)
        paths, schemas = contract['paths'], contract['components']['schemas']
        recipients = [{'customerBearer': []}, {'inboxGuest': []}]
        self.assertEqual(paths['/v1/notifications']['get']['security'], recipients + [{}])
        for path, method in [('/v1/notifications/{id}/read', 'put'), ('/v1/notifications/read-all', 'post')]:
            operation = paths[path][method]
            self.assertEqual(operation['security'], recipients)
            self.assertIn('never fall back to a guest', operation['description'])
            self.assertTrue(any(p.get('name') == 'X-Commerce-Request' and p.get('required') for p in operation['parameters']))
        self.assertEqual(contract['components']['securitySchemes']['inboxGuest']['name'], 'inbox_guest')
        self.assertNotIn('customer_id', schemas['StorefrontNotification']['properties'])
        self.assertNotIn('source_record_id', schemas['StorefrontNotification']['properties'])
        for private in ['NotificationPublication', 'NotificationAnnouncementInput', 'GeneratedNotification', 'NotificationProgram']:
            self.assertNotIn(private, schemas)
        self.assertEqual(schemas['StorefrontNotificationReadAllInput']['required'], ['through'])

    def test_published_content_null_and_measured_cart_owner_are_documented(self):
        paths = PUBLIC.build_public_contract(self.source)["paths"]
        content = paths["/v1/content/{key}"]["get"]
        self.assertTrue(content["responses"]["200"]["content"]["application/json"]["schema"]["nullable"])
        for path, method in (("/v1/cart/items/{id}/measure", "put"), ("/v1/cart/bundles/{id}", "post")):
            self.assertEqual(paths[path][method]["security"], [{"customerBearer": []}, {"guestCart": []}])
            self.assertIn("product UUID", paths[path][method]["description"])

    def test_new_or_remote_schema_dependencies_fail_closed(self):
        for reference in ("#/components/schemas/Admin", "https://private.example/schema.json", "#/components/parameters/private"):
            with self.subTest(reference=reference):
                source = copy.deepcopy(self.source)
                source["components"]["schemas"]["Product"]["properties"]["unexpected"] = {"$ref": reference}
                with self.assertRaises(ValueError):
                    PUBLIC.build_public_contract(source)

    def test_new_sensitive_response_fields_require_review(self):
        source = copy.deepcopy(self.source)
        source["components"]["schemas"]["Product"]["properties"]["api_key"] = {"type": "string"}
        with self.assertRaisesRegex(ValueError, "Sensitive schema fields"):
            PUBLIC.build_public_contract(source)

    def test_examples_extensions_and_external_links_cannot_publish_credentials(self):
        source = copy.deepcopy(self.source)
        login = source["paths"]["/v1/customer/auth/login"]["post"]
        login["examples"] = {"production": {"value": "CREDENTIAL_CANARY"}}
        login["x-private-debug"] = "CREDENTIAL_CANARY"
        login["externalDocs"] = {"url": "https://private.example/CREDENTIAL_CANARY"}
        login["servers"] = [{"url": "https://CREDENTIAL_CANARY"}]
        login["callbacks"] = {"CREDENTIAL_CANARY": {}}
        source["components"]["schemas"]["Auth"]["properties"]["access_token"]["example"] = "CREDENTIAL_CANARY"
        source["components"]["schemas"]["Product"]["properties"]["examples"] = {"type": "string"}
        contract = PUBLIC.build_public_contract(source)
        self.assertNotIn("CREDENTIAL_CANARY", json.dumps(contract))
        self.assertIn("examples", contract["components"]["schemas"]["Product"]["properties"])

    def test_changed_or_missing_operation_identity_and_authentication_fail_closed(self):
        for mutation in ("missing", "identity", "auth", "global_auth", "scheme"):
            with self.subTest(mutation=mutation):
                source = copy.deepcopy(self.source)
                operation = source["paths"]["/v1/customer/me"]["get"]
                if mutation == "missing":
                    del source["paths"]["/v1/customer/me"]
                elif mutation == "identity":
                    operation["operationId"] = "unreviewed"
                elif mutation == "auth":
                    operation.pop("security")
                elif mutation == "global_auth":
                    source["security"] = [{"adminSession": []}]
                else:
                    source["components"]["securitySchemes"]["customerBearer"]["scheme"] = "basic"
                with self.assertRaises(ValueError):
                    PUBLIC.build_public_contract(source)

    def test_path_parameters_and_mutation_guards_must_remain_documented(self):
        source = copy.deepcopy(self.source)
        source["paths"]["/v1/cart/items/{id}"]["put"]["parameters"] = []
        with self.assertRaisesRegex(ValueError, "Path parameters changed"):
            PUBLIC.build_public_contract(source)
        source = copy.deepcopy(self.source)
        source["paths"]["/v1/customer/auth/login"]["post"]["parameters"] = []
        with self.assertRaisesRegex(ValueError, "Mutation request marker missing"):
            PUBLIC.build_public_contract(source)

    def test_customer_guest_and_verified_checkout_semantics(self):
        paths = PUBLIC.build_public_contract(self.source)["paths"]
        self.assertEqual(paths["/v1/catalog/categories"]["get"]["security"], [])
        self.assertEqual(paths["/v1/catalog/products/{id}"]["get"]["security"], [{"customerBearer": []}, {}])
        self.assertEqual(paths["/v1/customer/orders/{id}"]["get"]["security"], [{"customerBearer": []}])
        self.assertEqual(paths["/v1/cart/items"]["post"]["security"], [{"customerBearer": []}, {"guestCart": []}])
        self.assertIn({}, paths["/v1/cart"]["post"]["security"])
        self.assertIn({}, paths["/v1/customer/auth/refresh"]["post"]["security"])
        self.assertIn("204", paths["/v1/customer/auth/refresh"]["post"]["responses"])
        for path in ("/v1/customer/checkout/quote", "/v1/customer/checkout/place"):
            self.assertIn("Requires a verified customer account", paths[path]["post"]["description"])


if __name__ == "__main__":
    unittest.main()
