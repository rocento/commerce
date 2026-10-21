"""Build the authenticated merchant reference; never publish the internal contract.

Both the public and merchant operation sets are explicit reviewed allowlists.
New routes/methods and schema dependencies fail closed until reviewed here.
"""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_public_openapi as public

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "commerce-api/rocento-api/openapi.json"
OUTPUT = ROOT / "commerce-api/rocento-api/merchant-openapi.json"

# Exact reviewed operations. Assistant execution/configuration, agent tooling,
# telemetry probes, and service/operational routes remain internal.
MERCHANT_OPERATIONS = (
    ('/v1/admin/api-reference/openapi.json', 'get'),
    ('/v1/admin/auth/login', 'post'),
    ('/v1/admin/auth/logout', 'post'),
    ('/v1/admin/me', 'get'),
    ('/v1/admin/users', 'get'),
    ('/v1/admin/users', 'post'),
    ('/v1/admin/users/{id}', 'put'),
    ('/v1/admin/users/{id}', 'delete'),
    ('/v1/admin/roles', 'get'),
    ('/v1/admin/roles', 'post'),
    ('/v1/admin/roles/{id}', 'put'),
    ('/v1/admin/roles/{id}', 'delete'),
    ('/v1/admin/audit', 'get'),
    ('/v1/admin/email-templates', 'get'),
    ('/v1/admin/email-templates/{key}', 'get'),
    ('/v1/admin/email-templates/{key}', 'put'),
    ('/v1/admin/email-templates/{key}/preview', 'post'),
    ('/v1/admin/email-templates/{key}/publish', 'post'),
    ('/v1/admin/email-templates/{key}/history', 'get'),
    ('/v1/admin/email-templates/{key}/restore', 'post'),
    ('/v1/admin/marketing/notifications', 'get'),
    ('/v1/admin/marketing/notifications', 'post'),
    ('/v1/admin/marketing/notifications/metadata', 'get'),
    ('/v1/admin/marketing/notifications/preview', 'post'),
    ('/v1/admin/marketing/notifications/records', 'get'),
    ('/v1/admin/marketing/notifications/publications', 'get'),
    ('/v1/admin/marketing/notifications/publications', 'post'),
    ('/v1/admin/marketing/notifications/campaigns', 'get'),
    ('/v1/admin/marketing/notifications/campaigns', 'post'),
    ('/v1/admin/marketing/notifications/campaigns/{id}', 'get'),
    ('/v1/admin/marketing/notifications/campaigns/{id}', 'put'),
    ('/v1/admin/marketing/notifications/campaigns/{id}/activate', 'post'),
    ('/v1/admin/marketing/notifications/records/{id}/publish', 'post'),
    ('/v1/admin/marketing/notifications/publications/{id}', 'delete'),
    ('/v1/admin/marketing/notifications/publications/{id}/withdraw', 'post'),
    ('/v1/admin/marketing/notifications/{id}', 'get'),
    ('/v1/admin/marketing/notifications/{id}', 'put'),
    ('/v1/admin/marketing/notifications/{id}/generate', 'post'),
    ('/v1/admin/marketing/notifications/{id}/audit', 'get'),
    ('/v1/admin/catalog/products', 'get'),
    ('/v1/admin/catalog/products', 'post'),
    ('/v1/admin/catalog/products/{id}', 'put'),
    ('/v1/admin/catalog/products/{id}', 'delete'),
    ('/v1/admin/catalog/products/{id}', 'get'),
    ('/v1/admin/catalog/categories', 'get'),
    ('/v1/admin/catalog/categories', 'post'),
    ('/v1/admin/catalog/categories/{id}', 'put'),
    ('/v1/admin/catalog/categories/{id}', 'delete'),
    ('/v1/admin/catalog/attributes', 'get'),
    ('/v1/admin/catalog/attributes', 'post'),
    ('/v1/admin/catalog/attributes/{id}', 'put'),
    ('/v1/admin/catalog/attributes/{id}', 'delete'),
    ('/v1/admin/catalog/media', 'get'),
    ('/v1/admin/catalog/media', 'post'),
    ('/v1/admin/catalog/media/{id}', 'put'),
    ('/v1/admin/catalog/media/{id}', 'delete'),
    ('/v1/admin/catalog/media/folders', 'get'),
    ('/v1/admin/catalog/media/folders', 'post'),
    ('/v1/admin/catalog/media/folders/{id}', 'put'),
    ('/v1/admin/catalog/media/folders/{id}', 'delete'),
    ('/v1/admin/catalog/media/library', 'get'),
    ('/v1/admin/catalog/media/move', 'post'),
    ('/v1/admin/inventory', 'get'),
    ('/v1/admin/inventory/{id}', 'get'),
    ('/v1/admin/inventory/{id}', 'put'),
    ('/v1/admin/replenishment', 'get'),
    ('/v1/admin/replenishment/{id}', 'put'),
    ('/v1/admin/replenishment/refresh', 'post'),
    ('/v1/admin/order-statuses', 'get'),
    ('/v1/admin/order-statuses', 'post'),
    ('/v1/admin/order-statuses/{code}', 'put'),
    ('/v1/admin/orders/{id}/status-label', 'get'),
    ('/v1/admin/orders/{id}/status-label', 'post'),
    ('/v1/admin/orders', 'get'),
    ('/v1/admin/orders/sales', 'get'),
    ('/v1/admin/orders/{id}', 'get'),
    ('/v1/admin/orders/{id}/status', 'post'),
    ('/v1/admin/orders/{id}/refund', 'post'),
    ('/v1/admin/orders/{id}/dispatch', 'post'),
    ('/v1/admin/settings/delivery-fee', 'get'),
    ('/v1/admin/settings/delivery-fee', 'put'),
    ('/v1/admin/settings/delivery-fee-choices', 'get'),
    ('/v1/admin/settings/delivery-fee-rules', 'get'),
    ('/v1/admin/settings/delivery-fee-rules', 'put'),
    ('/v1/admin/tax/rules', 'get'),
    ('/v1/admin/tax/rules', 'post'),
    ('/v1/admin/tax/rules/{id}', 'put'),
    ('/v1/admin/promotions', 'get'),
    ('/v1/admin/promotions', 'post'),
    ('/v1/admin/promotions/{id}', 'put'),
    ('/v1/admin/promotions/{id}', 'delete'),
    ('/v1/admin/discovery/config', 'get'),
    ('/v1/admin/discovery/config', 'put'),
    ('/v1/admin/discovery/effective', 'get'),
    ('/v1/admin/discovery/metadata', 'get'),
    ('/v1/admin/discovery/metadata', 'put'),
    ('/v1/admin/discovery/metadata/preview', 'post'),
    ('/v1/admin/catalog/media/{id}/publication', 'post'),
    ('/v1/admin/discovery/crawlers', 'get'),
    ('/v1/admin/discovery/crawlers', 'put'),
    ('/v1/admin/discovery/entity', 'get'),
    ('/v1/admin/discovery/entity', 'put'),
    ('/v1/admin/discovery/feeds', 'get'),
    ('/v1/admin/discovery/feeds/export', 'get'),
    ('/v1/admin/discovery/feeds/reconcile', 'post'),
    ('/v1/admin/discovery/analytics', 'get'),
    ('/v1/admin/discovery/health', 'get'),
    ('/v1/admin/support/tickets', 'get'),
    ('/v1/admin/support/tickets/{id}', 'get'),
    ('/v1/admin/support/tickets/{id}/messages', 'post'),
    ('/v1/admin/content/media', 'get'),
    ('/v1/admin/content', 'get'),
    ('/v1/admin/content', 'post'),
    ('/v1/admin/content/{id}', 'get'),
    ('/v1/admin/content/{id}/releases', 'post'),
    ('/v1/admin/reviews', 'get'),
    ('/v1/admin/reviews/{id}', 'put'),
    ('/v1/admin/operations/products', 'get'),
    ('/v1/admin/operations/product-ids', 'get'),
    ('/v1/admin/operations/bulk', 'post'),
    ('/v1/admin/operations/{kind}/export', 'get'),
    ('/v1/admin/operations/{kind}/import', 'post'),
    ('/v1/admin/filters', 'get'),
    ('/v1/admin/filters', 'post'),
    ('/v1/admin/filters/{id}', 'delete'),
    ('/v1/admin/reports/dashboard', 'get'),
    ('/v1/admin/inventory/sources', 'get'),
    ('/v1/admin/inventory/sources', 'post'),
    ('/v1/admin/inventory/sources/{id}', 'put'),
    ('/v1/admin/inventory/sources/{id}', 'delete'),
    ('/v1/admin/inventory/stocks', 'get'),
    ('/v1/admin/inventory/stocks', 'post'),
    ('/v1/admin/inventory/stocks/{id}', 'put'),
    ('/v1/admin/inventory/stocks/{id}', 'delete'),
    ('/v1/admin/inventory/{id}/sources', 'get'),
    ('/v1/admin/inventory/{id}/sources', 'put'),
    ('/v1/admin/shipments/{id}/status', 'post'),
    ('/v1/admin/attribute-definitions', 'get'),
    ('/v1/admin/attribute-definitions', 'post'),
    ('/v1/admin/attribute-definitions/{id}', 'delete'),
    ('/v1/admin/attribute-sets', 'get'),
    ('/v1/admin/attribute-sets', 'post'),
    ('/v1/admin/attribute-sets/{id}', 'delete'),
    ('/v1/admin/catalog/products/{id}/family', 'get'),
    ('/v1/admin/catalog/products/{id}/family', 'put'),
    ('/v1/admin/catalog/categories/{id}/attributes', 'get'),
    ('/v1/admin/catalog/categories/{id}/attributes', 'put'),
    ('/v1/admin/customers/{id}/profile', 'get'),
    ('/v1/admin/orders/{id}/extensions', 'get'),
    ('/v1/admin/orders/{id}/comments', 'get'),
    ('/v1/admin/orders/{id}/comments', 'post'),
    ('/v1/admin/promotions/{id}/attribute-conditions', 'get'),
    ('/v1/admin/promotions/{id}/attribute-conditions', 'put'),
    ('/v1/admin/inventory/delivery-areas', 'get'),
    ('/v1/admin/inventory/delivery-areas', 'post'),
    ('/v1/admin/inventory/delivery-areas/{id}', 'put'),
    ('/v1/admin/themes', 'get'),
    ('/v1/admin/themes', 'post'),
    ('/v1/admin/themes/contract', 'get'),
    ('/v1/admin/themes/{id}', 'get'),
    ('/v1/admin/themes/{id}', 'put'),
    ('/v1/admin/themes/{id}/preview', 'get'),
    ('/v1/admin/themes/{id}/validate', 'post'),
    ('/v1/admin/themes/{id}/publish', 'post'),
    ('/v1/admin/themes/{id}/versions', 'get'),
    ('/v1/admin/themes/{id}/versions/{version}', 'get'),
    ('/v1/admin/themes/assignments', 'get'),
    ('/v1/admin/themes/target-options/{channel}', 'get'),
    ('/v1/admin/themes/assignments/{channel}', 'put'),
    ('/v1/admin/catalog/relationship-rules', 'get'),
    ('/v1/admin/catalog/relationship-rules', 'post'),
    ('/v1/admin/catalog/relationship-rules/attributes', 'get'),
    ('/v1/admin/catalog/relationship-rules/{id}', 'put'),
    ('/v1/admin/catalog/relationship-rules/{id}', 'delete'),
    ('/v1/admin/customer-segments/count', 'get'),
    ('/v1/admin/customer-segments', 'get'),
    ('/v1/admin/customer-segments', 'post'),
    ('/v1/admin/customer-segments/fields', 'get'),
    ('/v1/admin/customer-segments/{id}', 'get'),
    ('/v1/admin/customer-segments/{id}', 'put'),
    ('/v1/admin/customer-segments/{id}', 'delete'),
    ('/v1/admin/catalog/industry-profiles', 'get'),
    ('/v1/admin/catalog/industry-profiles', 'post'),
    ('/v1/admin/catalog/industry', 'get'),
    ('/v1/admin/catalog/industry', 'put'),
    ('/v1/admin/catalog/industry-profiles/{id}/preview', 'get'),
    ('/v1/admin/catalog/enrichment', 'get'),
    ('/v1/admin/catalog/enrichment', 'post'),
    ('/v1/admin/catalog/products/{id}/attribute-values', 'get'),
    ('/v1/admin/catalog/attribute-relationships', 'get'),
    ('/v1/admin/catalog/attribute-relationships', 'post'),
    ('/v1/admin/catalog/enrichment/{id}', 'put'),
    ('/v1/admin/catalog/products/{id}/enrichment', 'post'),
    ('/v1/admin/customers/{id}/journey', 'get'),
    ('/v1/admin/catalog/discovery', 'get'),
    ('/v1/admin/catalog/discovery', 'put'),
    ('/v1/admin/catalog/discovery/relationships', 'post'),
    ('/v1/admin/catalog/discovery/relationships/{id}', 'delete'),
    ('/v1/admin/catalog/discovery/merchandising', 'put'),
    ('/v1/admin/fulfillment/settings', 'post'),
    ('/v1/admin/fulfillment/configuration', 'get'),
    ('/v1/admin/fulfillment/capacity', 'get'),
    ('/v1/admin/fulfillment/schedules', 'post'),
    ('/v1/admin/fulfillment/capacity-rules', 'post'),
    ('/v1/admin/fulfillment/capabilities', 'get'),
    ('/v1/admin/fulfillment/capabilities', 'post'),
    ('/v1/admin/fulfillment/stores', 'post'),
    ('/v1/admin/fulfillment/store-sources', 'post'),
    ('/v1/admin/market', 'put'),
    ('/v1/admin/market/products/{id}', 'put'),
    ('/v1/admin/markets', 'get'),
    ('/v1/admin/markets', 'post'),
    ('/v1/admin/markets/{market}/{kind}/{id}', 'get'),
    ('/v1/admin/markets/{market}/{kind}/{id}', 'put'),
    ('/v1/admin/markets/{id}/readiness', 'get'),
    ('/v1/admin/markets/{id}/preview', 'get'),
    ('/v1/admin/markets/{id}/publish', 'post'),
    ('/v1/admin/markets/restore-defaults', 'post'),
    ('/v1/admin/languages', 'get'),
    ('/v1/admin/languages', 'post'),
    ('/v1/admin/languages/{locale}/translations', 'get'),
    ('/v1/admin/languages/{locale}/translations/{kind}/{id}', 'get'),
    ('/v1/admin/languages/{locale}/translations/{kind}/{id}', 'put'),
    ('/v1/admin/languages/interface', 'get'),
    ('/v1/admin/languages/interface', 'put'),
    ('/v1/admin/languages/interface/preview', 'post'),
    ('/v1/admin/languages/interface/import', 'put'),
    ('/v1/admin/languages/interface/export', 'get'),
    ('/v1/admin/grids/{name}', 'get'),
    ('/v1/admin/grids/{name}/sorts', 'get'),
    ('/v1/admin/exports', 'get'),
    ('/v1/admin/exports', 'post'),
    ('/v1/admin/exports/columns/{grid}', 'get'),
    ('/v1/admin/exports/{id}', 'get'),
    ('/v1/admin/exports/{id}', 'delete'),
    ('/v1/admin/exports/{id}/download', 'get'),
    ('/v1/catalog/media/{id}', 'get'),
)

# These dependencies were reviewed with the merchant operation set. Media
# object_key is a schema property already returned by admin APIs, never a value.
REVIEWED_SCHEMAS = frozenset("""
RelationshipInput RelationshipRule RelationshipConditions RelationshipCondition RelationshipAttribute
OrderStatusDefinition OrderStatusInput OrderStatusAssignment OrderStatusLabelHistory OrderStatusDisplay
ActiveMarket AdjustStock Admin AdminCredentials AdminCustomerProfile AppliedDiscount
AreaStockLink AssistantReply AssistantTicket AssistantTicketDetail AssistantTicketMessage
Attribute AttributeDefinition AttributeDefinitionInput AttributeInput AttributeMetadata
AttributeRelationship AttributeRelationshipInput AttributeSet AttributeSetInput
AttributeSetMember AttributeValueRecord AttributeValues Audit BatchResult BulkInput
CapacityConfiguration CapacityConstraint CapacityException CapacityOverview CapacityRow
CapacityRule CapacityRuleInput CapacitySettings CapacityWindow CatalogConfiguration
CatalogFilter CatalogImage CatalogImageVariant CatalogOffer CatalogPage CatalogTranslation
CatalogTranslationInput CatalogTranslationPage CatalogTranslationSaved Category
CategoryInput CheckoutMarket CommentInput ContentBlock ContentDetail ContentDocument
ContentInput ContentPublish ContentRelease ContentRevision CsvExport CsvInput Customer
CustomerJourney CustomerJourneyDetails CustomerJourneyEvent CustomerLtv CustomerSegment
CustomerSegmentInput DashboardReport DeliveryArea DeliveryAreaInput DeliveryFee
DeliveryFeeInput DeliveryFeeChoices DeliveryFeeRule DeliveryFeeRuleInput DeliveryFeeRuleSaved
DeliverySlot DiscoveryAnalytics DiscoveryConfiguration
DiscoveryContribution DiscoveryCoverage DiscoveryCoverageCategory DiscoveryEdge
DiscoveryEdgeInput DiscoveryHealth DiscoveryHealthFinding DiscoveryMerchandising
DiscoveryRankObservation DiscoverySettings DiscoverySettingsInput Dispatch DispatchInput
EffectiveIndexingPolicy EnrichmentEvidence EnrichmentInput EnrichmentReview
EnrichmentSuggestion Error ExportAccepted ExportCancelled ExportColumns ExportInput
ExportJob FulfillmentBranchInput FulfillmentCapabilities FulfillmentCapabilityOverrides
FulfillmentLocation FulfillmentPlan FulfillmentSchedule FulfillmentScheduleInput
FulfillmentSettingsView FulfillmentSourceInput FulfillmentStoreInput GridPage GridRequest
GridSorts IdList Identity IndustryApply IndustryPreview IndustryPreviewAttribute
IndustryProfile IndustryProfileInput IndustryTemplateAttribute
IndustryTemplateAttributeInput IndustryTemplateDefinition InterfaceBundle InterfaceChange
InterfaceCsvInput InterfaceEditInput InterfaceImportInput InterfaceImportIssue
InterfaceMessage InterfaceOverride InterfacePreview InterfaceSaved InventoryDetail
InventorySource InventorySourceInput InventorySummary LibraryMedia Location
LocationGeography ManualRefund MarketConfiguration MarketConfigurationInput MarketDraft
MarketDraftInput MarketFacts MarketList MarketOverride MarketOverrideInput MarketPreview
MarketProduct MarketPublishInput MarketReadiness MarketRelease MarketRestoreInput
MarketRevision Media MediaFolder MediaFolderInput MediaInput MediaLibraryPage
MoveMediaInput Navigation NavigationLink Order OrderComment OrderContact OrderDetail OrderSales
OrderExtensions OrderHistory OrderItem OrderReason OrderTransition Payment Product
ProductFamily ProductInput ProductLink ProductPerformance ProductStructure Promotion
PromotionInput PublicationCrawlerInput PublicationCrawlerPreferences
PublicationEntityConfiguration PublicationEntityInput PublicationEntityPage
PublicationEntitySaved PublicationEntityStatus PublicationFeedEvent PublicationFeedExport
PublicationFeedQueued PublicationFeedStatus PublicationImageProcessed
PublicationMetadataConfiguration PublicationMetadataInput PublicationMetadataPreview
PublicationMetadataPreviewInput PublicationMetadataSettings PublicationMetadataText
PublicationResolvedMetadata ReplenishmentPolicyInput ReplenishmentRecommendation
ReplenishmentRefresh ReportFunnel ReportRun Reservation RetentionCohort Review
ReviewModeration Role RoleInput SalesDay SaveCapacityRule SaveFulfillmentCapabilities
SaveFulfillmentSchedule SavedFilter SavedFilterInput ScheduleConfig ScheduledOrderDelivery
SegmentField SegmentRule SellingRule Shipment ShipmentItem SourceItem SourceItemInput
SourceLink Status Stock StockAdjustment StockPool StockPoolInput StockPoolSaved
StorefrontLanguage StorefrontLanguageInput StorefrontLanguageSettings TaxAssessment
TaxRule TaxRuleInput Theme ThemeAssign ThemeAssignment ThemeConfiguration ThemeContract
ThemeCreate ThemePublish ThemeSection_announcement ThemeSection_banner
ThemeSection_best_sellers ThemeSection_cart ThemeSection_catalog_filters
ThemeSection_category_grid ThemeSection_category_showcase ThemeSection_editorial_hero
ThemeSection_featured_products ThemeSection_footer ThemeSection_footer_options
ThemeSection_header ThemeSection_header_options ThemeSection_hero ThemeSection_image
ThemeSection_image_text ThemeSection_navigation ThemeSection_presentation
ThemeSection_product_collection ThemeSection_product_detail ThemeSection_product_grid
ThemeSection_recommendations ThemeSection_rich_text ThemeTargetOptions ThemeTargetRule
ThemeUpdate ThemeValidation ThemeVersion TrafficSource UserInput WarehouseQuantity
MerchantOpenApiDocument
EmailTemplateContent EmailTemplateVariable EmailTemplate EmailTemplateList
EmailTemplateSave EmailTemplatePublish EmailTemplateRestore EmailTemplatePreviewInput
EmailTemplatePreview EmailTemplateVersion EmailTemplateHistory EmailTemplateConflict
NotificationProgramInput NotificationProgramUpdate NotificationProgram NotificationProgramList
NotificationChannelMetadata NotificationTriggerMetadata NotificationTokenMetadata NotificationMetadata
NotificationPreviewInput NotificationPreview NotificationGenerateInput GeneratedNotification
NotificationGenerationResult NotificationRecordList NotificationAuditEvent NotificationAuditList
NotificationConflict
NotificationCondition NotificationConditions NotificationConditionOperator NotificationConditionOption
NotificationConditionField NotificationConditionResult
NotificationPublication NotificationPublicationList NotificationPublicationOptions
NotificationAnnouncementInput NotificationWithdrawInput NotificationDeleteResult
NotificationAudienceRules NotificationCampaignAnnouncement NotificationCampaignInput
NotificationCampaign NotificationCampaignList NotificationCampaignActivateInput
""".split())

ADMIN_SCHEME = {"type": "apiKey", "in": "cookie", "name": "admin_session"}
DOCS_PATH = "/v1/admin/api-reference/openapi.json"
STRIP_KEYS = public.STRIP_KEYS
SENSITIVE_FIELDS = public.SENSITIVE_FIELDS - {"object_key"}


def merchant_copy(node):
    """Keep contract structure, never source examples, defaults or executable links."""
    if isinstance(node, list):
        return [merchant_copy(value) for value in node]
    if not isinstance(node, dict):
        return node
    result = {}
    for key, value in node.items():
        if key in STRIP_KEYS or key.startswith("x-"):
            continue
        # Strip schema defaults, not OpenAPI's default error response.
        if key == "default" and any(k in node for k in ("type", "$ref", "enum", "allOf", "oneOf", "anyOf")):
            continue
        if key == "properties":
            forbidden = SENSITIVE_FIELDS.intersection(value)
            if forbidden:
                raise ValueError(f"Sensitive merchant fields need review: {sorted(forbidden)}")
            result[key] = {name: merchant_copy(schema) for name, schema in value.items()}
            for name in ("password",):
                if name in result[key]:
                    result[key][name]["writeOnly"] = True
        else:
            result[key] = merchant_copy(value)
    return result


def merchant_tag(path):
    if path == "/v1/catalog/media/{id}":
        return "Merchant catalog"
    section = path.removeprefix("/v1/admin/").split("/")[0]
    return {
        "auth": "Merchant identity", "me": "Merchant identity",
        "users": "Merchant identity", "roles": "Merchant identity", "audit": "Merchant identity",
        "catalog": "Merchant catalog", "attribute-definitions": "Merchant catalog",
        "attribute-sets": "Merchant catalog", "operations": "Merchant catalog",
        "exports": "Merchant grids and exports", "grids": "Merchant grids and exports",
        "filters": "Merchant grids and exports", "inventory": "Merchant inventory",
        "replenishment": "Merchant inventory", "orders": "Merchant orders", "order-statuses": "Merchant orders",
        "shipments": "Merchant fulfillment", "fulfillment": "Merchant fulfillment",
        "settings": "Merchant fulfillment", "support": "Merchant support",
        "content": "Merchant content", "themes": "Merchant themes", "reviews": "Merchant reviews",
        "customers": "Merchant customers", "customer-segments": "Merchant customers",
        "promotions": "Merchant promotions", "tax": "Merchant tax", "discovery": "Merchant discovery",
        "reports": "Merchant reporting", "market": "Merchant markets", "markets": "Merchant markets",
        "languages": "Merchant localization", "api-reference": "Merchant documentation",
        "email-templates": "Merchant email templates",
        "marketing": "Merchant marketing",
    }.get(section, "Merchant administration")


def build_merchant_contract(source):
    # Public auth and descriptions are reviewed independently, never duplicated.
    contract = copy.deepcopy(public.build_public_contract(source))
    if source["components"]["securitySchemes"].get("adminSession") != ADMIN_SCHEME:
        raise ValueError("Merchant session security scheme changed")
    paths = contract["paths"]
    schemas = contract["components"]["schemas"]
    for path, method in MERCHANT_OPERATIONS:
        try:
            original = source["paths"][path][method]
        except KeyError as error:
            raise ValueError(f"Missing reviewed merchant operation: {method.upper()} {path}") from error
        expected = [] if path in {"/v1/admin/auth/login", "/v1/catalog/media/{id}"} else [{"adminSession": []}]
        if original.get("security", []) != expected:
            raise ValueError(f"Merchant authentication changed: {method.upper()} {path}")
        if original.get("operationId") != public.operation_id(path, method):
            raise ValueError(f"Merchant operation identity changed: {method.upper()} {path}")
        operation = merchant_copy(original)
        operation["tags"] = [merchant_tag(path)]
        operation.setdefault("summary", f"{method.upper()} {path}")
        operation.setdefault("security", [])
        notes = ["The documentation permission does not authorize execution. Every operation enforces its own merchant role permissions and uses this deployment's database. A caller cannot select a different merchant database."]
        if path == "/v1/admin/auth/login":
            notes = ["Signs in an existing merchant administrator and sets an HttpOnly admin_session cookie. This is not a public integration key or service credential flow."]
        elif path == "/v1/admin/auth/logout":
            operation["security"] = [{"adminSession": []}, {}]
            notes.append("Revokes the supplied merchant session and clears the cookie. An already signed-out request is accepted.")
        elif path == "/v1/catalog/media/{id}":
            operation["security"] = [{"adminSession": []}, {}]
            notes = ["Publicly released image metadata is readable without credentials with object_key cleared. Private media requires an administrator session with catalog.read. Storage keys are metadata, never credentials."]
        if path in {"/v1/admin/settings/delivery-fee-choices", "/v1/admin/settings/delivery-fee-rules"}:
            permission = "fulfillment.settings.read" if method == "get" else "fulfillment.settings.write"
            notes.append(f"Requires {permission} in this installation. Delivery-area and inventory-source choices are merchant configuration data.")
        if method not in {"get", "head"}:
            notes.append("Requires X-Commerce-Request: 1. Browser Origin, when present, must match the deployment's allowed origins. This marker is not an authentication credential.")
            if not any(p.get("name", "").lower() == "x-commerce-request" and p.get("required") is True for p in operation.get("parameters", [])):
                raise ValueError(f"Merchant mutation marker missing: {method.upper()} {path}")
        params = {p.get("name") for p in operation.get("parameters", []) if p.get("in") == "path" and p.get("required") is True}
        if set(re.findall(r"\{([^}]+)\}", path)) != params:
            raise ValueError(f"Merchant path parameters changed: {path}")
        operation["description"] = "\n\n".join(filter(None, [operation.get("description"), *notes]))
        paths.setdefault(path, {})[method] = operation

    pending = list(public.references(paths))
    while pending:
        ref = pending.pop()
        if not ref.startswith(public.SCHEMA_REF):
            raise ValueError(f"Only local reviewed schema references are allowed: {ref}")
        name = ref[len(public.SCHEMA_REF):]
        if name in schemas:
            continue
        if name not in REVIEWED_SCHEMAS:
            raise ValueError(f"Merchant schema dependency needs review: {name}")
        try:
            schema = merchant_copy(source["components"]["schemas"][name])
        except KeyError as error:
            raise ValueError(f"Unresolved merchant schema: {name}") from error
        schemas[name] = schema
        pending.extend(public.references(schema))

    contract["info"] = {
        "title": "Rocento Merchant Application API",
        "version": source["info"]["version"],
        "description": "Authenticated preview of reviewed storefront, customer and merchant application endpoints. Access requires a current merchant administrator session and api.docs.read. Reading this reference grants no API execution privileges and no access to another merchant. Each provisioned merchant deployment uses its own database. Existing per-operation permissions still apply. Internal assistant, agent, infrastructure and service contracts remain private. A stable third-party integration API and self-service credentials are not yet released. This reference cannot execute requests or collect credentials.",
    }
    # Same-origin gateway only: no user-selectable tenant/host and no production
    # hostnames in the contract. Customer operations use the storefront origin
    # of the same provisioned merchant; the viewer never executes either kind.
    contract["servers"] = [{"url": "/api", "description": "Gateway on the provisioned merchant origin. Customer operations use that merchant's storefront origin."}]
    contract["components"]["securitySchemes"]["adminSession"] = {
        **ADMIN_SCHEME,
        "description": "HttpOnly merchant administrator session managed by the browser. Never paste credentials into documentation.",
    }
    contract["components"]["schemas"] = dict(sorted(schemas.items()))
    contract["tags"] = [{"name": tag} for tag in dict.fromkeys(tag for methods in paths.values() for operation in methods.values() for tag in operation.get("tags", []))]
    return contract


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        contract = build_merchant_contract(json.loads(args.source.read_text()))
    except (ValueError, KeyError) as error:
        parser.exit(1, f"Merchant OpenAPI generation refused: {error}\n")
    rendered = json.dumps(contract, indent=2, ensure_ascii=False) + "\n"
    if args.check:
        if not args.output.exists() or args.output.read_text() != rendered:
            parser.exit(1, "Merchant OpenAPI is stale. Run python3 scripts/generate_merchant_openapi.py\n")
        print("Merchant OpenAPI is current.")
        return
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered)
    print(f"Generated {sum(len(methods) for methods in contract['paths'].values())} reviewed operations across {len(contract['paths'])} paths in {args.output}")


if __name__ == "__main__":
    main()
