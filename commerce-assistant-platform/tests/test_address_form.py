import asyncio
import json
import subprocess
from pathlib import Path
from unittest.mock import Mock

import pytest
from interpretation_helpers import standard_route
from test_enterprise_contracts import context as context  # noqa: PLC0414

from app.commerce_action_engine.application.handlers.customer import location_events
from app.commerce_action_engine.application.interpretation import interpret_resolution
from app.commerce_action_engine.contracts import AssistantEvent
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.language.gate import Resolution


@pytest.mark.parametrize("authenticated", [True, False])
def test_address_request_opens_form_without_commerce_access(authenticated, context):
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    output = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            "import {loadRuntime} from './src/runtime.ts';import {resolve} from './src/engine.ts';console.log(JSON.stringify(resolve(await loadRuntime(),'pls add my new current addresss')));",
        ],
        cwd=engine,
        capture_output=True,
        text=True,
        check=True,
    )
    gate = Resolution.model_validate(json.loads(output.stdout))
    assert standard_route(gate) == "locations"
    decision = interpret_resolution(gate, context)
    assert isinstance(decision.result, InterpretedRequest)
    tools = Mock(side_effect=AssertionError("Opening a form must not access commerce"))
    metadata = {}

    def event(kind, **kwargs):
        return AssistantEvent(
            version="1",
            request_id="00000000-0000-4000-8000-000000000001",
            sequence=0,
            type=kind,
            **kwargs,
        )

    async def collect():
        return [
            e
            async for e in location_events(
                authenticated=authenticated,
                request=decision.result,
                commerce_tools=tools,
                metadata=metadata,
                make_event=event,
            )
        ]

    events = asyncio.run(collect())
    assert len(events) == 1
    assert events[0].code == "open_address_form"
    assert metadata["route_reason"] == "new_address_form"
    tools.assert_not_called()
