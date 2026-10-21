"""Catalog targets and most-specific literal fields do not invent requirements."""

from uuid import UUID

import pytest

from app.commerce_action_engine.actions.catalog import CatalogSchema, Product
from app.commerce_action_engine.actions.shopping import Constraint, ShoppingIntent
from app.commerce_action_engine.actions.shopping.constraints import (
    matches_attribute,
    mismatches,
    numeric_constraints,
    preserve_schema_constraints,
    structured_filters,
)
from app.commerce_action_engine.actions.shopping.meaning import (
    MeaningConflict,
    literal_requirements,
)


def schema():
    def field(code, label, kind="select", options=(), unit=None):
        return {
            "code": code,
            "label": label,
            "data_type": kind,
            "unit": unit,
            "options": [{"code": v, "label": v.title(), "labels": {}} for v in options],
            "filterable": True,
            "searchable": True,
            "facetable": True,
            "sortable": False,
            "comparable": True,
            "variant_axis": False,
            "source_policy": "factual",
            "min": None,
            "max": None,
        }

    return CatalogSchema(
        industry=None,
        version="fresh",
        categories=[
            {"id": UUID(int=1), "name": "Face & Body", "aliases": []},
            {"id": UUID(int=2), "name": "Eye & Lip Care", "aliases": []},
        ],
        attributes=[
            field("care_area", "Care Area", options=("face", "body", "eye", "lip")),
            field("routine", "Routine", options=("face",)),
            field("size", "Size", options=("6", "7")),
            field("ring_size_us", "Ring Size US", "integer"),
            field("metal", "Metal", options=("gold", "silver", "rose_gold")),
            field("color", "Color", options=("gold", "red")),
            field("weight", "Weight", "measurement", unit="g"),
            field("storage_gb", "Storage GB", "integer", unit="GB"),
        ],
    )


@pytest.mark.parametrize("phrase", ["Face & Body", "Eye & Lip Care"])
def test_category_words_do_not_create_incidental_field_requirements(phrase):
    assert preserve_schema_constraints(phrase, [], schema()) == []
    assert literal_requirements(phrase, schema()) == ()


@pytest.mark.parametrize(
    "phrase,expected",
    [
        ("Face & Body, Care Area: face", [("care_area", "face", "eq")]),
        ("Metal: Gold", [("metal", "gold", "eq")]),
        ("without Metal: Gold", [("metal", "gold", "neq")]),
        ("without Ring size US 6", [("ring_size_us", "6", "neq")]),
        ("Ring size US 6, Size: 7", [("ring_size_us", "6", "eq"), ("size", "7", "eq")]),
    ],
)
def test_specific_labels_keep_explicit_clauses_and_negation(phrase, expected):
    original = (
        [Constraint(name="size", value="6")]
        if phrase.startswith("without Ring")
        else []
    )
    assert sorted(
        (c.name, c.value, c.operator)
        for c in preserve_schema_constraints(phrase, original, schema())
    ) == sorted(expected)
    assert sorted(
        (r.field, r.value.text or r.value.number, r.operator)
        for r in literal_requirements(phrase, schema())
    ) == sorted(expected)


def test_longest_managed_phrase_does_not_also_match_a_shorter_option():
    rows = literal_requirements("Metal: Rose Gold", schema())
    assert [(r.field, r.value.text) for r in rows] == [("metal", "rose_gold")]


def test_managed_ring_size_suppresses_provider_generic_size_without_numeric_type():
    runtime = schema()
    field = next(d for d in runtime.attributes if d.code == "ring_size_us")
    field.data_type = "select"
    field.options = [
        type(runtime.attributes[0].options[0])(code="6", label="6", labels={})
    ]
    runtime = CatalogSchema.model_validate(runtime.model_dump())
    original = [Constraint(name="size", value="6")]
    result = preserve_schema_constraints(
        "Find Rings without Ring size US 6", original, runtime
    )
    assert [(c.name, c.value, c.operator) for c in result] == [
        ("ring_size_us", "6", "neq")
    ]


def test_numeric_field_label_suffix_is_not_a_different_managed_size_or_type():
    runtime = schema()
    generic = next(d for d in runtime.attributes if d.code == "size")
    generic.options = [
        o.model_copy(update={"label": f"US {o.code}"}) for o in generic.options
    ]
    jewelry = runtime.attributes[0].model_copy(
        update={
            "code": "jewelry_type",
            "label": "Jewelry Type",
            "options": [type(generic.options[0])(code="ring", label="Ring", labels={})],
        }
    )
    runtime.attributes.append(jewelry)
    phrase = "Find Rings without Ring size US 6"
    original = [
        Constraint(name="ring_size_us", value="6", operator="neq"),
        Constraint(name="size", value="6"),
    ]
    assert [
        (c.name, c.value, c.operator)
        for c in preserve_schema_constraints(phrase, original, runtime)
    ] == [("ring_size_us", "6", "neq")]
    assert [(r.field, r.operator) for r in literal_requirements(phrase, runtime)] == [
        ("ring_size_us", "neq")
    ]


@pytest.mark.parametrize(
    "cue,strength",
    [
        ("prefer", "soft"),
        ("must", "hard"),
        ("prefer good phones but must", "hard"),
        ("must have good phones but ideally", "soft"),
    ],
)
def test_numeric_preference_stays_soft_and_nearest_requirement_cue_wins(cue, strength):
    phrase = f"Phones, {cue} Storage GB at least 128"
    literal = literal_requirements(phrase, schema())
    assert [(r.field, r.operator, r.strength) for r in literal] == [
        ("storage_gb", "gte", strength)
    ]
    hard = preserve_schema_constraints(
        phrase, [Constraint(name="storage_gb", value="128", operator="gte")], schema()
    )
    assert bool(hard) is (strength == "hard")


def test_explicit_option_preference_is_not_readded_as_a_hard_filter():
    phrase = "Phones, prefer Metal: Gold"
    assert (
        preserve_schema_constraints(
            phrase, [Constraint(name="metal", value="gold")], schema()
        )
        == []
    )
    assert literal_requirements(phrase, schema())[0].strength == "soft"


def test_explicit_foreign_unit_is_never_reinterpreted_as_catalog_unit():
    with pytest.raises(ValueError, match="declared unit"):
        numeric_constraints("Storage GB at least 1 TB", schema())
    with pytest.raises(MeaningConflict, match="declared unit"):
        literal_requirements("Weight at least 200 mg", schema())


def test_exact_numeric_equality_preserves_backend_decimal_semantics_and_source():
    product = Product(
        id=UUID(int=3),
        name="Device",
        price="100",
        currency="USD",
        category_id=UUID(int=1),
        product_type="simple",
        attributes=[{"name": "weight", "value": "200", "source": "MERCHANT"}],
        in_stock=True,
        route=f"/products/{UUID(int=3)}",
    )
    constraint = Constraint(name="weight", value="200")
    assert structured_filters([constraint], schema()) == {"weight": 200.0}
    assert matches_attribute(product, constraint)
    assert not matches_attribute(
        product, Constraint(name="weight", value="200.0", operator="neq")
    )
    product.attributes[0].source = "AI_INFERRED"
    assert not matches_attribute(product, constraint)
    product.attributes[0].source = "MERCHANT"
    product.attributes[0].value = '"200"'
    assert not matches_attribute(product, constraint), (
        "a numeric-looking string is not a typed numeric fact"
    )


def test_verified_category_scope_does_not_require_words_in_sku_name():
    product = Product(
        id=UUID(int=3),
        name="Calming Balm",
        price="10",
        currency="USD",
        category_id=UUID(int=1),
        category_ids=[UUID(int=1)],
        product_type="simple",
        attributes=[],
        in_stock=True,
        route=f"/products/{UUID(int=3)}",
    )
    plan = ShoppingIntent(
        shopping=True, query="*", category="Face & Body", category_id=str(UUID(int=1))
    )
    assert mismatches(product, plan, None) == []
    plan.category_id = None
    assert "category" in mismatches(product, plan, None)
