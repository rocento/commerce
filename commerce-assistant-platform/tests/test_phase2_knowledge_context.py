"""Use real Node interpretations, then verify exact Python source and catalog admission."""

import json
import subprocess
from copy import deepcopy
from pathlib import Path

import pytest
from test_catalog_schema import catalog_schema, schema_attribute
from test_discovery_workflow import resolved

from app.commerce_action_engine.actions.catalog import CatalogSchema
from app.commerce_action_engine.actions.catalog.workflow import map_discovery_request
from app.commerce_action_engine.actions.shopping import context as context_module
from app.commerce_action_engine.actions.shopping.context import (
    ShoppingContextError,
    ground_context,
    verified_context,
)
from app.commerce_action_engine.actions.shopping.contracts import ShoppingIntent


@pytest.fixture
def fixtures(tmp_path, monkeypatch):
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    data = json.loads(
        subprocess.check_output(
            ["node", str(engine / "scripts/phase2-admission-fixtures.ts")], cwd=engine
        )
    )
    compiled = tmp_path / "compiled.json"
    compiled.write_text(json.dumps({"languageKnowledge": data["pack"]}))
    monkeypatch.setattr(context_module, "_COMPILED_KNOWLEDGE", compiled)
    return data


def plan_for(case):
    assert case["result"]["status"] == "RESOLVED"
    interpretation = resolved(entities=case["result"]["entities"])
    return map_discovery_request(interpretation, case["text"], ShoppingIntent)


def test_real_node_relations_and_ranges_are_admitted_without_losing_constraints(
    fixtures,
):
    for case in fixtures["cases"]:
        plan = plan_for(case)
        assert plan is not None, case["text"]
        assert len(plan.shopping_context.relations) == len(
            case["result"]["entities"]["shoppingContext"]["relations"]
        )
        if "budget is" in case["text"]:
            assert plan.min_price == "180" and plan.max_price == "720"
        if "spending limit" in case["text"]:
            assert plan.max_price == "720"


def test_material_and_multiple_exclusions_need_matching_live_schema(fixtures):
    for case, role, values in [
        (fixtures["cases"][1], "material", ["brass", "nickel"]),
        (fixtures["cases"][2], "color", ["green", "yellow"]),
    ]:
        plan = plan_for(case)
        with pytest.raises(ShoppingContextError):
            ground_context(plan, CatalogSchema(**catalog_schema("jewelry", [])))
        plan = plan_for(case)
        schema = CatalogSchema(
            **catalog_schema(
                "jewelry", [schema_attribute(role, options=values, semantic_role=role)]
            )
        )
        ground_context(plan, schema)
        assert [(c.name, c.value, c.operator) for c in plan.attributes] == [
            (role, v, "neq") for v in values
        ]


def test_forged_polarity_value_marker_and_span_are_rejected(fixtures):
    case = fixtures["cases"][0]
    original = case["result"]["entities"]["shoppingContext"]
    for mutation in [
        lambda r: r.update(negated=False),
        lambda r: r.update(value="yellow"),
        lambda r: r.update(ruleId="material.made_from"),
        lambda r: r.update(start=r["start"] + 1),
    ]:
        forged = deepcopy(original)
        mutation(forged["relations"][-1])
        with pytest.raises(ShoppingContextError):
            verified_context(forged, case["text"])
    forged = deepcopy(original)
    forged["relations"][-1]["text"] = "not without green"
    forged["relations"][-1]["end"] += 4
    with pytest.raises(ShoppingContextError):
        verified_context(forged, case["text"].replace("without", "not without"))


def test_recipient_does_not_supply_gender_age_or_unverified_use(fixtures):
    plan = plan_for(fixtures["cases"][-1])
    ground_context(plan, CatalogSchema(**catalog_schema("electronics", [])))
    assert not plan.attributes and not plan.preferences
