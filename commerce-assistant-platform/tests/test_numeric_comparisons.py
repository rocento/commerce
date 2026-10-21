"""Comparison wording is shared, while field type and scope remain independent."""

import json

import pytest
from test_catalog_schema import catalog_schema, schema_attribute
from test_shopping import product

from app.commerce_action_engine.actions.catalog import CatalogSchema, Product
from app.commerce_action_engine.actions.shopping.constraints import (
    matches_attribute,
    numeric_constraints,
    structured_filters,
)
from app.commerce_action_engine.actions.shopping.meaning import (
    MeaningConflict,
    literal_requirements,
)
from app.commerce_action_engine.actions.shopping.quantity_language import (
    quantity_comparisons,
)


def schema():
    return CatalogSchema(
        **catalog_schema(
            "devices",
            [
                schema_attribute("storage_gb", "integer", unit="GB", min=0),
                schema_attribute("weight_kg", "measurement", unit="kg", min=0),
                schema_attribute("color", options=["gold", "black"]),
            ],
        )
    )


@pytest.mark.parametrize(
    "phrase,operator,accepted",
    [
        ("under", "lt", [127]),
        ("below", "lt", [127]),
        ("less than", "lt", [127]),
        ("at most", "lte", [127, 128]),
        ("up to", "lte", [127, 128]),
        ("no more than", "lte", [127, 128]),
        ("maximum", "lte", [127, 128]),
        ("above", "gt", [129]),
        ("over", "gt", [129]),
        ("more than", "gt", [129]),
        ("greater than", "gt", [129]),
        ("at least", "gte", [128, 129]),
        ("no less than", "gte", [128, 129]),
        ("minimum", "gte", [128, 129]),
        ("exactly", "eq", [128]),
        ("<", "lt", [127]),
        ("<=", "lte", [127, 128]),
        (">", "gt", [129]),
        (">=", "gte", [128, 129]),
        ("=", "eq", [128]),
        ("", "eq", [128]),
    ],
)
def test_attribute_comparisons_prove_exact_numeric_boundaries(
    phrase, operator, accepted
):
    message = f"Find phones Storage GB {phrase} 128 GB"
    rows = numeric_constraints(message, schema())
    assert len(rows) == 1
    constraint, span = rows[0]
    assert (constraint.name, constraint.value, constraint.operator) == (
        "storage_gb",
        "128",
        operator,
    )
    assert message[slice(*span)].startswith("Storage GB")
    structured_filters([constraint], schema())
    assert [
        value
        for value in [127, 128, 129]
        if matches_attribute(
            Product(
                **product(
                    attributes=[{"name": "storage_gb", "value": json.dumps(value)}]
                )
            ),
            constraint,
        )
    ] == accepted


def test_attribute_comparison_whitespace_and_short_alias_keep_declared_unit():
    rows = numeric_constraints("Storage no\tmore than 128 GB", schema())
    assert len(rows) == 1
    assert (rows[0][0].name, rows[0][0].operator) == ("storage_gb", "lte")
    assert not numeric_constraints("Storage no more than 1 TB", schema())
    with pytest.raises(ValueError, match="declared unit"):
        numeric_constraints("Storage GB no more than 1 TB", schema())


def test_attribute_comparison_keeps_schema_type_bounds_and_negation_checks():
    with pytest.raises(ValueError, match="Invalid numeric constraint"):
        structured_filters(
            [numeric_constraints("Storage GB at most 1.5 GB", schema())[0][0]], schema()
        )
    with pytest.raises(ValueError, match="Negated range"):
        numeric_constraints("not Storage GB under 128 GB", schema())
    constraint = numeric_constraints("not Storage GB 128 GB", schema())[0][0]
    assert constraint.operator == "neq"
    limited = CatalogSchema(
        **catalog_schema(
            attributes=[schema_attribute("storage_gb", "integer", unit="GB", max=256)]
        )
    )
    with pytest.raises(ValueError, match="schema bounds"):
        structured_filters(
            [numeric_constraints("Storage GB at least 512 GB", limited)[0][0]], limited
        )


@pytest.mark.parametrize(
    "phrase,operator",
    [
        ("under", "lt"),
        ("below", "lt"),
        ("less than", "lt"),
        ("at most", "lte"),
        ("up to", "lte"),
        ("no more than", "lte"),
        ("above", "gt"),
        ("over", "gt"),
        ("more than", "gt"),
        ("greater than", "gt"),
        ("at least", "gte"),
        ("no less than", "gte"),
        ("exactly", "eq"),
        ("", "eq"),
    ],
)
def test_quantity_uses_shared_operators_but_retains_basket_scope(phrase, operator):
    message = f"quantity {phrase} 3 pieces"
    rows = literal_requirements(message, schema())
    assert len(rows) == 1
    row = rows[0]
    assert (row.field, row.scope, row.operator) == ("quantity", "basket", operator)
    assert (row.value.kind, row.value.number, row.value.unit) == (
        "quantity",
        "3",
        "piece",
    )
    assert message[row.evidence[0].start : row.evidence[0].end].startswith("quantity")


@pytest.mark.parametrize(
    "suffix,unit",
    [
        ("", "piece"),
        ("piece", "piece"),
        ("pieces", "piece"),
        ("KG", "kg"),
        ("g", "g"),
        ("L", "l"),
        ("ml", "ml"),
    ],
)
def test_quantity_reader_retains_units_and_offsets_for_complete_numbers(suffix, unit):
    message = f"Find apples, quantity no\tmore than 3{suffix}, under $500"
    rows = quantity_comparisons(message)
    assert len(rows) == 1
    row = rows[0]
    assert (row.operator, row.amount, row.unit) == ("lte", "3", unit)
    assert message[row.start : row.end].startswith("quantity")
    assert "under $500" not in message[row.start : row.end]


@pytest.mark.parametrize(
    "number",
    ["1.5", "1,000", "1,23", "1e3", "3unknown", "3piecesXYZ", "3-5", "-3", "+3"],
)
def test_quantity_reader_never_truncates_unhandled_numeric_tokens(number):
    message = f"quantity at most {number}"
    with pytest.raises(ValueError, match="quantity.*whole number"):
        quantity_comparisons(message)
    with pytest.raises(MeaningConflict, match="quantity.*whole number"):
        literal_requirements(message, schema())


def test_quantity_source_spans_mask_money_comparisons_without_changing_budget():
    message = "quantity no more than 3 pieces under $500"
    rows = literal_requirements(message, schema())
    assert [(row.field, row.operator, row.value.number) for row in rows] == [
        ("price", "lt", "500"),
        ("quantity", "lte", "3"),
    ]
    quoted = 'Find "quantity under 3 pieces", quantity at least 5 pieces'
    quantities = quantity_comparisons(quoted)
    assert len(quantities) == 1
    assert (quantities[0].operator, quantities[0].amount) == ("gte", "5")


def test_money_measurement_and_quantity_are_bound_to_separate_types():
    message = (
        "Storage GB no less than 128 GB, quantity at most 3 pieces, price under 500 USD"
    )
    rows = literal_requirements(message, schema())
    assert {
        (
            row.field,
            row.scope,
            row.operator,
            row.value.kind,
            row.value.number,
            row.value.unit,
        )
        for row in rows
    } == {
        ("storage_gb", "product", "gte", "number", "128", None),
        ("quantity", "basket", "lte", "quantity", "3", "piece"),
        ("price", "product", "lt", "money", "500", "USD"),
    }


@pytest.mark.parametrize("quote", ['"', "curly"])
def test_quoted_product_identity_does_not_generate_numeric_requirements(quote):
    name = "Storage GB at least 128 GB quantity under 3 pieces"
    message = f'Find "{name}"' if quote == '"' else f"Find “{name}”"
    assert not numeric_constraints(message, schema())
    assert not literal_requirements(message, schema())


def test_no_more_than_does_not_become_embedded_more_than():
    rows = literal_requirements("Find phones no more than $500", schema())
    assert [(row.field, row.operator, row.value.number) for row in rows] == [
        ("price", "lte", "500")
    ]
    with pytest.raises(MeaningConflict, match="negated price"):
        literal_requirements("Find phones not above $500", schema())
