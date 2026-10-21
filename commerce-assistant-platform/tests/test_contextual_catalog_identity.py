"""Typed language context cannot authorize unrelated catalog fallback products."""

import asyncio
import json
import subprocess
from pathlib import Path

import pytest
from test_catalog_schema import catalog_schema, schema_attribute
from test_shopping import interpreted, product, scenario

from app.commerce_action_engine.actions.shopping import context as context_module
from app.commerce_action_engine.execution.language.gate import Resolution


@pytest.fixture
def interpretation(tmp_path, monkeypatch):
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    pack = json.loads(
        (engine / "data/knowledge/shopping-en-phase2-v3.json").read_text()
    )
    compiled = tmp_path / "compiled.json"
    compiled.write_text(json.dumps({"languageKnowledge": pack}))
    monkeypatch.setattr(context_module, "_COMPILED_KNOWLEDGE", compiled)
    script = """
import {readFileSync} from 'node:fs';
import {compile} from './src/compiler.ts';
import {resolve} from './src/engine.ts';
import {recognitionSeed} from './src/recognition-seed.ts';
const engine=compile({...JSON.parse(readFileSync('data/compiled.json')),recognitionRules:recognitionSeed(),languageKnowledge:JSON.parse(readFileSync('data/knowledge/shopping-en-phase2-v3.json'))});
console.log(JSON.stringify(resolve(engine,'Find supplies for hand sewing')));
"""
    return Resolution.model_validate_json(
        subprocess.check_output(
            ["node", "--input-type=module", "-e", script],
            cwd=engine,
        )
    )


def run(interpretation, products, schema=None):
    return asyncio.run(
        scenario(
            "Find supplies for hand sewing",
            {},
            products,
            interpretation=interpreted(interpretation),
            catalog_schema_override=schema or catalog_schema("grocery", []),
            commerce_meaning=True,
            commerce_planning=True,
        )
    )


def test_unrelated_fallback_products_cannot_be_presented_as_typed_use_matches(
    interpretation,
):
    bread = product(name="Sourdough Bread", category="Bakery", price="5.50")
    answer, calls = run(interpretation, [bread])
    assert calls and calls[-1]["name"] == "search_products"
    assert bread["route"] not in answer.text
    assert not any(block.products for block in answer.blocks)
    assert "cannot verify a suitable recommendation" in answer.text
    assert "change the budget or product requirements" in answer.text
    assert answer.usage.input_tokens == 0


@pytest.mark.parametrize("identity", ["name", "category", "sku"])
def test_live_catalog_identity_preserves_real_matches_without_inventing_suitability(
    interpretation, identity
):
    values = {"name": "Sewing kit", "category": "Sewing", "price": "12.50"}
    values[{"name": "name", "category": "category", "sku": "sku"}[identity]] = (
        "Supplies"
    )
    matching = product(**values)
    answer, _ = run(interpretation, [matching])
    assert matching["route"] in answer.text
    assert "Suitability for your intended use is only verified" in answer.text


def test_live_classification_filter_can_ground_target_without_name_match(
    interpretation,
):
    schema = catalog_schema(
        "general",
        [
            schema_attribute(
                "product_kind", options=["supplies"], semantic_role="classification"
            ),
        ],
    )
    matching = product(
        name="Needle and Thread Kit",
        category="Sewing",
        attributes=[
            {"name": "product_kind", "value": '"supplies"'},
        ],
    )
    unrelated = product(2, name="Bread", category="Bakery", attributes=[])
    answer, calls = run(interpretation, [unrelated, matching], schema)
    assert matching["route"] in answer.text and unrelated["route"] not in answer.text
    assert calls[-1]["arguments"]["attributes"] == {"product_kind": "supplies"}
