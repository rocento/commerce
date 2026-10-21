"""Rich eight-product catalog results do not enlarge model input budgets."""

import asyncio

import pytest
from test_catalog_schema import catalog_schema, schema_attribute
from test_discovery import evidence
from test_shopping import interpreted, product, scenario

from app.commerce_action_engine.actions.catalog import CatalogResult
from app.commerce_action_engine.execution.language.gate import Resolution
from app.commerce_action_engine.shared.errors import RuntimeErrorCode


@pytest.mark.parametrize("oversized", [False, True])
def test_breakfast_discovery_budget(oversized):
    rows = []
    for index in range(8):
        row = product(
            index,
            name=f"Breakfast bread {index}",
            attributes=[{"name": "meal_occasion", "value": '["breakfast"]'}]
            + [
                {"name": f"detail_{n}", "value": "catalog detail " * 8}
                for n in range(8)
            ],
            category_names=["Bakery"] if not oversized else ["x" * 1000] * 20,
        )
        row["discovery"] = evidence(row, rank=index + 1)
        rows.append(row)
    size = len(CatalogResult(products=rows, category=None).model_dump_json())
    assert size > 16000
    assert (size > 131072) == oversized
    run = scenario(
        "pls recomend breakfast",
        {},
        rows,
        catalog_schema_override=catalog_schema(
            "grocery",
            [
                schema_attribute(
                    "meal_occasion",
                    "multiselect",
                    options=["breakfast"],
                    policy="semantic",
                    semantic_role="intended_use",
                )
            ],
        ),
        interpretation=interpreted(
            Resolution(
                status="RESOLVED",
                intent="PRODUCT_RECOMMEND",
                confidence=1.0,
                message="",
                entities={"productText": "products", "catalogPurpose": "breakfast"},
            )
        ),
        commerce_meaning=True,
        commerce_planning=True,
    )
    if oversized:
        with pytest.raises(RuntimeErrorCode, match="tool_unavailable"):
            asyncio.run(run)
    else:
        answer, calls = asyncio.run(run)
        assert "Breakfast bread" in answer.text
        assert any(block.products for block in answer.blocks)
        assert len(calls) == 1
