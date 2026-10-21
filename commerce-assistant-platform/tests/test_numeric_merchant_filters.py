import pytest
from test_catalog_schema import catalog_schema, schema_attribute
from test_shopping import product

from app.commerce_action_engine.actions.catalog import CatalogSchema, Product
from app.commerce_action_engine.actions.shopping import Constraint, ShoppingIntent
from app.commerce_action_engine.actions.shopping.meaning import (
    apply_meaning,
    verified_products,
)


@pytest.mark.parametrize(
    "kind,raw,number",
    [("integer", "8", 8), ("decimal", "13.6", 13.6), ("measurement", "45 cm", 45)],
)
def test_labeled_numeric_constraints_verify_against_numeric_facts(kind, raw, number):
    schema = CatalogSchema(
        **catalog_schema(
            attributes=[
                schema_attribute(
                    "capacity", kind, unit="cm" if kind == "measurement" else None
                )
            ]
        )
    )
    plan = ShoppingIntent(
        shopping=True, query="*", attributes=[Constraint(name="capacity", value=raw)]
    )
    frame = apply_meaning(plan, "Find products, capacity: " + raw, schema)
    rows = [
        Product.model_validate(
            product(i, attributes=[{"name": "capacity", "value": str(v)}])
        )
        for i, v in enumerate([number, number + 1])
    ]
    assert verified_products(rows, frame) == rows[:1]
    assert frame.requirements[0].value.kind == "number"
