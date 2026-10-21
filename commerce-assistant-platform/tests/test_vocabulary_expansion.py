"""Real expanded Node vocabulary must retain Python admission and evidence checks."""

import json
import subprocess
from copy import deepcopy
from pathlib import Path

import pytest
from test_catalog_schema import catalog_schema, schema_attribute
from test_shopping import interpreted

from app.commerce_action_engine.actions.catalog import CatalogSchema
from app.commerce_action_engine.actions.catalog.workflow import map_discovery_request
from app.commerce_action_engine.actions.shopping import context as context_module
from app.commerce_action_engine.actions.shopping.context import (
    ShoppingContextError,
    context_note,
    ground_context,
    verified_context,
)
from app.commerce_action_engine.actions.shopping.contracts import ShoppingIntent
from app.commerce_action_engine.execution.language import gate


@pytest.fixture
def expanded(tmp_path, monkeypatch):
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
const engine=compile({...JSON.parse(readFileSync('data/compiled.json')),languageKnowledge:JSON.parse(readFileSync('data/knowledge/shopping-en-phase2-v3.json'))});
const texts=['Find microphone for my lab partner for recording audiobooks and my budget is $75','Find cloth made of microfibre without green','Find scarf for my stepmum','Find coffee urn under $75','Find a camera for macro photography under $500','Find supplies for hand sewing'];
console.log(JSON.stringify(texts.map(text=>({text,result:resolve(engine,text)}))));
"""
    return json.loads(
        subprocess.check_output(
            ["node", "--input-type=module", "-e", script], cwd=engine
        )
    )


def plan_for(case):
    assert case["result"]["status"] == "RESOLVED"
    plan = map_discovery_request(
        interpreted(gate.Resolution.model_validate(case["result"])),
        case["text"],
        ShoppingIntent,
    )
    assert plan is not None
    return plan


def test_expanded_recipient_and_use_preserve_price_and_require_evidence(expanded):
    plan = plan_for(expanded[0])
    assert plan.max_price == "75"
    assert [(r.relation, r.value) for r in plan.shopping_context.relations] == [
        ("recipient", "lab partner"),
        ("intended_use", "audiobook recording"),
    ]
    # A newly understood use cannot invent a supported merchant attribute.
    ground_context(plan, CatalogSchema(**catalog_schema("electronics", [])))
    assert not plan.attributes and not plan.preferences
    assert "Suitability" in context_note(plan)


def test_new_material_and_exclusion_require_matching_catalog_fields(expanded):
    plan = plan_for(expanded[1])
    with pytest.raises(ShoppingContextError):
        ground_context(plan, CatalogSchema(**catalog_schema("grocery", [])))
    plan = plan_for(expanded[1])
    schema = CatalogSchema(
        **catalog_schema(
            "grocery",
            [
                schema_attribute(
                    "material", options=["microfiber"], semantic_role="material"
                ),
                schema_attribute("color", options=["green"], semantic_role="color"),
            ],
        )
    )
    ground_context(plan, schema)
    assert [(a.name, a.value, a.operator) for a in plan.attributes] == [
        ("material", "microfiber", "eq"),
        ("color", "green", "neq"),
    ]


def test_new_recipient_does_not_infer_demographics_and_forgery_is_rejected(expanded):
    case = expanded[2]
    plan = plan_for(case)
    ground_context(plan, CatalogSchema(**catalog_schema("jewelry", [])))
    assert not plan.attributes and not plan.preferences
    forged = deepcopy(case["result"]["entities"]["shoppingContext"])
    forged["relations"][0]["value"] = "mother"
    with pytest.raises(ShoppingContextError):
        verified_context(forged, case["text"])


def test_exact_product_annotation_crosses_wire_without_changing_requested_text(
    expanded,
):
    case = expanded[3]
    resolution = gate.Resolution.model_validate(case["result"])
    assert resolution.entities["productText"] == "coffee urn"
    assert case["result"]["product_meaning"]["concept_id"] == "product.wn31_03068253"
    assert case["result"]["entities"]["price"] == {
        "operator": "<",
        "value": 75,
        "currency": "USD",
    }


@pytest.mark.parametrize(
    ("index", "use", "budget"),
    [(4, "macro photography", "500"), (5, "hand sewing", None)],
)
def test_canonical_use_is_admitted_as_typed_context_without_inventing_merchant_attributes(
    expanded, index, use, budget
):
    case = expanded[index]
    assert "catalogPurpose" not in case["result"]["entities"]
    plan = plan_for(case)
    assert plan.max_price == budget
    assert [
        (r.relation, r.value, r.negated) for r in plan.shopping_context.relations
    ] == [
        ("intended_use", use, False),
    ]
    ground_context(plan, CatalogSchema(**catalog_schema("electronics", [])))
    assert not plan.attributes and not plan.preferences
    assert "Suitability" in context_note(plan)
