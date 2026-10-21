"""Canonical shopper tool definitions and contract exports."""

from app.commerce_action_engine.actions.catalog.contracts import (
    DTO,
    Attribute,
    CatalogFacet,
    CatalogFacetValue,
    CatalogPriceRange,
    CatalogProfile,
    CatalogResult,
    CatalogSchema,
    Category,
    CategoryArgs,
    CompareArgs,
    Identifier,
    Money,
    Product,
    ProductArgs,
    SchemaArgs,
    SchemaAttribute,
    SchemaCategory,
    SchemaOption,
    SearchArgs,
    SearchAttribute,
    SearchFields,
    SearchPredicate,
    SearchToolArgs,
)
from app.commerce_resolution_engine.contracts import ToolDefinition

# Existing tool-module imports share the canonical contract classes.
__all__ = [
    "DEFINITIONS",
    "DTO",
    "SHOPPER_TOOLS",
    "Attribute",
    "CatalogFacet",
    "CatalogFacetValue",
    "CatalogPriceRange",
    "CatalogProfile",
    "CatalogResult",
    "CatalogSchema",
    "Category",
    "CategoryArgs",
    "CompareArgs",
    "Identifier",
    "Money",
    "Product",
    "ProductArgs",
    "SchemaArgs",
    "SchemaAttribute",
    "SchemaCategory",
    "SchemaOption",
    "SearchArgs",
    "SearchAttribute",
    "SearchFields",
    "SearchPredicate",
    "SearchToolArgs",
]


DEFINITIONS: tuple[ToolDefinition, ...] = (
    ToolDefinition(
        "get_catalog_schema",
        "Discover current merchant categories, authoritative category aliases, attribute descriptions, stable option codes and controlled filters. Discover before constructing filters. Never infer facts from the industry name.",
        SchemaArgs,
    ),
    ToolDefinition(
        "search_products",
        "Search current products with typed category, attribute, budget, stock and exclusion filters. Display products are a bounded candidate set. When present, catalog_profile provides separate current simple-SKU statistics for the same browse scope; honor its completeness flags. Prices are catalog prices, not checkout quotes.",
        SearchToolArgs,
    ),
    ToolDefinition(
        "get_product",
        "Read a current active product. Null stock means delivery availability is unknown, never in stock.",
        ProductArgs,
    ),
    ToolDefinition(
        "get_product_attributes",
        "Read storefront-visible product attributes. Missing attributes are unknown.",
        ProductArgs,
    ),
    ToolDefinition(
        "get_product_price",
        "Read current catalog price and currency. Does not include customer/cart promotions, tax or delivery fees.",
        ProductArgs,
    ),
    ToolDefinition(
        "get_product_inventory",
        "Read current delivery availability. Null means choose a covered delivery location before making stock claims.",
        ProductArgs,
    ),
    ToolDefinition(
        "get_category", "Read a category by its authoritative identifier.", CategoryArgs
    ),
    ToolDefinition(
        "compare_products",
        "Read two to five products for factual comparison. Never invent missing attributes.",
        CompareArgs,
    ),
)
SHOPPER_TOOLS = frozenset(definition.name for definition in DEFINITIONS)
