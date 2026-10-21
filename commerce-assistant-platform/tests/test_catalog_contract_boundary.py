"""Catalog values load independently while existing consumers share their types."""

import importlib
import subprocess
import sys

import pytest
from pydantic import BaseModel, TypeAdapter

CATALOG = "app.commerce_action_engine.actions.catalog"
CONTRACT_NAMES = (
    "DTO",
    "Identifier",
    "Money",
    "ProductArgs",
    "CategoryArgs",
    "CompareArgs",
    "SchemaArgs",
    "SearchAttribute",
    "SearchPredicate",
    "SearchFields",
    "SearchArgs",
    "SearchToolArgs",
    "Attribute",
    "Product",
    "Category",
    "SchemaOption",
    "SchemaAttribute",
    "CatalogSchema",
    "SchemaCategory",
    "CatalogFacetValue",
    "CatalogFacet",
    "CatalogPriceRange",
    "CatalogProfile",
    "CatalogResult",
)


@pytest.mark.parametrize(
    "statement",
    [
        f"from {CATALOG} import " + ", ".join(CONTRACT_NAMES),
        f"from {CATALOG}.contracts import " + ", ".join(CONTRACT_NAMES),
        *(
            f"import {CATALOG}.{name}"
            for name in (
                "discovery",
                "bestsellers",
                "discounts",
                "comparison",
                "product_facts",
                "bindings",
            )
        ),
    ],
)
def test_catalog_data_and_read_domains_do_not_load_transport_or_runtime(statement):
    script = """
import importlib.abc
import sys

blocked = (
    'httpx', 'fastapi', 'starlette', 'psycopg', 'openai', 'anthropic',
    'app.commerce_resolution_engine', 'app.commerce_orchestration_engine',
    'app.commerce_action_engine.application', 'app.commerce_action_engine.platform',
    'app.commerce_action_engine.adapters', 'app.commerce_action_engine.execution',
    'app.commerce_action_engine.actions.registry',
    'app.commerce_action_engine.actions.catalog.tools',
)

class RejectInfrastructure(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        assert not any(fullname == p or fullname.startswith(p + '.') for p in blocked), fullname

sys.meta_path.insert(0, RejectInfrastructure())
"""
    # Each import runs in a fresh interpreter, so warmed module caches cannot hide coupling.
    subprocess.run([sys.executable, "-c", script + "\n" + statement], check=True)


@pytest.mark.parametrize("name", CONTRACT_NAMES)
def test_public_and_legacy_tool_exports_share_canonical_types(name):
    contracts = importlib.import_module(CATALOG + ".contracts")
    public = importlib.import_module(CATALOG)
    tools = importlib.import_module(CATALOG + ".tools")
    value = getattr(contracts, name)
    assert getattr(public, name) is value
    assert getattr(tools, name) is value
    if isinstance(value, type) and issubclass(value, BaseModel):
        assert value.__module__ == CATALOG + ".contracts"


def test_registry_and_public_exports_work_regardless_of_import_order():
    for first in (CATALOG + ".tools", CATALOG + ".contracts", CATALOG):
        subprocess.run(
            [
                sys.executable,
                "-c",
                f"""
import importlib
importlib.import_module({first!r})
from {CATALOG} import contracts, tools, DEFINITIONS, SHOPPER_TOOLS
assert DEFINITIONS is tools.DEFINITIONS
assert SHOPPER_TOOLS is tools.SHOPPER_TOOLS
from app.commerce_action_engine.application.catalog import registry
assert callable(registry)
assert not hasattr(tools, "registry")
for definition in DEFINITIONS:
    assert definition.arguments is getattr(contracts, definition.arguments.__name__)
""",
            ],
            check=True,
        )


@pytest.mark.parametrize(
    "name", ["ActionRegistry", "ActionRegistryError", "default_registry"]
)
def test_action_registry_lazy_exports_preserve_identity(name):
    actions = importlib.import_module("app.commerce_action_engine.actions")
    registry = importlib.import_module("app.commerce_action_engine.actions.registry")
    assert getattr(actions, name) is getattr(registry, name)


def test_model_and_facade_search_arguments_keep_distinct_shapes_and_types():
    from app.commerce_action_engine.actions.catalog import SearchArgs, SearchToolArgs

    filters = {"brand": "Acme", "organic": False, "count": 2, "weight": 1.5}
    facade = SearchArgs(query="fruit", attributes=filters)
    model = SearchToolArgs(
        query="fruit", attributes=[{"name": k, "value": v} for k, v in filters.items()]
    )
    assert facade.model_dump(mode="json") == {
        "query": "fruit",
        "category_id": None,
        "min_price": None,
        "max_price": None,
        "attributes": filters,
    }
    assert {a.name: type(a.value) for a in model.attributes} == {
        k: type(v) for k, v in filters.items()
    }
    assert "exclusive_min" not in model.model_dump(mode="json")
    assert (
        SearchToolArgs(query="fruit", exclusive_min=True).model_dump(mode="json")[
            "exclusive_min"
        ]
        is True
    )
    assert (
        TypeAdapter(SearchArgs).json_schema()["properties"]["attributes"]["type"]
        == "object"
    )
    assert (
        TypeAdapter(SearchToolArgs).json_schema()["properties"]["attributes"]["type"]
        == "array"
    )


def test_profile_rejects_impossible_counts_and_preserves_numeric_choices():
    from pydantic import ValidationError

    from app.commerce_action_engine.actions.catalog import CatalogProfile

    facts = {
        "revision": "current-catalog",
        "scope": "current_sellable_category",
        "complete": True,
        "candidate_count": 12,
        "matched_count": 12,
        "facets_complete": True,
        "prices": [],
        "facets": [
            {
                "code": "storage",
                "label": "Storage",
                "data_type": "integer",
                "unit": "GB",
                "covered_count": 12,
                "values_complete": True,
                "values": [{"value": 128, "label": "128", "count": 9}],
            }
        ],
    }
    profile = CatalogProfile.model_validate(facts)
    assert profile.facets[0].values[0].value == 128
    assert isinstance(profile.facets[0].values[0].value, int)
    facts["facets"][0]["values"][0]["count"] = 13
    with pytest.raises(ValidationError):
        CatalogProfile.model_validate(facts)


def test_new_profile_predicates_are_optional_and_closed():
    from pydantic import ValidationError

    from app.commerce_action_engine.actions.catalog import SearchToolArgs

    args = SearchToolArgs(
        query="*",
        in_stock=True,
        exclusive_max=True,
        max_price="500",
        excluded_product_ids=["00000000-0000-0000-0000-000000000001"],
    )
    assert args.model_dump(mode="json")["in_stock"] is True
    with pytest.raises(ValidationError):
        SearchToolArgs(
            query="*",
            excluded_product_ids=["00000000-0000-0000-0000-000000000001"] * 21,
        )
