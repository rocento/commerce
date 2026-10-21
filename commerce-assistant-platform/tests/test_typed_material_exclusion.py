"""A recognized exclusion is mandatory and needs authoritative catalog evidence."""

import asyncio
import json
import subprocess
from functools import lru_cache
from pathlib import Path

import httpx
import pytest
from test_catalog_schema import catalog_schema, schema_attribute
from test_shopping import TENANT, WHO, Provider, interpreted, product

from app.commerce_action_engine.actions.catalog import CatalogSchema, Product
from app.commerce_action_engine.actions.shopping import context as context_module
from app.commerce_action_engine.actions.shopping import matches_attribute
from app.commerce_action_engine.actions.shopping.context import (
    ShoppingContextError,
    ground_context,
)
from app.commerce_action_engine.application.catalog import registry
from app.commerce_action_engine.application.interpretation import shopping_plan
from app.commerce_action_engine.application.shopping import shopping_answer
from app.commerce_action_engine.application.shopping_flow import preparation
from app.commerce_action_engine.execution.agents import default_agents
from app.commerce_action_engine.execution.language.gate import Resolution

REVISIONS = json.loads(
    (
        Path(__file__).parent
        / "fixtures/enterprise_contracts/typed-material-exclusions-v2.json"
    ).read_text()
)["cases"]


@lru_cache(maxsize=2)
def candidate_resolution(message):
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    script = """
import {readFileSync} from 'node:fs';
import {compile} from './src/compiler.ts';
import {resolve} from './src/engine.ts';
const engine=compile({...JSON.parse(readFileSync('data/compiled.json')),languageKnowledge:JSON.parse(readFileSync('data/knowledge/shopping-en-release-v10.json'))});
console.log(JSON.stringify(resolve(engine,process.argv[1])));
"""
    return subprocess.check_output(
        ["node", "--input-type=module", "-e", script, message],
        cwd=engine,
        text=True,
    )


@pytest.fixture(params=REVISIONS, ids=lambda row: row["id"])
def exclusion_plan(request, tmp_path, monkeypatch):
    revision = request.param
    message = revision["messages"][0]
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    pack = engine / "data/knowledge/shopping-en-release-v10.json"
    artifact = tmp_path / "compiled.json"
    artifact.write_text(json.dumps({"languageKnowledge": json.loads(pack.read_text())}))
    monkeypatch.setattr(context_module, "_COMPILED_KNOWLEDGE", artifact)
    context_module._read_relationship_rules.cache_clear()
    raw = json.loads(candidate_resolution(message))
    expected = revision["expected"]
    assert raw["status"] == "RESOLVED" and raw["intent"] == "PRODUCT_SEARCH"
    assert raw["entities"]["shoppingContext"]["relations"] == [expected["relation"]]
    plan = shopping_plan(interpreted(Resolution.model_validate(raw)), message)
    assert (
        plan is not None
        and plan.query == expected["productText"]
        and plan.shopping_context is not None
    )
    assert [row.model_dump(mode="json") for row in plan.shopping_context.relations] == [
        expected["relation"]
    ]
    yield plan, expected["relation"]["value"], message, raw
    context_module._read_relationship_rules.cache_clear()


def test_supported_schema_creates_mandatory_exclusion_and_rejects_missing_evidence(
    exclusion_plan,
):
    plan, excluded, *_ = exclusion_plan
    schema = CatalogSchema(
        **catalog_schema(
            "general", [schema_attribute("material", options=[excluded, "cotton"])]
        )
    )
    ground_context(plan, schema)
    assert len(plan.attributes) == 1
    required = plan.attributes[0]
    assert (required.name, required.operator, required.value) == (
        "material",
        "neq",
        excluded,
    )
    assert not plan.preferences
    for material, source, expected in [
        (excluded, "MERCHANT", False),
        ("cotton", "MERCHANT", True),
        (None, "MERCHANT", False),
        ("cotton", "AI_INFERRED", False),
    ]:
        attributes = (
            []
            if material is None
            else [{"name": "material", "value": json.dumps(material), "source": source}]
        )
        candidate = Product.model_validate(
            product(name="Bag", category="Bags", attributes=attributes)
        )
        assert matches_attribute(candidate, required) is expected


@pytest.mark.parametrize("ambiguous", [False, True])
def test_missing_or_ambiguous_catalog_field_requires_clarification(
    exclusion_plan, ambiguous
):
    plan, excluded, *_ = exclusion_plan
    attributes = (
        [
            schema_attribute("material", options=[excluded, "cotton"]),
            schema_attribute("composition", options=[excluded, "cotton"]),
        ]
        if ambiguous
        else []
    )
    schema = CatalogSchema(**catalog_schema("general", attributes))
    with pytest.raises(ShoppingContextError, match="material requirement"):
        ground_context(plan, schema)


@pytest.mark.parametrize("meaning_enabled", [False, True])
@pytest.mark.parametrize("resuming", [False, True])
@pytest.mark.parametrize("has_valid_product", [False, True])
@pytest.mark.parametrize("schema_state", ["supported", "missing", "ambiguous"])
def test_actual_shopping_workflow_keeps_exclusions_before_alternatives(
    exclusion_plan,
    monkeypatch,
    meaning_enabled,
    resuming,
    has_valid_product,
    schema_state,
):
    plan, excluded, original, raw = exclusion_plan
    plan.alternatives = True
    # Exercise an explicitly permissive alternatives plan at the admission
    # boundary. The real Node relation and Python plan stay unchanged; this
    # adversarial flag must never authorize relaxing their material exclusion.
    original_mapper = preparation.shopping_plan

    def with_alternatives(result, message):
        mapped = original_mapper(result, message)
        if mapped is not None:
            mapped.alternatives = True
        return mapped

    monkeypatch.setattr(preparation, "shopping_plan", with_alternatives)
    attributes = (
        []
        if schema_state == "missing"
        else [schema_attribute("material", options=[excluded, "cotton"])]
    )
    if schema_state == "ambiguous":
        attributes.append(schema_attribute("composition", options=[excluded, "cotton"]))
    schema = catalog_schema("general", attributes)
    values = [
        ("Excluded", excluded, "MERCHANT"),
        ("Unknown", None, "MERCHANT"),
        ("Inferred", "cotton", "AI_INFERRED"),
    ]
    if has_valid_product:
        values.append(("Allowed", "cotton", "MERCHANT"))
    products = [
        product(
            index,
            name=name + " " + plan.query,
            category=plan.query,
            attributes=[]
            if material is None
            else [
                {"name": "material", "value": json.dumps(material), "source": source}
            ],
        )
        for index, (name, material, source) in enumerate(values, 1)
    ]
    calls = []

    def commerce(request):
        body = json.loads(request.content)
        calls.append(body)
        if body["name"] == "get_catalog_schema":
            return httpx.Response(
                200, json={"products": [], "category": None, "catalog_schema": schema}
            )
        assert body["name"] == "search_products"
        assert body["arguments"]["predicates"] == [
            {"name": "material", "operator": "neq", "value": excluded}
        ]
        return httpx.Response(200, json={"products": products, "category": None})

    async def run():
        provider = Provider({})
        agent = default_agents(TENANT).load(TENANT, "shopper")
        async with httpx.AsyncClient(
            base_url="http://fixture", transport=httpx.MockTransport(commerce)
        ) as client:
            answer = await shopping_answer(
                "show alternatives" if resuming else original + "; show alternatives",
                provider,
                agent,
                WHO,
                {
                    tool.definition.name: tool
                    for tool in registry(client, "catalog-token", WHO, {})
                },
                commerce_meaning=meaning_enabled,
                commerce_planning=True,
                interpretation=None
                if resuming
                else interpreted(Resolution.model_validate(raw)),
                shopping_resume=plan if resuming else None,
                shopping_resume_revision=schema["version"] if resuming else None,
            )
        assert not provider.requests
        return answer

    answer = asyncio.run(run())
    assert answer is not None
    routes = [
        p.route
        for block in answer.blocks
        for p in (getattr(block, "products", None) or [])
    ]
    expected = (
        [products[-1]["route"]]
        if has_valid_product and schema_state == "supported"
        else []
    )
    assert routes == expected
    assert answer.usage.input_tokens == 0
    searches = [row for row in calls if row["name"] == "search_products"]
    if schema_state == "supported":
        assert searches and answer.shopping_frame is not None
        assert answer.shopping_frame.alternatives is True
    else:
        assert not searches and "material requirement" in answer.text
