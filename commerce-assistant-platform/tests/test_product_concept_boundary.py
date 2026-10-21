"""Generic concept hints must not replace the merchant's full search phrase."""

import json
import subprocess
from pathlib import Path

from test_shopping import interpreted

from app.commerce_action_engine.application.interpretation import shopping_plan
from app.commerce_action_engine.execution.language.gate import Resolution


def test_concept_annotations_preserve_existing_catalog_boundary():
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    messages = [
        "show me Lipton green tea",
        "show me Zorvanta ZX-91 green tea",
        "show me black running shoes under $100",
    ]
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import {loadRuntime} from './src/runtime.ts';import {resolve} from './src/engine.ts';"
                "const c=await loadRuntime();console.log(JSON.stringify(JSON.parse(process.argv[1]).map(t=>resolve(c,t))));"
            ),
            json.dumps(messages),
        ],
        cwd=engine,
        capture_output=True,
        text=True,
        check=True,
    )
    rows = json.loads(result.stdout)
    for message, row, expected in zip(
        messages,
        rows,
        ["lipton green tea", "zorvanta zx-91 green tea", "black running shoes"],
    ):
        assert "product_meaning" in row
        plan = shopping_plan(interpreted(Resolution.model_validate(row)), message)
        assert plan is not None
        assert plan.query == expected
    assert rows[0]["product_meaning"]["raw_product_text"] == "Lipton green tea"
    assert rows[1]["product_meaning"]["product_concept"] == "green tea"
    assert rows[2]["product_meaning"]["attributes"]["color"] == "black"
