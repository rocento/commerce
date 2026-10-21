"""Publish the reviewed application API subset; never copy the private contract.

Run after scripts/generate_openapi.py. Use --check in CI. Adding an operation or
schema dependency requires an explicit publication review here. This is a docs
projection only: runtime authentication remains the gateway's responsibility.
"""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "commerce-api/rocento-api/openapi.json"
OUTPUT = ROOT / "commerce-corporate-site/public/docs/api/openapi.json"

# Exact path + method pairs, not prefix matching: future routes stay private.
# The final column is the security metadata expected in the source contract.
OPERATIONS = (
    ("/v1/notifications", "get", "Storefront notifications", "Read the native inbox", "inbox_optional"),
    ("/v1/notifications/{id}/read", "put", "Storefront notifications", "Set a notification's read state", "inbox"),
    ("/v1/notifications/product-view", "post", "Storefront notifications", "Deliver product visitor offers", "inbox"),
    ("/v1/notifications/read-all", "post", "Storefront notifications", "Mark the inbox snapshot read", "inbox"),
    ("/v1/catalog/categories", "get", "Catalog", "List categories", "public"),
    ("/v1/catalog/category-availability", "get", "Catalog", "Read category availability", "public"),
    ("/v1/catalog/products/{id}", "get", "Catalog", "Read a product", "customer_optional"),
    ("/v1/catalog/products/{id}/family", "get", "Catalog", "Read a product family", "customer_optional"),
    ("/v1/catalog/relationships", "get", "Catalog", "Resolve product relationships", "customer_optional"),
    ("/v1/catalog/bestsellers", "get", "Catalog", "List bestselling products", "customer_optional"),
    ("/v1/catalog/media/{id}/content", "get", "Catalog", "Read a product image", "public"),
    ("/v1/catalog/schema", "get", "Catalog", "Read the shopper catalog schema", "public"),
    ("/v1/catalog/attribute-definitions", "get", "Catalog", "List storefront product attributes", "public"),
    ("/v1/inventory/{id}", "get", "Catalog", "Read product availability", "public"),
    ("/v1/search", "get", "Catalog", "Search products", "customer_optional"),
    ("/v1/customer/auth/register", "post", "Customer authentication", "Register a customer", "public"),
    ("/v1/customer/auth/login", "post", "Customer authentication", "Sign in a customer", "public"),
    ("/v1/customer/auth/refresh", "post", "Customer authentication", "Refresh a customer session", "refresh_optional"),
    ("/v1/customer/auth/logout", "post", "Customer authentication", "Sign out a customer", "refresh"),
    ("/v1/customer/auth/request-verification", "post", "Customer authentication", "Request a verification challenge", "public"),
    ("/v1/customer/auth/verify", "post", "Customer authentication", "Verify a customer account", "public"),
    ("/v1/customer/auth/forgot-password", "post", "Customer authentication", "Request a password reset", "public"),
    ("/v1/customer/auth/reset-password", "post", "Customer authentication", "Reset a password", "public"),
    ("/v1/customer/me", "get", "Customer account", "Read the signed-in customer", "customer"),
    ("/v1/customer/checkout-eligibility", "get", "Customer account", "Check verified checkout eligibility", "customer"),
    ("/v1/customer/locations", "get", "Customer account", "List saved delivery locations", "customer"),
    ("/v1/customer/locations", "post", "Customer account", "Create a delivery location", "customer"),
    ("/v1/customer/locations/{id}", "put", "Customer account", "Update a delivery location", "customer"),
    ("/v1/customer/locations/{id}", "delete", "Customer account", "Delete a delivery location", "customer"),
    ("/v1/customer/profile", "get", "Customer account", "Read the customer profile", "customer"),
    ("/v1/customer/profile", "put", "Customer account", "Update the customer profile", "customer"),
    ("/v1/customer/attribute-definitions", "get", "Customer account", "List customer profile attributes", "customer"),
    ("/v1/customer/wishlist", "get", "Wishlist and reviews", "List wishlist product IDs", "customer"),
    ("/v1/customer/wishlist/{id}", "put", "Wishlist and reviews", "Add a product to the wishlist", "customer"),
    ("/v1/customer/wishlist/{id}", "delete", "Wishlist and reviews", "Remove a product from the wishlist", "customer"),
    ("/v1/products/{id}/reviews", "get", "Wishlist and reviews", "List published product reviews", "public"),
    ("/v1/customer/products/{id}/review", "get", "Wishlist and reviews", "Read the customer's review", "customer"),
    ("/v1/customer/products/{id}/review", "put", "Wishlist and reviews", "Submit a product review", "customer"),
    ("/v1/cart", "post", "Cart", "Open or resume a cart", "public"),
    ("/v1/cart/coupon", "put", "Cart", "Apply or remove a coupon", "public"),
    ("/v1/cart/items", "post", "Cart", "Add a product to the cart", "public"),
    ("/v1/cart/items/{id}", "put", "Cart", "Set a cart product quantity", "public"),
    ("/v1/cart/items/{id}", "delete", "Cart", "Remove a cart product", "public"),
    ("/v1/cart/items/{id}/measure", "put", "Cart", "Set an exact measured quantity", "public"),
    ("/v1/cart/bundles/{id}", "post", "Cart", "Add selected bundle products", "public"),
    ("/v1/customer/checkout/quote", "post", "Checkout and orders", "Create a checkout quote", "customer"),
    ("/v1/customer/checkout/place", "post", "Checkout and orders", "Place an order from a quote", "customer"),
    ("/v1/customer/orders", "get", "Checkout and orders", "List the customer's orders", "customer"),
    ("/v1/customer/orders/{id}", "get", "Checkout and orders", "Read the customer's order", "customer"),
    ("/v1/customer/orders/{id}/extensions", "get", "Checkout and orders", "Read customer order extensions", "customer"),
    ("/v1/fulfillment/capabilities", "get", "Fulfillment", "Read available fulfillment capabilities", "public"),
    ("/v1/fulfillment/stores", "get", "Fulfillment", "List enabled fulfillment stores", "public"),
    ("/v1/fulfillment/store", "post", "Fulfillment", "Select a fulfillment store", "customer"),
    ("/v1/fulfillment/availability", "get", "Fulfillment", "Read the cart's fulfillment methods", "customer"),
    ("/v1/fulfillment/plan-options", "post", "Fulfillment", "Calculate fulfillment plan options", "customer"),
    ("/v1/fulfillment/plans", "post", "Fulfillment", "Reserve a fulfillment plan", "customer"),
    ("/v1/fulfillment/plans/{id}", "delete", "Fulfillment", "Release a fulfillment plan", "customer"),
    ("/v1/fulfillment/delivery-options", "get", "Fulfillment", "List delivery time windows", "customer"),
    ("/v1/fulfillment/reservations", "post", "Fulfillment", "Reserve a delivery time window", "customer"),
    ("/v1/fulfillment/reservations/{id}", "delete", "Fulfillment", "Release a delivery time window", "customer"),
    ("/v1/support/session", "post", "Customer support", "Initialize a guest support session", "public"),
    ("/v1/support/tickets", "post", "Customer support", "Create a support ticket", "public"),
    ("/v1/customer/support/tickets", "get", "Customer support", "List the customer's support tickets", "customer"),
    ("/v1/customer/support/tickets/{id}", "get", "Customer support", "Read the customer's support ticket", "customer"),
    ("/v1/customer/support/tickets/{id}/messages", "post", "Customer support", "Reply to the customer's support ticket", "customer"),
    ("/v1/delivery-area", "get", "Store context", "Check delivery coverage", "public"),
    ("/v1/delivery-areas", "get", "Store context", "List delivery area choices", "public"),
    ("/v1/markets/current", "get", "Store context", "Read the active storefront market", "public"),
    ("/v1/languages", "get", "Store context", "List storefront languages", "public"),
    ("/v1/languages/interface", "get", "Storefront presentation", "Read published interface messages", "public"),
    ("/v1/market", "get", "Store context", "Read currency and selling configuration", "public"),
    ("/v1/market/products/{id}", "get", "Store context", "Read a product's selling rule", "public"),
    ("/v1/theme/{channel}", "get", "Storefront presentation", "Resolve a published storefront theme", "public"),
    ("/v1/content/{key}", "get", "Storefront presentation", "Read published storefront content", "public"),
    ("/v1/discovery/config", "get", "Storefront presentation", "Read public discovery settings", "public"),
    ("/v1/analytics/events", "post", "Storefront observations", "Record a browser observation", "public"),
    ("/v1/discovery/attribution", "post", "Storefront observations", "Record discovery attribution", "public"),
)

# Audience decisions, not automatic publication rules. The projection above is
# always an exact operation allowlist; a new route cannot inherit publication.
# Catalog media metadata has a mixed admin/public representation (Media carries
# object_key); only its reviewed image-content route is published here.
PRIVATE_PATH_PREFIXES = (
    "/v1/admin/", "/v1/assistant/", "/v1/assistant-tools/", "/v1/agents/",
    "/v1/cart/proposals", "/v1/cart/shopping/", "/v1/cart/saved-goals",
    "/v1/cart/trust",
)
PRIVATE_PATHS = frozenset({
    # Native account lifecycle uses a secret receipt protocol, not the published integration API.
    "/v1/customer/deletion-policy",
    "/v1/customer/account-deletion",
    "/v1/customer/account-deletion/status",
    "/v1/merchants/{merchant}/asset-library",
    "/v1/merchants/{merchant}/asset-folders",
    "/v1/merchants/{merchant}/asset-folders/{folder}",
    "/v1/merchants/{merchant}/assets/{asset}",
    "/v1/merchants/{merchant}/assets/move",
    "/ready", "/v1/catalog/media/{id}", "/v1/publication/snapshot",
    # App Studio is a separate authenticated merchant surface. Native config
    # delivery uses enrolled app sessions and is not a storefront API either.
    "/v1/mobile/config", "/v1/mobile/merchants",
    "/v1/merchants/{merchant}/assets",
    "/v1/merchants/{merchant}/assets/{asset}/content",
    "/v1/merchants/{merchant}/app-config/draft",
    "/v1/merchants/{merchant}/app-config/validate",
    "/v1/merchants/{merchant}/app-config/publish",
    "/v1/merchants/{merchant}/app-config/versions",
    "/v1/merchants/{merchant}/app-config/rollback",
    "/v1/merchants/{merchant}/app-config/audit",
    "/v1/merchants/{merchant}/app-builds",
    "/v1/merchants/{merchant}/app-builds/{build}",
    "/v1/merchants/{merchant}/app-preview/catalog",
    "/v1/merchants/{merchant}/app-preview/categories",
    "/v1/merchants/{merchant}/app-preview/products/{product}",
    "/v1/merchants/{merchant}/app-preview/instance",
    "/v1/merchants/{merchant}/app-preview/sessions",
    "/v1/merchants/{merchant}/app-preview/sessions/worker",
    "/v1/merchants/{merchant}/app-preview/sessions/{session}",
    "/v1/merchants/{merchant}/app-preview/sessions/{session}/frame",
    "/v1/merchants/{merchant}/app-preview/sessions/{session}/video",
    "/v1/merchants/{merchant}/app-preview/sessions/{session}/input",
    "/v1/merchants/{merchant}/app-devices",
    "/v1/merchants/{merchant}/app-devices/identities",
    "/v1/merchants/{merchant}/app-devices/invitations",
    "/v1/merchants/{merchant}/app-devices/{device}/revoke",
    "/v1/mobile/enroll", "/v1/mobile/session",
    "/v1/mobile/assets/{asset}/content",
    "/v1/mobile/preview/{session}",
    "/v1/mobile/preview/{session}/ack",
    "/v1/mobile/preview/{session}/assets/{asset}",
    # Native order delivery is bound to the first-party app/provider setup.
    "/v1/customer/push-devices/{id}",
})

# Shared business response types are included only when reachable. New component
# dependencies cannot silently publish an admin, agent, or operational schema.
REVIEWED_SCHEMAS = frozenset("""
StorefrontNotification StorefrontNotificationCursor StorefrontNotificationPage
StorefrontNotificationReadInput StorefrontNotificationReadResult
StorefrontNotificationReadAllInput StorefrontNotificationReadAllResult
NotificationProductViewInput NotificationProductViewResult
AppliedDiscount Auth BestsellerPeriod BestsellerResults Cart CartAdd CartItem
CartQuantity CatalogImage CatalogImageVariant CatalogOffer Category
CategoryAvailability ChallengeRequest CheckoutMarket CheckoutQuote CheckoutSnapshot
CouponInput Credentials CurrentMarket Customer CustomerProfile DeliverySlot
DeliveryStatus Dispatch Error FulfillmentLocation FulfillmentPlan IdList Location
LocationGeography LocationInput ManualRefund MarketFacts Order OrderContact
OrderDetail OrderHistory OrderItem OrderStatusDisplay OwnReview Payment PlaceInput Product ProductFamily
ProductLink ProductStructure ProfileInput PublicReview PublicStorefrontLanguages
QuoteInput Reset Review ReviewInput ScheduledDelivery ScheduledOrderDelivery
SearchResults SellingRule Shipment ShipmentItem Status StorefrontLanguage TaxAssessment
Verify
AnalyticsEvent AssistantReply AssistantTicket AssistantTicketDetail
AssistantTicketInput AssistantTicketMessage AttributeDefinition AttributeMetadata
BundleSelection CapacityHold CapacitySelection CatalogSchema ContentBlock
DeliveryAreaChoice DeliveryOptions DiscoveryAttributionAccepted DiscoveryAttributionEvidence
DiscoveryAttributionInput DiscoverySettings FulfillmentAvailability
FulfillmentCapabilities FulfillmentOptions FulfillmentRequest FulfillmentSelection
FulfillmentStoreChoice FulfillmentStores FulfillmentWindow MarketConfiguration
InterfaceBundle InterfaceMessage InterfaceOverride
MarketMeasure MarketProduct Navigation NavigationLink OrderExtensions
PublishedContent ResolvedTheme ShopperSchemaAttribute ShopperSchemaCategory ShopperSchemaOption Stock
ThemeConfiguration ThemeSection_announcement ThemeSection_banner
ThemeSection_best_sellers ThemeSection_cart ThemeSection_catalog_filters
ThemeSection_category_grid ThemeSection_category_showcase ThemeSection_editorial_hero
ThemeSection_featured_products ThemeSection_footer ThemeSection_footer_options
ThemeSection_header ThemeSection_header_options ThemeSection_hero ThemeSection_image
ThemeSection_image_text ThemeSection_navigation ThemeSection_presentation
ThemeSection_product_collection ThemeSection_product_detail ThemeSection_product_grid
ThemeSection_recommendations ThemeSection_rich_text
""".split())

EXPECTED_SECURITY = {
    "inbox": [{"customerBearer": []}, {"inboxGuest": []}],
    "inbox_optional": [{"customerBearer": []}, {"inboxGuest": []}, {}],
    "public": [],
    "customer": [{"customerBearer": []}],
    "customer_optional": [{"customerBearer": []}, {}],
    "refresh": [{"customerRefresh": []}],
    "refresh_optional": [{"customerRefresh": []}, {}],
}
SCHEMA_REF = "#/components/schemas/"
STRIP_KEYS = {"example", "examples", "externalDocs", "servers", "callbacks", "links"}
SENSITIVE_FIELDS = {"api_key", "password_hash", "private_key", "client_secret", "object_key", "signing_key"}


def public_copy(node):
    """Omit source examples, extensions, and executable/external documentation links."""
    if isinstance(node, list):
        return [public_copy(value) for value in node]
    if not isinstance(node, dict):
        return node
    result = {}
    for key, value in node.items():
        if key in STRIP_KEYS or key.startswith("x-"):
            continue
        # Property names are data; a legitimate field named "examples" is not
        # an OpenAPI example and must not change the response shape.
        if key == "properties":
            forbidden = SENSITIVE_FIELDS.intersection(value)
            if forbidden:
                raise ValueError(f"Sensitive schema fields need review: {sorted(forbidden)}")
            result[key] = {name: public_copy(schema) for name, schema in value.items()}
        else:
            result[key] = public_copy(value)
    return result


def references(node):
    if isinstance(node, dict):
        if "$ref" in node:
            yield node["$ref"]
        for value in node.values():
            yield from references(value)
    elif isinstance(node, list):
        for value in node:
            yield from references(value)


def operation_id(path, method):
    return method + "_" + path.strip("/").replace("/", "_").replace("{", "").replace("}", "")


def describe_operation(path, method, operation):
    notes = []
    if path.startswith("/v1/notifications"):
        notes.append("The server resolves the recipient from a valid customer bearer or a server-issued HttpOnly inbox_guest cookie. Invalid supplied bearer credentials fail; they never fall back to a guest. GET /v1/notifications initializes the guest cookie. Read mutations require an existing session. Guest history stays in that browser and does not merge on sign-in. Responses are private and no-store.")
    if path.startswith("/v1/customer/") and "/auth/" not in path:
        notes.append("Uses the signed-in customer's scope. Identifiers never grant access to another customer's data.")
    if method not in {"get", "head"}:
        notes.append("Requires X-Commerce-Request: 1. Browser Origin, when supplied, must be allowed by the storefront deployment. This marker is not an authentication credential.")
    if path.startswith("/v1/cart"):
        # cart::customer authenticates Authorization when present, otherwise
        # the domain cart service resolves the opaque guest_cart cookie.
        operation["security"] = [{"customerBearer": []}, {"guestCart": []}]
        notes.append("Signed-in carts use a customer bearer token; guest carts use the HttpOnly guest_cart cookie. If Authorization is supplied, it must be valid. Never send a customer or cart owner ID to select another cart.")
        if path == "/v1/cart":
            operation["security"].append({})
            notes.append("A visitor without credentials can open a new guest cart. The response sets the guest_cart cookie; retain it for subsequent cart requests.")
        if "{id}" in path:
            notes.append("The id path parameter is the product UUID.")
    if path == "/v1/customer/auth/login":
        notes.append("Returns a customer access token and sets an HttpOnly customer_refresh cookie. This is storefront customer sign-in, not a merchant API key or machine-to-machine credential flow.")
    if path == "/v1/customer/auth/refresh":
        notes.append("Uses the HttpOnly customer_refresh cookie and rotates it on success. Without a cookie, returns 204 with no response body and no credentials.")
    if path == "/v1/customer/auth/logout":
        # identity::logout accepts either credential optionally, including a
        # signed-out visitor, and clears the browser refresh cookie.
        operation["security"] = [{"customerRefresh": []}, {"customerBearer": []}, {}]
        notes.append("Revokes the supplied customer refresh session and/or bearer token, then clears the refresh cookie. Signed-out requests are accepted.")
    if path in {"/v1/customer/checkout-eligibility", "/v1/customer/checkout/quote", "/v1/customer/checkout/place"} or (path == "/v1/customer/products/{id}/review" and method == "put"):
        notes.append("Requires a verified customer account in addition to a valid bearer token.")
    if path == "/v1/customer/checkout/quote":
        notes.append("Uses current cart, pricing, inventory and fulfillment facts. Store configuration may require a saved delivery location or a fulfillment selection before quoting.")
    if path == "/v1/customer/checkout/place":
        notes.append("Use the quote UUID and a client-generated idempotency_key UUID. Retain the same key when retrying the same placement. The server revalidates quote expiry and current checkout facts.")
    if path == "/v1/delivery-area":
        notes.append("Delivery coverage depends on the store's configuration and the supplied delivery context.")
    if path in {
        "/v1/catalog/products/{id}", "/v1/catalog/products/{id}/family", "/v1/catalog/bestsellers", "/v1/search",
        "/v1/inventory/{id}", "/v1/delivery-area", "/v1/fulfillment/capabilities",
        "/v1/theme/{channel}", "/v1/analytics/events",
    }:
        operation["security"] = [{"customerBearer": []}, {}]
        notes.append("Anonymous requests are supported. When Authorization is supplied, it must contain a valid customer bearer token; omitting it does not select another customer's context.")
    if path == "/v1/inventory/{id}":
        notes.append("Returns availability for an active product and the current delivery context. Availability is a snapshot, not a reservation; cart and checkout revalidate stock.")
    if path == "/v1/catalog/attribute-definitions":
        notes.append("Returns active product attributes visible on the storefront or used for product configuration. Locale, when supplied, selects reviewed translations.")
    if path == "/v1/cart/items/{id}/measure":
        notes.append("Send quantity as a decimal string in the product's sellable unit. Follow its selling rule; binary floating-point values must not be used for exact quantities.")
    if path.startswith("/v1/fulfillment/") and path not in {"/v1/fulfillment/capabilities", "/v1/fulfillment/stores"}:
        notes.append("Requires a verified customer account in addition to a valid bearer token. The server resolves that customer's cart and checks ownership of delivery locations, plans and reservations.")
    if path == "/v1/fulfillment/capabilities":
        notes.append("Resolves the customer's selected fulfillment store when signed in, otherwise the installation's default store. Returned flags describe enabled behavior; they do not grant permissions.")
    if path == "/v1/fulfillment/store":
        notes.append("Changing the store releases held plans, delivery capacity and inventory reservations for the customer's cart. Recalculate fulfillment options before checkout.")
    if path in {"/v1/fulfillment/plans", "/v1/fulfillment/reservations"}:
        notes.append("Use a client-generated idempotency_key UUID and retain it when retrying the same selection. A hold expires and is not an order. A 409 response means availability changed; recalculate options before selecting again.")
    if path.startswith("/v1/support/") or path.startswith("/v1/customer/support/"):
        notes.append("Support must be enabled for the installation. Ticket and message identifiers never bypass the installation and owner checks.")
    if path == "/v1/support/session":
        notes.append("Sets or renews an HttpOnly support_guest cookie. Retain it before a guest creates a support ticket; its value is not returned in the JSON body.")
    if path == "/v1/support/tickets":
        operation["security"] = [{"customerBearer": []}, {"supportGuest": []}]
        notes.append("Signed-in customers use their bearer token. Guests must initialize a support session and provide contact_name plus an email or mobile contact. If Authorization is supplied, it must be valid. Only a signed-in customer can attach an order_id, and the order must belong to that customer. Reuse request_id only with an unchanged ticket request.")
    if path == "/v1/customer/support/tickets/{id}/messages":
        notes.append("Send request_id and body. Omit status: changing ticket status is an administrative action and a customer request containing it is rejected. Reuse request_id only with an unchanged reply.")
    if path == "/v1/content/{key}":
        notes.append("Returns only published content, or JSON null when the key has no published content. Locale selects reviewed content translations.")
        response_schema = operation["responses"]["200"]["content"]["application/json"]["schema"]
        if "$ref" in response_schema:
            operation["responses"]["200"]["content"]["application/json"]["schema"] = {"allOf": [response_schema], "nullable": True}
    if path == "/v1/theme/{channel}":
        notes.append("Returns the published theme or default configuration. Customer and delivery context can affect targeting. Respect Cache-Control and ETag; never share personalized responses across customers.")
    if path == "/v1/languages/interface":
        notes.append("Contains storefront interface text and only overrides matching the current source text. No administrative edit history or credentials are returned.")
    if path == "/v1/analytics/events":
        notes.append("Browser observations do not create carts, place orders or prove purchases. Use permitted storefront paths without query strings or fragments. Never send passwords, tokens or sensitive personal data in path or query values.")
    if path == "/v1/discovery/attribution":
        operation["security"] = [{"customerBearer": []}, {}]
        notes.append("Requires Origin to exactly match the installation's approved storefront origin. Anonymous observations are supported, but attaching order_id requires a verified customer token and ownership of that order. Referrer and campaign evidence are observations, not trusted identity; do not send credentials or sensitive personal data.")
        if not any(p.get("in") == "header" and p.get("name", "").lower() == "origin" for p in operation.get("parameters", [])):
            operation.setdefault("parameters", []).append({"name": "Origin", "in": "header", "required": True, "schema": {"type": "string"}, "description": "The exact approved storefront HTTPS origin, without a trailing slash."})
    if notes:
        operation["description"] = "\n\n".join(filter(None, [operation.get("description"), *notes]))


def build_public_contract(source):
    if source.get("openapi") != "3.0.3":
        raise ValueError("Review the public projection before changing the OpenAPI version")
    if source.get("security"):
        raise ValueError("Global authentication changed; review the public projection")
    paths = {}
    for path, method, tag, summary, security in OPERATIONS:
        if path in PRIVATE_PATHS or path.startswith(PRIVATE_PATH_PREFIXES):
            raise ValueError(f"Private API cannot be published: {method.upper()} {path}")
        if method in paths.get(path, {}):
            raise ValueError(f"Duplicate public operation: {method.upper()} {path}")
        try:
            original = source["paths"][path][method]
        except KeyError as error:
            raise ValueError(f"Missing reviewed operation: {method.upper()} {path}") from error
        if original.get("operationId") != operation_id(path, method):
            raise ValueError(f"Operation identity changed: {method.upper()} {path}")
        if original.get("security", []) != EXPECTED_SECURITY[security]:
            raise ValueError(f"Authentication changed: {method.upper()} {path}")
        operation = public_copy(original)
        operation.update(summary=summary, tags=[tag])
        operation.setdefault("security", [])
        describe_operation(path, method, operation)
        parameter_names = {p.get("name") for p in operation.get("parameters", []) if p.get("in") == "path" and p.get("required") is True}
        if set(re.findall(r"\{([^}]+)\}", path)) != parameter_names:
            raise ValueError(f"Path parameters changed: {path}")
        if method not in {"get", "head"} and not any(p.get("name", "").lower() == "x-commerce-request" and p.get("required") is True for p in operation.get("parameters", [])):
            raise ValueError(f"Mutation request marker missing: {method.upper()} {path}")
        paths.setdefault(path, {})[method] = operation

    schemas = {}
    pending = list(references(paths))
    while pending:
        reference = pending.pop()
        if not reference.startswith(SCHEMA_REF):
            raise ValueError(f"Only local reviewed schema references may be published: {reference}")
        name = reference[len(SCHEMA_REF):]
        if name not in REVIEWED_SCHEMAS:
            raise ValueError(f"Schema dependency needs publication review: {name}")
        if name in schemas:
            continue
        try:
            schema = public_copy(source["components"]["schemas"][name])
        except KeyError as error:
            raise ValueError(f"Unresolved schema reference: {name}") from error
        schemas[name] = schema
        pending.extend(references(schema))

    schemes = {}
    for name, expected in {
        "customerBearer": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"},
        "customerRefresh": {"type": "apiKey", "in": "cookie", "name": "customer_refresh"},
        "inboxGuest": {"type": "apiKey", "in": "cookie", "name": "inbox_guest"},
    }.items():
        if source["components"]["securitySchemes"].get(name) != expected:
            raise ValueError(f"Security scheme changed: {name}")
        schemes[name] = copy.deepcopy(expected)
    schemes["customerBearer"]["description"] = "Customer access token issued by this storefront's sign-in flow. No public merchant API keys are currently documented."
    schemes["customerRefresh"]["description"] = "HttpOnly storefront refresh cookie managed by the browser. It is not a token to paste into documentation."
    schemes["inboxGuest"]["description"] = "Opaque HttpOnly inbox cookie issued by GET /v1/notifications. It persists read history for public guest announcements in the issuing installation; it never grants access to personal customer messages."
    schemes["guestCart"] = {"type": "apiKey", "in": "cookie", "name": "guest_cart", "description": "Opaque HttpOnly guest cart cookie issued by POST /v1/cart. Treat it as a credential; never share it."}
    schemes["supportGuest"] = {"type": "apiKey", "in": "cookie", "name": "support_guest", "description": "HttpOnly guest support cookie issued by POST /v1/support/session. It is separate from the guest cart cookie; retain it only for the issuing installation."}
    tags = list(dict.fromkeys(row[2] for row in OPERATIONS))
    return {
        "openapi": "3.0.3",
        "info": {
            "title": "Rocento Storefront and Customer API",
            "version": source["info"]["version"],
            "description": "Preview reference for selected implemented storefront and customer application endpoints. This is not a released, stable public integration API or a promise of third-party access. No public merchant API-key or machine-to-machine credential flow is offered here. Confirm access and compatibility with Rocento before integrating. Use the HTTPS origin of your provisioned storefront; rocento.com hosts documentation. Admin, internal assistant, agent and operational routes are intentionally outside this reference. The reference does not execute requests or collect credentials.",
        },
        "servers": [{"url": "https://{storefrontHost}/api", "description": "Your provisioned storefront origin; this placeholder is not a live API server.", "variables": {"storefrontHost": {"default": "storefront.example.com", "description": "Hostname supplied for your storefront deployment. Confirm access with Rocento."}}}],
        "tags": [{"name": tag} for tag in tags],
        "paths": paths,
        "components": {"schemas": dict(sorted(schemas.items())), "securitySchemes": schemes},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--check", action="store_true", help="Fail if the committed public contract is missing or stale")
    args = parser.parse_args()
    try:
        contract = build_public_contract(json.loads(args.source.read_text()))
    except (ValueError, KeyError) as error:
        parser.exit(1, f"Public OpenAPI generation refused: {error}\n")
    rendered = json.dumps(contract, indent=2, ensure_ascii=False) + "\n"
    if args.check:
        if not args.output.exists() or args.output.read_text() != rendered:
            parser.exit(1, "Public OpenAPI is stale. Run python3 scripts/generate_public_openapi.py\n")
        print("Public OpenAPI is current.")
        return
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered)
    print(f"Published {len(OPERATIONS)} reviewed operations across {len(contract['paths'])} paths to {args.output}")


if __name__ == "__main__":
    main()
