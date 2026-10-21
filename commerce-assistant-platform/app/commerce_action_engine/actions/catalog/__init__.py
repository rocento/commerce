"""Catalog contracts, bounded discovery evidence, caching, and runtime tools.

Data exports load only pure contracts. Runtime tools and workflows stay lazy.
"""

from importlib import import_module
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.commerce_action_engine.actions.catalog.cache import (
        CatalogCache,
        Entry,
    )
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
    from app.commerce_action_engine.actions.catalog.discovery import (
        Contribution,
        Discovery,
        DiscoveryReport,
        Offer,
        Relationship,
        labels,
        no_match,
    )
    from app.commerce_action_engine.actions.catalog.tools import (
        DEFINITIONS,
        SHOPPER_TOOLS,
    )
    from app.commerce_action_engine.actions.catalog.workflow import (
        map_discovery_request,
    )

_MODULES = {
    "DEFINITIONS": "app.commerce_action_engine.actions.catalog.tools",
    "SHOPPER_TOOLS": "app.commerce_action_engine.actions.catalog.tools",
    "CatalogCache": "app.commerce_action_engine.actions.catalog.cache",
    "Entry": "app.commerce_action_engine.actions.catalog.cache",
    "Contribution": "app.commerce_action_engine.actions.catalog.discovery",
    "Discovery": "app.commerce_action_engine.actions.catalog.discovery",
    "DiscoveryReport": "app.commerce_action_engine.actions.catalog.discovery",
    "Offer": "app.commerce_action_engine.actions.catalog.discovery",
    "Relationship": "app.commerce_action_engine.actions.catalog.discovery",
    "labels": "app.commerce_action_engine.actions.catalog.discovery",
    "no_match": "app.commerce_action_engine.actions.catalog.discovery",
    "map_discovery_request": "app.commerce_action_engine.actions.catalog.workflow",
}
_MODULES.update(
    {
        name: "app.commerce_action_engine.actions.catalog.contracts"
        for name in (
            "Attribute",
            "CatalogResult",
            "SchemaCategory",
            "CatalogFacetValue",
            "CatalogFacet",
            "CatalogPriceRange",
            "CatalogProfile",
            "CatalogSchema",
            "Category",
            "CategoryArgs",
            "CompareArgs",
            "DTO",
            "Identifier",
            "Money",
            "Product",
            "ProductArgs",
            "SchemaArgs",
            "SchemaAttribute",
            "SchemaOption",
            "SearchArgs",
            "SearchAttribute",
            "SearchPredicate",
            "SearchFields",
            "SearchToolArgs",
        )
    }
)

__all__ = [
    "DEFINITIONS",
    "DTO",
    "SHOPPER_TOOLS",
    "Attribute",
    "CatalogCache",
    "CatalogFacet",
    "CatalogFacetValue",
    "CatalogPriceRange",
    "CatalogProfile",
    "CatalogResult",
    "CatalogSchema",
    "Category",
    "CategoryArgs",
    "CompareArgs",
    "Contribution",
    "Discovery",
    "DiscoveryReport",
    "Entry",
    "Identifier",
    "Money",
    "Offer",
    "Product",
    "ProductArgs",
    "Relationship",
    "SchemaArgs",
    "SchemaAttribute",
    "SchemaCategory",
    "SchemaOption",
    "SearchArgs",
    "SearchAttribute",
    "SearchFields",
    "SearchPredicate",
    "SearchToolArgs",
    "labels",
    "map_discovery_request",
    "no_match",
]


def __getattr__(name: str) -> Any:
    module = _MODULES.get(name)
    if module is None:
        raise AttributeError(name)
    value = getattr(import_module(module), name)
    globals()[name] = value
    return value
