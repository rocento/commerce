"""Read paraphrases use authorized order reads and verified product-fact routes."""

import json
import subprocess
from pathlib import Path

from interpretation_helpers import standard_route

from app.commerce_action_engine.actions.orders import order_read
from app.commerce_action_engine.execution.language.gate import Resolution


def test_actual_read_paraphrases_reach_existing_routes():
    messages = [
        "show me the shipping status of order 456446",
        "please check the delivery status for my order 9382",
        "do you have Search-79738 available?",
        "Have you got copper fasteners available now?",
    ]
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import {loadRuntime} from './src/runtime.ts';"
                "import {resolve} from './src/engine.ts';const c=await loadRuntime();"
                "console.log(JSON.stringify(JSON.parse(process.argv[1]).map(t=>resolve(c,t))));"
            ),
            json.dumps(messages),
        ],
        cwd=engine,
        capture_output=True,
        text=True,
        check=True,
    )
    rows = json.loads(result.stdout)
    resolutions = [Resolution.model_validate(r) for r in rows]
    assert [standard_route(r) for r in resolutions] == [
        "order",
        "order",
        "product_fact",
        "product_fact",
    ]
    for index, number in [(0, 456446), (1, 9382)]:
        read = order_read(messages[index], resolutions[index].entities)
        assert read.number == number and read.tool_name == "order_status_by_number"
    assert resolutions[2].entities["productText"] == "search-79738"
    assert resolutions[3].entities["productText"] == "copper fasteners"
    assert [r.intent for r in resolutions[2:]] == ["CHECK_STOCK", "CHECK_STOCK"]
    assert [r["text"] for r in rows] == messages


def test_order_number_phrases_use_authorized_number_lookup():
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    messages = [
        "order number 2",
        "order id 2",
        "order #2",
        "order 2",
        "show me order number 2",
    ]
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            "import {loadRuntime} from './src/runtime.ts';import {resolve} from './src/engine.ts';const c=await loadRuntime();console.log(JSON.stringify(JSON.parse(process.argv[1]).map(t=>resolve(c,t))));",
            json.dumps(messages),
        ],
        cwd=engine,
        capture_output=True,
        text=True,
        check=True,
    )
    for message, row in zip(messages, json.loads(result.stdout), strict=True):
        resolution = Resolution.model_validate(row)
        assert standard_route(resolution) == "order"
        read = order_read(message, resolution.entities)
        assert read.number == 2
        assert read.tool_name == "order_status_by_number"
