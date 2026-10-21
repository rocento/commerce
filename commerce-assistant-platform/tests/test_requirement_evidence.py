"""Independent evidence cases exercise real resolver admission and shopping output."""

import asyncio
import itertools
import json
import subprocess
from pathlib import Path

import pytest
from interpretation_helpers import standard_route
from test_catalog_schema import catalog_schema, schema_attribute
from test_shopping import interpreted, product, scenario

from app.commerce_action_engine.actions.catalog import CatalogSchema, Product
from app.commerce_action_engine.actions.shopping import (
    Constraint,
    ShoppingIntent,
    select,
)
from app.commerce_action_engine.actions.shopping.constraints import structured_filters
from app.commerce_action_engine.actions.shopping.evidence import (
    attribute_evidence,
    requirement_clarification,
)
from app.commerce_action_engine.application.interpretation import shopping_plan
from app.commerce_action_engine.execution.language import gate


@pytest.mark.parametrize(
    "rows,status",
    [
        ([], "unknown"),
        ([("true", "MERCHANT")], "verified"),
        ([("false", "VERIFIED")], "contradicted"),
        ([("true", "AI_INFERRED")], "unknown"),
        ([("true", "DERIVED")], "unknown"),
        ([("false", "MERCHANT"), ("true", "AI_INFERRED")], "contradicted"),
        ([("true", "MERCHANT"), ("false", "VERIFIED")], "unknown"),
        ([("true", "MERCHANT"), ("true", "VERIFIED")], "verified"),
        ([("[]", "VERIFIED")], "unknown"),
        ([("[true, false]", "VERIFIED")], "unknown"),
        ([("null", "MERCHANT"), ("true", "VERIFIED")], "unknown"),
    ],
)
def test_hard_requirements_need_consistent_explicit_evidence(rows, status):
    for ordered in itertools.permutations(rows):
        p = Product(
            **product(
                name="Guaranteed Vegan",
                attributes=[
                    {"name": "vegan", "value": v, "source": s} for v, s in ordered
                ],
            )
        )
        assert attribute_evidence(p, "vegan", "true").status == status
        plan = ShoppingIntent(
            shopping=True,
            query="food",
            attributes=[Constraint(name="vegan", value="true")],
        )
        exact, _ = select([p], plan, None)
        assert bool(exact) is (status == "verified")


def test_real_complex_requests_ask_for_specific_missing_evidence_without_search_or_llm():
    needs = [
        ("safe for a severe peanut allergy", "cross-contact"),
        ("suitable during pregnancy", "clinician"),
        ("compatible with my old device", "exact manufacturer"),
        ("vegan with no hidden animal ingredients", "complete ingredient"),
        ("delivered tomorrow before 9am", "checkout delivery-slot"),
        ("the best value for a family of five", "unit prices"),
        ("compatible with my Nova-47446", "model you named"),
        ("compatible with the Orion X7", "compatibility specification"),
        ("excluding anything made in a factory", "documented production method"),
        ("without factory-made products", "manufacturing processes"),
    ]
    messages = [
        f"I need coffee under $20, {need}. What would you suggest?" for need, _ in needs
    ]
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            "import {loadRuntime} from './src/runtime.ts'; import {resolve} from './src/engine.ts'; const c=await loadRuntime(); console.log(JSON.stringify(JSON.parse(process.argv[1]).map(t=>resolve(c,t))));",
            json.dumps(messages),
        ],
        cwd=engine,
        capture_output=True,
        text=True,
        check=True,
    )
    for message, raw, (_, expected) in zip(
        messages, json.loads(result.stdout), needs, strict=True
    ):
        resolution = gate.Resolution.model_validate(raw)
        if resolution.status == "AMBIGUOUS":
            assert standard_route(resolution) == "clarify"
            continue
        plan = shopping_plan(interpreted(resolution), message)
        assert plan and expected in plan.clarification
        interpretation = interpreted(resolution)
        answer, calls = asyncio.run(
            scenario(message, {}, [product()], interpretation=interpretation)
        )
        assert expected in answer.text
        assert (
            answer.model == "commerce-language-engine"
            and answer.usage.input_tokens == 0
        )
        assert not answer.blocks and (not calls)


def test_untrusted_evidence_spans_and_unknown_kinds_fail_closed():
    message = "safe for a severe peanut allergy"
    row = {"kind": "allergy_safety", "text": message, "start": 0, "end": len(message)}
    assert requirement_clarification([row], message)
    for changed in [
        {"kind": "invented"},
        {"text": "wrong"},
        {"start": -1},
        {"end": True},
    ]:
        assert requirement_clarification([{**row, **changed}], message) is None


def test_no_match_output_is_readable_with_unknown_and_contradicted_facts():
    answer, _ = asyncio.run(
        scenario(
            "find black shoes",
            {"attributes": [{"name": "color", "value": "black"}]},
            [
                product(1, attributes=[]),
                product(2, attributes=[{"name": "color", "value": '"white"'}]),
            ],
        )
    )
    assert (
        "I couldn’t find products matching your request in this store." in answer.text
    )
    assert "0 verified" not in answer.text
    assert not any(b.products for b in answer.blocks)


def test_non_filterable_requirements_are_verified_after_retrieval():
    schema = catalog_schema(
        attributes=[schema_attribute("vegan", "boolean", filterable=False)]
    )
    answer, calls = asyncio.run(
        scenario(
            "find vegan food",
            {"attributes": [{"name": "vegan", "value": "true"}]},
            [
                product(
                    1,
                    attributes=[
                        {"name": "vegan", "value": "true", "source": "VERIFIED"}
                    ],
                ),
                product(
                    2,
                    attributes=[
                        {"name": "vegan", "value": "true", "source": "AI_INFERRED"}
                    ],
                ),
                product(3, attributes=[]),
                product(4, attributes=[{"name": "vegan", "value": "false"}]),
            ],
            catalog_schema_override=schema,
        )
    )
    assert [str(p.id) for b in answer.blocks for p in b.products or []] == [
        product(1)["id"]
    ]
    assert (
        next(c for c in calls if c["name"] == "search_products")["arguments"][
            "attributes"
        ]
        == {}
    )
    assert "VERIFIED" in answer.text
    with pytest.raises(ValueError, match="Conflicting"):
        structured_filters(
            [
                Constraint(name="vegan", value="true"),
                Constraint(name="vegan", value="false"),
            ],
            CatalogSchema(**schema),
            allow_evidence_only=True,
        )


def test_named_charger_guidance_retains_device_and_requests_needed_catalog_evidence():
    message = "I need a charger for an iPhone 13. How do I avoid buying the wrong one?"
    text = "for an iPhone 13"
    requirements = [
        {
            "kind": "named_device_compatibility",
            "text": text,
            "start": message.index(text),
            "end": message.index(text) + len(text),
        }
    ]
    interpretation = interpreted(
        gate.Resolution(
            status="RESOLVED",
            intent="PRODUCT_SEARCH",
            confidence=1,
            message="",
            entities={"productText": "charger", "evidenceRequirements": requirements},
        )
    )
    answer, calls = asyncio.run(
        scenario(
            message,
            {},
            [product(name="Generic charger")],
            interpretation=interpretation,
        )
    )
    assert "For iPhone 13" in answer.text
    assert "wall adapter, a charging cable, or both?" in answer.text
    assert (
        "listed connector, power rating, and explicit device compatibility"
        in answer.text
    )
    assert "cannot confirm a match from the device name alone" in answer.text
    assert not calls and not answer.blocks
    assert "Lightning" not in answer.text and "USB-C" not in answer.text
    assert "Generic charger" not in answer.text


def test_device_family_guidance_preserves_known_family_and_asks_for_missing_model():
    message = "I need a charger for my iPhone. How do I avoid buying the wrong one?"
    phrase = "for my iPhone"
    answer = requirement_clarification(
        [
            {
                "kind": "device_compatibility",
                "text": phrase,
                "start": message.index(phrase),
                "end": message.index(phrase) + len(phrase),
            }
        ],
        message,
    )
    assert "Which exact iPhone model" in answer
    assert "listed connector, power rating, and explicit device compatibility" in answer
    assert (
        "iPhone 13" not in answer
        and "Lightning" not in answer
        and "USB-C" not in answer
    )
