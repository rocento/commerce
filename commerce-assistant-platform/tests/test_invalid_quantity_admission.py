"""Actual language results must never reach commerce tools with invalid quantities."""

import asyncio
import json
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock

from interpretation_helpers import standard_route
from test_cart_actions import interpreted

from app.commerce_action_engine.actions.shopping.cart import execute
from app.commerce_action_engine.execution.language.gate import Resolution


def test_invalid_quantity_results_clarify_and_never_call_commerce():
    messages = [f"add {q} apples to my cart" for q in ["-7", "5.5", "0", "1000001"]]
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
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
    for text, raw in zip(messages, json.loads(result.stdout), strict=True):
        resolution = Resolution.model_validate(raw)
        assert (
            resolution.status == "NEEDS_CONTEXT"
            and standard_route(resolution) == "clarify"
        )
        tools = AsyncMock()
        answer, cart, products = asyncio.run(
            execute(interpreted(resolution), text, tools)
        )
        assert answer and cart is None and products == []
        assert tools.mock_calls == []
