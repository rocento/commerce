"""Schema-driven extraction, retrieval and provenance safety without a model provider."""

import asyncio
import json
from uuid import UUID

import httpx
import pytest

from app.commerce_action_engine.actions.catalog import CatalogSchema, Product
from app.commerce_action_engine.actions.shopping import (
    Constraint,
    ShoppingIntent,
    matches_attribute,
    structured_filters,
)
from app.commerce_action_engine.application.catalog import registry
from app.commerce_action_engine.application.shopping import shopping_answer
from app.commerce_action_engine.execution.agents import Principal, default_agents
from app.commerce_resolution_engine.contracts import ModelResponse, Usage


def schema_attribute(code, kind="select", options=(), policy="factual", **overrides):
    return {
        "code": code,
        "label": code.replace("_", " ").title(),
        "data_type": kind,
        "options": [
            {"code": value, "label": value.title(), "labels": {}} for value in options
        ],
        "filterable": True,
        "searchable": True,
        "facetable": True,
        "sortable": False,
        "comparable": True,
        "variant_axis": False,
        "source_policy": policy,
        "unit": None,
        "min": None,
        "max": None,
        **overrides,
    }


def catalog_schema(industry="jewelry", attributes=None):
    return {
        "industry": industry,
        "version": "1:1",
        "attributes": attributes
        if attributes is not None
        else [
            schema_attribute("gemstone_color", options=["red", "blue"]),
            schema_attribute("style", "multiselect", ["luxury", "classic"], "semantic"),
            schema_attribute("metal", options=["gold", "silver"]),
        ],
    }


@pytest.mark.parametrize(
    "code,value",
    [
        ("unknown", "red"),
        ("gemstone_color", "green"),
        ("gemstone_color", '{"$where":"x"}'),
    ],
)
def test_unavailable_codes_and_values_are_rejected(code, value):
    with pytest.raises(ValueError):
        structured_filters(
            [Constraint(name=code, value=value)], CatalogSchema(**catalog_schema())
        )


def test_numeric_boolean_and_localized_options_preserve_types():
    definition = schema_attribute("color", options=["red"])
    definition["options"][0]["labels"] = {"ar": "أحمر"}
    schema = CatalogSchema(
        **catalog_schema(
            attributes=[
                definition,
                schema_attribute(
                    "spf", "integer", policy="trusted_only", min=0, max=100
                ),
                schema_attribute("organic", "boolean"),
            ]
        )
    )
    assert structured_filters(
        [
            Constraint(name="color", value="أحمر"),
            Constraint(name="spf", value="50"),
            Constraint(name="organic", value="true"),
        ],
        schema,
    ) == {"color": "red", "spf": 50, "organic": True}


def test_inferred_values_are_never_authoritative_hard_matches():
    p = Product(
        id=UUID(int=1),
        name="Ring",
        price="100",
        currency="USD",
        category_id=UUID(int=2),
        product_type="simple",
        attributes=[
            {
                "name": "style",
                "value": '"luxury"',
                "source": "AI_INFERRED",
                "confidence": 0.9,
            }
        ],
        in_stock=True,
        route=f"/products/{UUID(int=1)}",
    )
    assert not matches_attribute(p, Constraint(name="style", value="luxury"))
    assert matches_attribute(
        p, Constraint(name="style", value="luxury"), allow_inferred=True
    )


def test_schema_is_discovered_before_extraction_and_filters_precede_candidates():
    async def run():
        requests = []

        class Provider:
            async def generate(self, request):
                assert requests[0]["name"] == "get_catalog_schema"
                assert "gemstone_color" in request.instructions
                return ModelResponse(
                    "",
                    (),
                    ShoppingIntent(
                        shopping=True,
                        query="*",
                        max_price="2000",
                        currency="USD",
                        attributes=[Constraint(name="gemstone_color", value="red")],
                        preferences=[Constraint(name="style", value="luxury")],
                    ),
                    Usage(1, 1, 2),
                    "fixture",
                    "stop",
                )

        def handler(request):
            payload = json.loads(request.content)
            requests.append(payload)
            if payload["name"] == "get_catalog_schema":
                return httpx.Response(
                    200,
                    json={
                        "products": [],
                        "category": None,
                        "catalog_schema": catalog_schema(),
                    },
                )
            assert payload["arguments"]["attributes"] == {"gemstone_color": "red"}
            assert payload["arguments"]["max_price"] == "2000"
            return httpx.Response(200, json={"products": [], "category": None})

        who = Principal(tenant=UUID(int=1), persona="shopper")
        agent = default_agents(who.tenant).load(who.tenant, "shopper")
        async with httpx.AsyncClient(
            base_url="http://test", transport=httpx.MockTransport(handler)
        ) as client:
            tools = {t.definition.name: t for t in registry(client, "token", who, {})}
            answer = await shopping_answer(
                "luxury red jewelry under $2,000", Provider(), agent, who, tools
            )
            assert answer is not None and answer.calls == 2
        assert [r["name"] for r in requests] == [
            "get_catalog_schema",
            "search_products",
        ]

    asyncio.run(run())


def test_different_catalogs_supply_different_schema_without_industry_branches():
    first = CatalogSchema(**catalog_schema())
    second = CatalogSchema(
        **catalog_schema(
            "pharmacy",
            [
                schema_attribute("active_ingredient", "text", policy="trusted_only"),
                schema_attribute("strength", "text", policy="trusted_only"),
            ],
        )
    )
    assert structured_filters(
        [Constraint(name="active_ingredient", value="merchant verified value")], second
    ) == {"active_ingredient": "merchant verified value"}
    with pytest.raises(ValueError):
        structured_filters(
            [Constraint(name="active_ingredient", value="merchant verified value")],
            first,
        )


def test_nested_managed_option_keeps_full_phrase_and_separate_conflict():
    from app.commerce_action_engine.actions.shopping.constraints import (
        preserve_schema_constraints,
    )
    from app.commerce_action_engine.actions.shopping.contracts import Constraint

    schema = CatalogSchema(
        **catalog_schema(
            attributes=[schema_attribute("material", options=["gold", "rose gold"])]
        )
    )
    assert preserve_schema_constraints(
        "Recommend products with material rose gold",
        [Constraint(name="material", value="rose gold")],
        schema,
    ) == [Constraint(name="material", value="rose gold")]
    with pytest.raises(ValueError, match="Conflicting"):
        preserve_schema_constraints("Recommend rose gold and gold", [], schema)
