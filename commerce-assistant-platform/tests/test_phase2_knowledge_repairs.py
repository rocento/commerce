"""Exercise the repaired release through the real Node/Python boundary."""

import asyncio
import json
import subprocess
from copy import deepcopy
from pathlib import Path

import pytest
from test_catalog_schema import catalog_schema
from test_shopping import interpreted, product, scenario

from app.commerce_action_engine.actions.catalog import CatalogSchema
from app.commerce_action_engine.actions.catalog.workflow import map_discovery_request
from app.commerce_action_engine.actions.shopping import context as context_module
from app.commerce_action_engine.actions.shopping.context import (
    ShoppingContextError,
    ground_context,
    verified_context,
)
from app.commerce_action_engine.actions.shopping.contracts import ShoppingIntent
from app.commerce_action_engine.execution.language import gate


@pytest.fixture
def fixtures(tmp_path, monkeypatch):
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    data = json.loads(
        subprocess.check_output(
            ["node", str(engine / "scripts/phase2-repair-admission-fixtures.ts")],
            cwd=engine,
        )
    )
    compiled = tmp_path / "compiled.json"
    compiled.write_text(json.dumps({"languageKnowledge": data["pack"]}))
    monkeypatch.setattr(context_module, "_COMPILED_KNOWLEDGE", compiled)
    return data


def test_owned_collectives_do_not_require_demographic_catalog_fields(fixtures):
    for case in fixtures["cases"][:2]:
        request = interpreted(gate.Resolution.model_validate(case["result"]))
        plan = map_discovery_request(request, case["text"], ShoppingIntent)
        assert plan is not None
        ground_context(plan, CatalogSchema(**catalog_schema("grocery", [])))
        assert not plan.attributes and not plan.preferences
        assert all(r.relation == "recipient" for r in plan.shopping_context.relations)
    general = fixtures["cases"][2]
    plan = map_discovery_request(
        interpreted(gate.Resolution.model_validate(general["result"])),
        general["text"],
        ShoppingIntent,
    )
    assert plan.shopping_context.relations[0].relation == "audience"


def test_possessive_policy_cannot_be_forged_or_inherited_across_explicit_marker(
    fixtures,
):
    for index in [2, 6]:
        case = fixtures["cases"][index]
        forged = deepcopy(case["result"]["entities"]["shoppingContext"])
        row = forged["relations"][-1]
        row["relation"] = "recipient"
        row["ruleId"] = "for.possessive_collective"
        with pytest.raises(ShoppingContextError):
            verified_context(forged, case["text"])
    case = fixtures["cases"][0]
    forged = deepcopy(case["result"]["entities"]["shoppingContext"])
    row = forged["relations"][0]
    row.update(conceptId="person.mother", value="mother", text="for my mother")
    row["end"] = row["start"] + len(row["text"])
    with pytest.raises(ShoppingContextError):
        verified_context(forged, case["text"].replace("family", "mother"))


@pytest.mark.parametrize("index", [3, 4, 5])
def test_clarifications_cannot_search_or_call_the_model_and_keep_specific_guidance(
    fixtures, index
):
    case = fixtures["cases"][index]
    request = interpreted(gate.Resolution.model_validate(case["result"]))
    assert request.status == "NEEDS_CONTEXT"
    assert map_discovery_request(request, case["text"], ShoppingIntent) is None
    answer, calls = asyncio.run(
        scenario(case["text"], {}, [product()], interpretation=request)
    )
    assert not calls and not answer.blocks
    assert answer.model == "commerce-language-engine" and answer.usage.input_tokens == 0
    assert ("recipient" if index == 3 else "compatib") in answer.text.lower()
