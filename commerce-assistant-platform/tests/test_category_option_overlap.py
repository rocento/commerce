"""Category inflections must not become ambiguous attribute requirements."""

import asyncio
from uuid import UUID

import pytest
from test_catalog_schema import catalog_schema, schema_attribute
from test_shopping import interpreted, product, scenario

from app.commerce_action_engine.actions.catalog import CatalogSchema
from app.commerce_action_engine.actions.shopping.constraints import (
    preserve_schema_constraints,
)
from app.commerce_action_engine.execution.language.gate import Resolution


def serum_schema():
    schema = catalog_schema(
        "pharmacy",
        [
            schema_attribute(
                "product_kind",
                options=["serum", "cleanser"],
                semantic_role="classification",
            ),
            schema_attribute("texture", options=["serum", "gel"]),
        ],
    )
    schema["categories"] = [
        {
            "id": str(UUID(int=2)),
            "name": "Serums",
            "aliases": ["serums"],
            "parent_id": None,
            "sellable_count": 1,
        }
    ]
    return schema


@pytest.mark.parametrize(
    "intent,verb", [("PRODUCT_SEARCH", "Find"), ("PRODUCT_RECOMMEND", "Recommend")]
)
@pytest.mark.parametrize("meaning", [False, True])
def test_singular_category_search_and_recommendation(intent, verb, meaning):
    answer, calls = asyncio.run(
        scenario(
            f"{verb} serum",
            {},
            [product(name="Clarins Double Serum", category="Serums")],
            catalog_schema_override=serum_schema(),
            commerce_meaning=meaning,
            interpretation=interpreted(
                Resolution(
                    status="RESOLVED",
                    intent=intent,
                    confidence=1.0,
                    message="",
                    entities={"productText": "serum"},
                )
            ),
        )
    )
    assert {p.name for block in answer.blocks for p in block.products or []} == {
        "Clarins Double Serum"
    }
    assert calls[-1]["arguments"]["category_id"] == str(UUID(int=2))


def test_explicit_attribute_value_is_preserved_even_when_it_names_category():
    constraints = preserve_schema_constraints(
        "Find serum with texture: serum", [], CatalogSchema(**serum_schema())
    )
    assert [(c.name, c.value) for c in constraints] == [("texture", "serum")]


def test_ambiguous_value_without_category_still_requires_clarification():
    schema = serum_schema()
    schema["categories"] = []
    with pytest.raises(ValueError, match="Ambiguous option"):
        preserve_schema_constraints("Find serum", [], CatalogSchema(**schema))
