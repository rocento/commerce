"""Exact tenant names outrank name-only descriptors, never outside constraints."""

import asyncio
import json
import subprocess
from pathlib import Path

import pytest
from test_catalog_schema import catalog_schema, schema_attribute
from test_shopping import interpreted, product, scenario

from app.commerce_action_engine.actions.shopping.literal_identity import source_name
from app.commerce_action_engine.execution.language.gate import Resolution

NAMES = [
    "Red Grapes",
    "White Mushrooms",
    "Silver Birch Desk Lamp",
    "Apple iPhone 14 — 128 GB",
    "Sapphire Silver Ring — US Size 6",
    "Estée Lauder Advanced Night Repair Synchronized Multi-Recovery Complex",
]


@pytest.fixture(scope="module")
def wires():
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    script = """
import fs from 'node:fs';import {compile} from './src/compiler.ts';import {resolve} from './src/engine.ts';
import {buildExpandedDictionary} from './src/generation/dictionary.ts';
const engine=compile(buildExpandedDictionary());
console.log(JSON.stringify(JSON.parse(fs.readFileSync(0,'utf8')).map(t=>resolve(engine,t))));
"""
    prompts = ["Show me " + n for n in NAMES] + [
        "Show me a Silver Birch Desk Lamp",
        "Show me Camera Model 12 Pro, not Model 12",
        "Find Red Grapes without seeds under $5",
    ]
    return json.loads(
        subprocess.check_output(
            ["node", "--input-type=module", "-e", script],
            cwd=engine,
            input=json.dumps(prompts).encode(),
        )
    )


@pytest.mark.parametrize("index", range(len(NAMES)))
@pytest.mark.parametrize("meaning", [False, True])
def test_exact_name_preserves_only_matching_identity(index, meaning, wires):
    name = NAMES[index]
    target = product(name=name, attributes=[])
    sibling = product(2, name=name + " Plus", attributes=[])
    schema = catalog_schema(
        "general",
        [
            schema_attribute("color", options=["silver"]),
            schema_attribute("material", options=["silver"]),
        ],
    )
    answer, calls = asyncio.run(
        scenario(
            "Show me " + name,
            {},
            [sibling, target],
            interpretation=interpreted(Resolution.model_validate(wires[index])),
            catalog_schema_override=schema,
            commerce_meaning=meaning,
            commerce_planning=meaning,
        )
    )
    assert target["route"] in answer.text, answer.text
    assert sibling["route"] not in answer.text
    assert len(calls) <= 6
    assert answer.usage.input_tokens == 0


def test_source_restores_unicode_and_separator_without_accepting_ambiguous_occurrence():
    assert source_name("Show me Estée Lauder", "est e lauder") == "Estée Lauder"
    assert source_name("Show me Camera 12 — Pro", "camera 12 pro") == "Camera 12 — Pro"
    assert source_name("Red Grapes and Red Grapes", "red grapes") is None
    assert source_name("Show me unknown", "different product") is None


@pytest.mark.parametrize("meaning", [False, True])
def test_duplicate_exact_names_do_not_select_one_arbitrarily(meaning, wires):
    rows = [
        product(name="Red Grapes", attributes=[]),
        product(2, name="Red Grapes", attributes=[]),
    ]
    answer, _ = asyncio.run(
        scenario(
            "Show me Red Grapes",
            {},
            rows,
            interpretation=interpreted(Resolution.model_validate(wires[0])),
            catalog_schema_override=catalog_schema("grocery", []),
            commerce_meaning=meaning,
        )
    )
    # Ambiguous identity cannot erase the otherwise ungrounded color requirement.
    assert not any(block.products for block in answer.blocks)


@pytest.mark.parametrize("suffix", ["under $5", "without seeds", "with color blue"])
def test_separate_constraints_cannot_be_erased_by_an_exact_name(suffix):
    from test_language_fallback import resolved

    text = "Show me Red Grapes " + suffix
    wire = resolved(
        intent="PRODUCT_SEARCH", entities={"productText": "red grapes", "color": "red"}
    )
    target = product(name="Red Grapes", price="10", attributes=[])
    answer, _ = asyncio.run(
        scenario(
            text,
            {},
            [target],
            interpretation=interpreted(wire),
            catalog_schema_override=catalog_schema("grocery", []),
            commerce_meaning=True,
        )
    )
    assert not any(block.products for block in answer.blocks), answer.text


@pytest.mark.parametrize(
    "weight,unit,expected", [(500, "g", True), (400, "g", False), (500, "kg", False)]
)
def test_pack_suffix_requires_this_products_numeric_fact_and_schema_unit(
    weight, unit, expected
):
    from app.commerce_action_engine.actions.catalog import CatalogSchema, Product
    from app.commerce_action_engine.actions.shopping.literal_identity import (
        matches_name,
    )

    schema = catalog_schema(
        "general", [schema_attribute("weight", "integer", unit=unit)]
    )
    row = product(
        name="Red Grapes 500g", attributes=[{"name": "weight", "value": str(weight)}]
    )
    assert (
        matches_name(
            "Red Grapes",
            Product.model_validate(row),
            CatalogSchema.model_validate(schema),
        )
        is expected
    )


@pytest.mark.parametrize(
    "other", ["Camera Model 12", "Camera Model 12 Pro Max", "Camera Model 12 Plus"]
)
def test_model_suffixes_are_never_pack_size_aliases(other):
    from app.commerce_action_engine.actions.catalog import CatalogSchema, Product
    from app.commerce_action_engine.actions.shopping.literal_identity import (
        matches_name,
    )

    assert not matches_name(
        "Camera Model 12 Pro",
        Product.model_validate(product(name=other)),
        CatalogSchema.model_validate(catalog_schema("general", [])),
    )


@pytest.mark.parametrize("index", [6, 7, 8])
def test_reserved_catalog_prompts_keep_identity_and_unknown_requirements(index, wires):
    prompts = [
        "Show me a Silver Birch Desk Lamp",
        "Show me Camera Model 12 Pro, not Model 12",
        "Find Red Grapes without seeds under $5",
    ]
    names = ["Silver Birch Desk Lamp", "Camera Model 12 Pro", "Red Grapes"]
    name = names[index - 6]
    target = product(name=name, price="3", attributes=[])
    sibling = product(
        2,
        name="Camera Model 12" if index == 7 else name + " Plus",
        price="3",
        attributes=[],
    )
    answer, _ = asyncio.run(
        scenario(
            prompts[index - 6],
            {},
            [sibling, target],
            interpretation=interpreted(Resolution.model_validate(wires[index])),
            catalog_schema_override=catalog_schema("general", []),
            commerce_meaning=True,
        )
    )
    assert sibling["route"] not in answer.text
    if index == 6:
        assert target["route"] in answer.text
    elif index == 8:
        assert not any(block.products for block in answer.blocks)
    assert answer.usage.input_tokens == 0
