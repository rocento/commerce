"""Negative controls for full-catalog, schema-driven acceptance evidence."""

import asyncio
import json
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

import pytest
from pydantic import ValidationError

from app.commerce_action_engine.actions.catalog import CatalogSchema, Product
from evals.lab.catalog_oracle import (
    dynamic_assertions,
    eligible_products,
    frozen_profile,
    observed_choices,
)
from evals.lab.dynamic_fixtures import generate, historical_demo_snapshots
from evals.lab.models import (
    Case,
    ClarificationExpectation,
    Expectation,
    Predicate,
    Snapshot,
)
from evals.lab.runner import run_case


def snapshot(store="outdoor-equipment", count=3, *, complete=True):
    attributes = []
    for code, kind, options in [
        ("finish", "select", ["woven", "smooth"]),
        ("activities", "multiselect", ["walking", "camping", "climbing"]),
        ("capacity", "integer", []),
        ("waterproof", "boolean", []),
    ]:
        attributes.append(
            {
                "code": code,
                "label": code.title(),
                "data_type": kind,
                "options": [{"code": v, "label": v.title()} for v in options],
                "filterable": True,
                "searchable": True,
                "facetable": True,
                "sortable": False,
                "comparable": True,
                "variant_axis": code == "finish",
                "source_policy": "factual",
                "unit": None,
                "min": None,
                "max": None,
            }
        )
    schema = CatalogSchema.model_validate(
        {"industry": store, "version": "frozen-1", "attributes": attributes}
    )
    products = []
    for index in range(count):
        pid = str(UUID(int=100 + index))
        values = {
            "finish": "woven" if index % 2 else "smooth",
            "activities": ["walking", "camping"] if index % 2 else ["climbing"],
            "capacity": 9 if index % 2 else 128,
            "waterproof": bool(index % 2),
        }
        products.append(
            Product.model_validate(
                {
                    "id": pid,
                    "name": f"Pack {index}",
                    "price": str(index + 1),
                    "currency": "USD",
                    "category_id": str(UUID(int=10)),
                    "category_name": "Packs",
                    "product_type": "simple",
                    "attributes": [
                        {"name": code, "value": json.dumps(value), "source": "MERCHANT"}
                        for code, value in values.items()
                    ],
                    "in_stock": True,
                    "route": "/products/" + pid,
                }
            )
        )
    return Snapshot(
        id=store + "-fixture",
        store=store,
        tenant_id=UUID(int=1),
        source="reviewed_synthetic_pattern",
        source_revision="test-only-facts",
        observed_at="2026-10-07T00:00:00Z",
        catalog_schema=schema,
        products=products,
        catalog_complete=complete,
    )


def block(product):
    return SimpleNamespace(products=[product])


def assertions(*args, **kwargs):
    return {f.assertion for f in dynamic_assertions(*args, **kwargs)}


def test_store_identity_is_dynamic_and_complete_oracle_is_not_first_thirty_cards():
    data = snapshot("pharmacy", 31)
    assert len(data.products) == 31
    data.products[-1].attributes[0].value = '"rare"'
    expected = Expectation(
        predicates=[Predicate(code="finish", value="rare")], require_eligible=True
    )
    assert [str(p.id) for p in eligible_products(data, expected)] == [
        str(data.products[-1].id)
    ]
    assert "false_no_match" in assertions([], data, expected)
    assert "false_no_match" not in assertions(
        [block(data.products[-1])], data, expected
    )
    assert snapshot("future-demo-5").store == "future-demo-5"
    with pytest.raises(ValidationError):
        snapshot("other/tenant")


def test_no_match_cannot_be_scored_against_an_unconfirmed_snapshot():
    data = snapshot(complete=False)
    failures = assertions([], data, Expectation(require_eligible=True))
    assert failures == {"complete_oracle_snapshot_required"}
    with pytest.raises(ValueError, match="complete frozen"):
        generate([data])


def test_multiselect_membership_numeric_order_and_boolean_types_are_independent():
    data = snapshot()
    expected = Expectation(
        predicates=[
            Predicate(code="activities", operator="contains", value="camping"),
            Predicate(code="capacity", operator="lt", value=100),
            Predicate(code="waterproof", value=True),
        ]
    )
    assert eligible_products(data, expected) == [data.products[1]]
    assert "typed_hard_constraint_or_sellable_variant" in assertions(
        [block(data.products[0])], data, expected
    )
    assert not eligible_products(
        data,
        Expectation(predicates=[Predicate(code="capacity", operator="gte", value="9")]),
    )
    assert not eligible_products(
        data, Expectation(predicates=[Predicate(code="waterproof", value=1)])
    )


def test_negative_requirement_never_matches_unknown_or_inferred_values():
    data = snapshot()
    expected = Expectation(
        predicates=[Predicate(code="finish", operator="neq", value="smooth")]
    )
    assert eligible_products(data, expected) == [data.products[1]]
    data.products[1].attributes[0].source = "AI_INFERRED"
    assert not eligible_products(data, expected)
    expected = Expectation(
        predicates=[Predicate(code="activities", operator="neq", value="camping")]
    )
    assert eligible_products(data, expected) == [data.products[0], data.products[2]]


def test_scoped_facet_simulation_uses_complete_catalog_and_structured_predicates():
    from app.commerce_action_engine.actions.catalog.contracts import CatalogProfile

    data = snapshot(count=31)
    profile = CatalogProfile.model_validate(
        frozen_profile(
            data, {"predicates": [{"name": "capacity", "operator": "lt", "value": 100}]}
        )
    )
    assert profile.candidate_count == 31 and profile.matched_count == 15
    activities = next(f for f in profile.facets if f.code == "activities")
    assert {v.value: v.count for v in activities.values} == {
        "camping": 15,
        "walking": 15,
    }
    assert activities.covered_count == 15
    assert profile.prices[0].min == "2" and profile.prices[0].max == "30"


def test_category_oracle_supports_descendants_and_secondary_membership():
    from app.commerce_action_engine.actions.catalog.contracts import SchemaCategory

    data = snapshot()
    parent, child, other = UUID(int=9), UUID(int=10), UUID(int=11)
    data.catalog_schema.categories = [
        SchemaCategory(id=parent, name="Equipment"),
        SchemaCategory(id=child, name="Packs", parent_id=parent),
        SchemaCategory(id=other, name="Accessories"),
    ]
    data.products[1].category_id = other
    data.category_memberships = {str(data.products[1].id): [str(child), str(other)]}
    assert (
        eligible_products(data, Expectation(category_ids=[str(parent)]))
        == data.products
    )
    assert len(eligible_products(data, Expectation(category_ids=[str(child)]))) == 3
    # A free-text query is not evidence of an exhaustive typed catalog scope.
    assert frozen_profile(data, {"query": "good packs"}) is None
    assert frozen_profile(data, {"query": "Packs"})["matched_count"] == 3


def test_subjective_no_match_cannot_pass_as_an_empty_answer():
    data = snapshot()
    expected = Expectation(require_eligible=True, allow_clarification=True)
    assert "false_no_match" in assertions([], data, expected)
    assert not assertions(
        [],
        data,
        expected,
        pending={
            "field": "budget",
            "question": "What is your budget?",
            "currency": "USD",
            "choices": [{"label": "Up to 2 USD", "value": "2", "operator": "lte"}],
        },
    )
    assert "false_no_match" in assertions(
        [],
        data,
        expected,
        pending={"field": "invented_quality_score", "question": "What quality?"},
    )


@pytest.mark.parametrize(
    "pending, failure",
    [
        (
            {"field": "budget", "question": "What is your budget?"},
            "clarification_choice_count",
        ),
        (
            {
                "field": "budget",
                "question": "What is your budget?",
                "currency": "USD",
                "choices": [{"label": "Up to 500", "value": "500", "operator": "lte"}],
            },
            "unsupported_or_non_narrowing_budget_choice",
        ),
        (
            {
                "field": "activities",
                "question": "Which activity?",
                "choices": [{"label": "Skiing", "value": "skiing"}],
            },
            "unsupported_or_zero_count_clarification_choice",
        ),
    ],
)
def test_optional_generated_questions_still_require_grounded_useful_choices(
    pending, failure
):
    assert failure in assertions(
        [],
        snapshot(),
        Expectation(require_eligible=True, allow_clarification=True),
        pending=pending,
    )


def test_profile_over_runtime_bound_never_claims_complete_scope():
    data = snapshot(count=1_001)
    assert data.catalog_complete
    profile = frozen_profile(data, {"query": "*"})
    assert profile["complete"] is False
    # The independent oracle still keeps every offer; only the bounded runtime
    # profile declines an exhaustive-scope claim.
    assert len(eligible_products(data, Expectation())) == 1_001


def test_legacy_merchant_schema_aliases_keep_typed_membership_and_case_generation():
    data = snapshot()
    data.catalog_schema.attributes[0].data_type = "single_select"
    data.catalog_schema.attributes[1].data_type = "multi_select"
    expected = Expectation(
        predicates=[Predicate(code="activities", operator="neq", value="climbing")]
    )
    assert eligible_products(data, expected) == [data.products[1]]
    assert observed_choices(data.products, "activities", data.catalog_schema) == {
        ("string", "walking"): 1,
        ("string", "camping"): 1,
        ("string", "climbing"): 2,
    }
    generated = generate([data])
    assert {"contains", "neq"} <= {
        p.operator
        for case in generated.cases
        for turn in case.turns
        for p in turn.expected.predicates
        if p.code == "activities"
    }
    assert any(
        p.code == "finish"
        for case in generated.cases
        for turn in case.turns
        for p in turn.expected.predicates
    )


def test_inferred_attributes_cannot_prove_mandatory_fact_or_question_choice():
    data = snapshot()
    data.products[1].attributes[0].source = "AI_INFERRED"
    expected = Expectation(predicates=[Predicate(code="finish", value="woven")])
    assert not eligible_products(data, expected)
    assert observed_choices(data.products, "finish", data.catalog_schema) == {
        ("string", "smooth"): 2
    }


def test_decimal_exclusive_budget_and_currency_never_use_float_rounding():
    data = snapshot()
    data.products[0].price = "0.100000"
    data.products[1].price = "0.099999"
    data.products[2].price = "0.099999"
    data.products[2].currency = "EGP"
    expected = Expectation(
        currency="USD",
        min_price="0.09",
        exclusive_min=True,
        max_price="0.1",
        exclusive_max=True,
    )
    assert eligible_products(data, expected) == [data.products[1]]
    # Numeric attribute JSON is parsed independently with decimal precision too.
    data.catalog_schema.attributes[2].data_type = "decimal"
    data.products[0].attributes[2].value = "0.1000000000000000001"
    expected = Expectation(
        predicates=[Predicate(code="capacity", operator="lte", value=0.1)]
    )
    assert data.products[0] not in eligible_products(data, expected)


def test_parent_aggregate_and_disjoint_variants_do_not_make_a_sellable_combination():
    data = snapshot()
    data.products[0].product_type = "configurable"
    # Woven offers have capacity 9, smooth has 128. Parent aggregate tags
    # cannot manufacture a woven/128 offer from two separate children.
    expected = Expectation(
        predicates=[
            Predicate(code="finish", value="woven"),
            Predicate(code="capacity", value=128),
        ]
    )
    assert not eligible_products(data, expected)
    assert "typed_hard_constraint_or_sellable_variant" in assertions(
        [block(data.products[0])], data, expected
    )


def test_question_choices_use_full_eligible_scope_and_deduplicate_overlapping_tags():
    data = snapshot()
    data.products[1].attributes[1].value = '["camping", "walking", "camping"]'
    scope = [Predicate(code="finish", value="woven")]
    expected = Expectation(
        clarification=ClarificationExpectation(
            field="activities",
            scope_predicates=scope,
            required_choices=["camping"],
            forbidden_choices=["climbing"],
            optional=True,
        )
    )
    pending = {
        "field": "activities",
        "optional": True,
        "choices": [{"value": "camping", "label": "Camping"}],
    }
    assert not assertions([], data, expected, pending=pending)
    pending["choices"].append({"value": "climbing", "label": "Climbing"})
    failures = assertions([], data, expected, pending=pending)
    assert "irrelevant_clarification_choice" in failures
    assert "unsupported_or_zero_count_clarification_choice" in failures
    counts = observed_choices([data.products[1]], "activities", data.catalog_schema)
    assert counts[("string", "camping")] == 1


def test_question_oracle_rejects_missing_question_and_unknown_field():
    data = snapshot()
    expected = Expectation(clarification=ClarificationExpectation())
    assert assertions([], data, expected) == {"required_clarification_missing"}
    pending = {"field": "camera_quality", "choices": [{"value": "excellent"}]}
    assert "unsupported_or_zero_count_clarification_choice" in assertions(
        [], data, expected, pending=pending
    )


def test_follow_up_must_preserve_unreplaced_target_budget_and_required_field():
    data = snapshot()
    expected = Expectation(
        preserved_paths={
            "category": "Packs",
            "max_price": "20",
            "attributes.0.name": "finish",
            "attributes.0.value": "woven",
        }
    )
    frame = {
        "category": "Packs",
        "max_price": "20",
        "attributes": [{"name": "finish", "value": "woven"}],
    }
    assert not assertions([], data, expected, frame=frame)
    frame["max_price"] = None
    assert "follow_up_preserved:max_price" in assertions(
        [], data, expected, frame=frame
    )
    assert "unresolved_requirement_presented_as_match" in assertions(
        [block(data.products[0])], data, Expectation(forbid_results=True)
    )


def test_real_shopping_path_clarifies_subjective_target_then_resumes_budget():
    from app.commerce_action_engine.actions.catalog.contracts import SchemaCategory

    data = snapshot()
    category = str(data.products[0].category_id)
    data.catalog_schema.categories = [
        SchemaCategory(id=category, name="Packs", aliases=["pack"], sellable_count=3)
    ]
    case = Case.model_validate(
        {
            "id": "unseen-catalog-budget-follow-up",
            "snapshot": data.id,
            "store": data.store,
            "language": "en",
            "journey": "discovery",
            "kind": "catalog",
            "suite": "conversation",
            "candidates": [str(p.id) for p in data.products],
            "turns": [
                {
                    "message": "I need good packs",
                    "model_output": {
                        "shopping": True,
                        "query": "good packs",
                        "category": "Packs",
                    },
                    "expected": {
                        "require_eligible": True,
                        "allow_clarification": True,
                        "clarification": {"field": "budget", "optional": True},
                    },
                },
                {
                    "message": "under $2",
                    "model_output": {"shopping": True, "query": "*"},
                    "expected": {
                        "min_results": 1,
                        "category_ids": [category],
                        "currency": "USD",
                        "max_price": "2",
                        "exclusive_max": True,
                        "preserved_paths": {
                            "category_id": category,
                            "max_price": "2",
                            "exclusive_max": True,
                            "currency": "USD",
                        },
                    },
                },
            ],
        }
    )
    row = asyncio.run(run_case(case, data))
    assert row.status == "passed", [f.assertion for f in row.failures]
    assert row.provider_calls == 1
    assert row.trace[0]["pending_shopping"]["field"] == "budget"
    assert row.trace[1]["shopping_frame"]["discovery_refined"] is True
    assert row.trace[1]["product_ids"] == [str(data.products[0].id)]


def test_real_shopping_stale_descriptor_reasks_before_applying_old_choice(monkeypatch):
    from app.commerce_action_engine.actions.catalog.contracts import (
        SchemaCategory,
        SchemaOption,
    )
    from evals.lab import runner

    data = snapshot()
    data.products[0].attributes[1].value = '["climbing", "running"]'
    data.catalog_schema.attributes[1].options.append(
        SchemaOption(code="running", label="Running")
    )
    category = str(data.products[0].category_id)
    data.catalog_schema.categories = [
        SchemaCategory(id=category, name="Packs", aliases=["pack"], sellable_count=3)
    ]
    profile = runner.frozen_profile

    def change_after_observation(snapshot, arguments):
        result = profile(snapshot, arguments)
        if result is not None and snapshot.catalog_schema.version == "frozen-1":
            snapshot.catalog_schema.version = "changed-2"
            snapshot.products[1].attributes[1].value = '["walking"]'
            snapshot.catalog_schema.attributes[1].options = [
                o
                for o in snapshot.catalog_schema.attributes[1].options
                if o.code != "camping"
            ]
        return result

    monkeypatch.setattr(runner, "frozen_profile", change_after_observation)
    question = {"clarification": {"optional": True}, "forbid_results": True}
    case = Case.model_validate(
        {
            "id": "stale-discovery-choice",
            "snapshot": data.id,
            "store": data.store,
            "language": "en",
            "journey": "discovery",
            "kind": "catalog",
            "suite": "adversarial",
            "candidates": [str(p.id) for p in data.products],
            "turns": [
                {
                    "message": "I need good packs under $4",
                    "model_output": {
                        "shopping": True,
                        "query": "good packs",
                        "category": "Packs",
                        "max_price": "4",
                        "exclusive_max": True,
                        "currency": "USD",
                    },
                    "expected": question,
                },
                {
                    "message": "Camping",
                    "model_output": {"shopping": True, "query": "*"},
                    "expected": {
                        **question,
                        "clarification": {
                            "optional": True,
                            "forbidden_choices": ["camping"],
                        },
                        "preserved_paths": {
                            "category_id": category,
                            "max_price": "4",
                            "attributes": [],
                        },
                    },
                },
            ],
        }
    )
    row = asyncio.run(run_case(case, data))
    assert row.status == "passed", [f.assertion for f in row.failures]
    assert row.trace[0]["pending_shopping"]["descriptor_revision"] == "frozen-1"
    assert row.trace[1]["pending_shopping"]["descriptor_revision"] == "changed-2"


def test_real_shopping_unknown_mandatory_modifier_never_becomes_full_match():
    from app.commerce_action_engine.actions.catalog.contracts import SchemaCategory

    data = snapshot()
    category = str(data.products[0].category_id)
    data.catalog_schema.categories = [
        SchemaCategory(id=category, name="Packs", aliases=["pack"], sellable_count=3)
    ]
    case = Case.model_validate(
        {
            "id": "unsupported-required-luxury",
            "snapshot": data.id,
            "store": data.store,
            "language": "en",
            "journey": "discovery",
            "kind": "catalog",
            "suite": "adversarial",
            "candidates": [str(p.id) for p in data.products],
            "turns": [
                {
                    "message": "I need packs that must be luxury",
                    "model_output": {
                        "shopping": True,
                        "query": "luxury packs",
                        "category": "Packs",
                    },
                    "expected": {
                        "forbid_results": True,
                        "text_all": ["couldn’t verify", "luxury"],
                    },
                }
            ],
        }
    )
    row = asyncio.run(run_case(case, data))
    assert row.status == "passed", [f.assertion for f in row.failures]
    assert any(
        r["kind"] == "required" and r["text"] == "luxury"
        for r in row.trace[0]["shopping_frame"]["unresolved_requirements"]
    )


@pytest.mark.parametrize("meaning", [False, True])
def test_real_merchant_defined_luxury_uses_scoped_field_and_trusted_evidence(meaning):
    from app.commerce_action_engine.actions.catalog.contracts import (
        SchemaAttribute,
        SchemaCategory,
    )

    data = snapshot("future-fashion")
    category = str(data.products[0].category_id)
    data.catalog_schema.categories = [
        SchemaCategory(id=category, name="Packs", sellable_count=3)
    ]
    data.catalog_schema.attributes.append(
        SchemaAttribute.model_validate(
            {
                "code": "merchant_collection",
                "label": "Merchant collection",
                "description": "Merchant collection positioning only; not a material or authenticity certification.",
                "data_type": "select",
                "options": [
                    {"code": "luxury", "label": "Luxury"},
                    {"code": "everyday", "label": "Everyday"},
                ],
                "filterable": True,
                "searchable": True,
                "facetable": True,
                "sortable": False,
                "comparable": True,
                "variant_axis": False,
                "source_policy": "semantic",
                "semantic_role": None,
                "unit": None,
                "min": None,
                "max": None,
            }
        )
    )
    from app.commerce_action_engine.actions.catalog.contracts import Attribute

    for index, product in enumerate(data.products):
        product.attributes.append(
            Attribute(
                name="merchant_collection",
                value='"luxury"' if index != 1 else '"everyday"',
                source="AI_INFERRED" if index == 2 else "MERCHANT",
            )
        )
    case = Case.model_validate(
        {
            "id": "merchant-defined-luxury",
            "snapshot": data.id,
            "store": data.store,
            "language": "en",
            "journey": "discovery",
            "kind": "catalog",
            "suite": "catalog_grounded",
            "candidates": [str(p.id) for p in data.products],
            "turns": [
                {
                    "message": "I need packs that must be luxury",
                    "model_output": {
                        "shopping": True,
                        "query": "luxury packs",
                        "category": "Packs",
                    },
                    "expected": {
                        "min_results": 1,
                        "predicates": [
                            {"code": "merchant_collection", "value": "luxury"}
                        ],
                        "text_none": ["certified", "authentic", "guaranteed"],
                    },
                }
            ],
        }
    )
    row = asyncio.run(run_case(case, data, commerce_meaning=meaning))
    assert row.status == "passed", [f.assertion for f in row.failures]
    assert row.trace[0]["product_ids"] == [str(data.products[0].id)]


def test_real_exact_name_containing_quality_word_keeps_literal_identity():
    from app.commerce_action_engine.actions.catalog.contracts import SchemaCategory

    data = snapshot()
    category = str(data.products[0].category_id)
    data.catalog_schema.categories = [
        SchemaCategory(id=category, name="Packs", sellable_count=3)
    ]
    data.products[1].name = "Good Packs"
    case = Case.model_validate(
        {
            "id": "literal-quality-product-name",
            "snapshot": data.id,
            "store": data.store,
            "language": "en",
            "journey": "discovery",
            "kind": "catalog",
            "suite": "catalog_grounded",
            "candidates": [str(p.id) for p in data.products],
            "turns": [
                {
                    "message": "I need Good Packs",
                    "model_output": {
                        "shopping": True,
                        "query": "Good Packs",
                        "category": "Packs",
                    },
                    "expected": {"ids": [str(data.products[1].id)], "min_results": 1},
                }
            ],
        }
    )
    row = asyncio.run(run_case(case, data))
    assert row.status == "passed", [f.assertion for f in row.failures]
    assert not row.trace[0].get("pending_shopping")
    assert row.trace[0]["shopping_frame"]["query"] == "Good Packs"


def test_generated_cases_are_reproducible_and_hold_out_changed_schema_names():
    data = snapshot()
    first = generate([data])
    assert first.model_dump() == generate([data]).model_dump()
    assert {
        p.code for c in first.cases for t in c.turns for p in t.expected.predicates
    } == {"finish", "activities", "capacity", "waterproof"}
    assert any(
        p.operator == "contains"
        for c in first.cases
        for t in c.turns
        for p in t.expected.predicates
    )
    assert any(
        p.operator == "gte"
        for c in first.cases
        for t in c.turns
        for p in t.expected.predicates
    )
    renamed = data.model_copy(deep=True)
    renamed.catalog_schema.attributes[0].code = "surface_v2"
    renamed.catalog_schema.attributes[0].label = "Surface construction"
    for product in renamed.products:
        product.attributes[0].name = "surface_v2"
    second = generate([renamed])
    assert any(
        "Surface construction" in t.message for c in second.cases for t in c.turns
    )
    assert "finish" not in {
        p.code for c in second.cases for t in c.turns for p in t.expected.predicates
    }


def test_all_four_demo_snapshots_use_actual_historical_metadata_without_new_claims():
    root = Path(__file__).resolve().parents[2]
    before_path = root / "artifacts/advanced-attributes-20261007/before.json"
    if not before_path.exists():
        pytest.skip(
            "Historical local catalog capture is not distributed with the source tree"
        )
    before = json.loads(before_path.read_text())
    manifest = json.loads(
        (root / "commerce-assets/demo/advanced-assistant-attributes/manifest.json").read_text()
    )
    captures = historical_demo_snapshots(
        before, manifest, "historical-reviewed-manifest", "2026-10-07T00:00:00Z"
    )
    assert {s.store for s in captures} == {
        "grocery",
        "jewelry",
        "electronics",
        "pharmacy",
    }
    assert {s.store: len(s.products) for s in captures} == {
        store: sum(p["active"] for p in source["products"])
        for store, source in before.items()
    }
    assert all(s.source == "historical_demo_snapshot" for s in captures)
    assert all(
        str(p.id) in {source["id"] for source in before[s.store]["products"]}
        for s in captures
        for p in s.products
    )
    dataset = generate(captures)
    assert {c.store for c in dataset.cases} == {s.store for s in captures}
    assert len(dataset.cases) == len({c.id for c in dataset.cases})
    jewelry = next(s for s in captures if s.store == "jewelry")
    assert not any(
        "luxury" in a.code.casefold() for a in jewelry.catalog_schema.attributes
    )


@pytest.mark.parametrize(
    "features",
    [{}, {"commerce_core": True, "commerce_meaning": True, "commerce_planning": True}],
)
def test_actual_node_resolution_bypasses_extraction_for_four_demo_subjective_requests(
    tmp_path, features
):
    root = Path(__file__).resolve().parents[2]
    before_path = root / "artifacts/advanced-attributes-20261007/before.json"
    node = shutil.which("node")
    if node is None or not before_path.exists():
        pytest.skip(
            "Local Node runtime and historical demo snapshot required for this integration proof"
        )
    requests = {
        "electronics": "I need good phone",
        "jewelry": "I need luxury rings",
        "grocery": "I need good breakfast",
        "pharmacy": "I need good face cream",
    }
    inputs = tmp_path / "node-cases.jsonl"
    inputs.write_text(
        "".join(
            json.dumps({"id": store, "messages": [message]}) + "\n"
            for store, message in requests.items()
        )
    )
    with inputs.open("a") as stream:
        stream.write(
            json.dumps(
                {"id": "electronics-required", "messages": ["I need waterproof phone"]}
            )
            + "\n"
        )
        stream.write(
            json.dumps(
                {
                    "id": "electronics-numeric",
                    "messages": [
                        "I need good phone Storage GB at least 128 GB under $500"
                    ],
                }
            )
            + "\n"
        )
    process = subprocess.run(
        [node, str(root / "commerce-ops/scripts/shopping_eval/engine-worker.mjs"), str(inputs)],
        cwd=root,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )
    assert process.returncode == 0, process.stderr[-1000:]
    language = {
        r["id"]: r["turns"][0]["result"]
        for line in process.stdout.splitlines()
        if (r := json.loads(line))
    }
    captures = historical_demo_snapshots(
        json.loads(before_path.read_text()),
        json.loads(
            (
                root / "commerce-assets/demo/advanced-assistant-attributes/manifest.json"
            ).read_text()
        ),
        "node-four-demo-snapshot",
        "2026-10-07T00:00:00Z",
    )
    snapshots = {s.store: s for s in captures}
    outcomes = []
    measured = []
    for store, message in requests.items():
        snapshot = snapshots[store]
        assert language[store]["status"] != "UNKNOWN"
        scope = (
            {
                "category_ids": [
                    str(
                        next(
                            c.id
                            for c in snapshot.catalog_schema.categories
                            if c.name
                            == ("Phones" if store == "electronics" else "Rings")
                        )
                    )
                ]
            }
            if store in {"electronics", "jewelry"}
            else {
                "predicates": [
                    {
                        "code": "meal_occasion",
                        "operator": "contains",
                        "value": "breakfast",
                    }
                ]
            }
            if store == "grocery"
            else {
                "predicates": [
                    {"code": "care-area", "value": "Face"},
                    {"code": "texture", "value": "Cream"},
                ]
            }
        )
        expected = Expectation.model_validate(scope)
        eligible = eligible_products(snapshot, expected)
        ids = {str(p.id) for p in eligible}
        candidates = (
            eligible[:1]
            + [
                p
                for p in snapshot.products
                if p.product_type == "simple" and str(p.id) not in ids
            ][:4]
        )
        case = Case.model_validate(
            {
                "id": store + "-actual-language-grounding",
                "snapshot": snapshot.id,
                "store": store,
                "language": "en",
                "journey": "discovery",
                "kind": "catalog",
                "suite": "conversation",
                "candidates": [str(p.id) for p in candidates],
                "turns": [
                    {
                        "message": message,
                        "model_output": {
                            "shopping": True,
                            "query": "unused scripted extraction",
                        },
                        "language_result": language[store],
                        "expected": {
                            **scope,
                            "require_eligible": True,
                            "allow_clarification": True,
                            "max_calls": 0,
                        },
                    }
                ],
            }
        )
        row = asyncio.run(run_case(case, snapshot, **features))
        measured.append(row.model_dump(mode="json"))
        outcomes.append(
            (store, row.status, [f.assertion for f in row.failures], row.trace[0])
        )
        assert row.provider_calls == 0, (
            "Known language result must not call model extraction"
        )
    failed = [outcome for outcome in outcomes if outcome[1] != "passed"]
    snapshot = snapshots["electronics"]
    phone_category = str(
        next(c.id for c in snapshot.catalog_schema.categories if c.name == "Phones")
    )
    numeric_scope = {
        "category_ids": [phone_category],
        "predicates": [{"code": "storage_gb", "operator": "gte", "value": 128}],
        "max_price": "500",
        "exclusive_max": True,
        "currency": "USD",
    }
    numeric_eligible = eligible_products(
        snapshot, Expectation.model_validate(numeric_scope)
    )
    assert numeric_eligible, "Recorded phone catalog must supply this factual scope"
    numeric_ids = {str(p.id) for p in numeric_eligible}
    numeric_candidates = (
        numeric_eligible[:1]
        + [p for p in snapshot.products if str(p.id) not in numeric_ids][:4]
    )
    numeric_case = Case.model_validate(
        {
            "id": "electronics-actual-language-numeric-range-budget",
            "snapshot": snapshot.id,
            "store": snapshot.store,
            "language": "en",
            "journey": "discovery",
            "kind": "catalog",
            "suite": "catalog_grounded",
            "candidates": [str(p.id) for p in numeric_candidates],
            "turns": [
                {
                    "message": "I need good phone Storage GB at least 128 GB under $500",
                    "model_output": {"shopping": True},
                    "language_result": language["electronics-numeric"],
                    "expected": {
                        **numeric_scope,
                        "require_eligible": True,
                        "allow_clarification": True,
                        "max_calls": 0,
                        "preserved_paths": {"max_price": "500", "min_price": None},
                    },
                }
            ],
        }
    )
    numeric = asyncio.run(run_case(numeric_case, snapshot, **features))
    measured.append(numeric.model_dump(mode="json"))
    (tmp_path / "actual-node-numeric.json").write_text(
        json.dumps(numeric.model_dump(mode="json"), indent=2) + "\n"
    )
    assert numeric.status == "passed", json.dumps(numeric.model_dump(mode="json"))
    assert numeric.provider_calls == 0
    case = Case.model_validate(
        {
            "id": "electronics-actual-language-required",
            "snapshot": snapshot.id,
            "store": snapshot.store,
            "language": "en",
            "journey": "discovery",
            "kind": "catalog",
            "suite": "adversarial",
            "candidates": [str(p.id) for p in snapshot.products[:5]],
            "turns": [
                {
                    "message": "I need waterproof phone",
                    "model_output": {"shopping": True},
                    "language_result": language["electronics-required"],
                    "expected": {
                        "forbid_results": True,
                        "text_all": ["couldn’t verify", "waterproof"],
                        "max_calls": 0,
                    },
                }
            ],
        }
    )
    required = asyncio.run(run_case(case, snapshot, **features))
    measured.append(required.model_dump(mode="json"))
    (tmp_path / "actual-node-results.json").write_text(
        json.dumps(
            {
                "scope": "English actual local Node interpretation with frozen historical catalog observations; no live search recall, provider quality, or browser claim",
                "features": features,
                "language_results": language,
                "results": measured,
            },
            indent=2,
        )
        + "\n"
    )
    assert required.status == "passed", [f.assertion for f in required.failures]
    assert required.provider_calls == 0
    assert (
        required.trace[0]["shopping_frame"]["unresolved_requirements"][0]["kind"]
        == "required"
    )
    assert not failed, json.dumps(failed, ensure_ascii=False)
