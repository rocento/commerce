"""Real language output drives verified descending-price selection."""

import asyncio
import json
import subprocess
from pathlib import Path

import pytest
from test_shopping import interpreted, product, scenario

from app.commerce_action_engine.execution.language import gate as language_gate


@pytest.mark.parametrize(
    "message",
    [
        "what is highest item in store",
        "pls recommend higest price item",
        "show most expensive product",
    ],
)
def test_highest_price_question_uses_catalog_sort(message):
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            "import {loadRuntime} from './src/runtime.ts'; import {resolve} from './src/engine.ts';console.log(JSON.stringify(resolve(await loadRuntime(),process.argv[1])));",
            message,
        ],
        cwd=engine,
        capture_output=True,
        text=True,
        check=True,
    )
    resolution = language_gate.Resolution.model_validate(json.loads(result.stdout))
    assert resolution.status == "RESOLVED"
    assert resolution.entities["sort_by"] == "price_desc"
    interpretation = interpreted(resolution)
    answer, calls = asyncio.run(
        scenario(
            message,
            {},
            [product(1, price="5"), product(2, price="99"), product(3, price="12")],
            interpretation=interpretation,
        )
    )
    assert calls[0]["arguments"]["query"] == "*"
    cards = [p for block in answer.blocks for p in block.products or []]
    assert [p.price for p in cards] == ["99", "12", "5"]
    assert answer.usage.input_tokens == 0
    assert "Highest-priced matches checked" in str(answer.blocks)
    assert "Among the products I checked" in answer.text
    assert "highest to lowest price" in answer.text
    assert "bounded candidate" not in answer.text
