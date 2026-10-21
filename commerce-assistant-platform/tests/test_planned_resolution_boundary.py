"""Planning lifecycle and model validation remain independent after extraction."""

import asyncio
import subprocess
import sys

import pytest
from test_commerce_planning import PORTS, WHO

from app.commerce_action_engine.actions.catalog import CatalogResult, SchemaArgs
from app.commerce_action_engine.actions.shopping import ShoppingIntent
from app.commerce_action_engine.execution.planning.runtime import PlanningSession
from app.commerce_action_engine.shared.errors import RuntimeErrorCode as LegacyError
from app.commerce_contracts.errors import RuntimeErrorCode
from app.commerce_resolution_engine.contracts import (
    Message,
    ModelRequest,
    ModelResponse,
    Usage,
)
from app.commerce_resolution_engine.planning import request_reservation


def setup():
    session = PlanningSession("discovery", WHO, PORTS, prices=(1, 1))
    session.start("catalog.get_catalog_schema", SchemaArgs())
    session.finish(CatalogResult(products=[], category=None))
    request = ModelRequest(
        messages=(Message("user", "coffee"),),
        max_tokens=100,
        output_schema=ShoppingIntent,
    )
    return session, request


def test_planned_resolution_imports_without_action_engine_or_infrastructure():
    subprocess.run(
        [
            sys.executable,
            "-c",
            """
import app.commerce_resolution_engine.planning
import sys
for name in sys.modules:
    assert not name.startswith(('app.commerce_action_engine', 'app.commerce_orchestration_engine', 'psycopg', 'httpx')), name
""",
        ],
        check=True,
    )
    assert RuntimeErrorCode is LegacyError


@pytest.mark.parametrize(
    "failure", ["missing_result", "excess_usage", "wrong_schema", "provider"]
)
def test_failed_model_calls_stop_the_session_and_retain_reservation(failure):
    async def run():
        session, request = setup()
        reserved = request_reservation(request)

        class Provider:
            async def generate(self, request):
                assert session.active is not None
                assert session.tokens == reserved
                assert session.cost_micros > 0
                if failure == "provider":
                    raise OSError("provider unavailable")
                return ModelResponse(
                    text="",
                    tool_calls=(),
                    structured=None
                    if failure == "missing_result"
                    else CatalogResult(products=[], category=None),
                    usage=Usage(1, 1, reserved + 1 if failure == "excess_usage" else 2),
                    model="fake",
                    finish_reason="stop",
                )

        expected = OSError if failure == "provider" else RuntimeErrorCode
        with pytest.raises(expected):
            await session.reason("reasoning.shopping", "coffee", Provider(), request)
        assert session.failed
        assert session.active is None
        assert session.tokens == reserved
        assert session.cost_micros > 0

    asyncio.run(run())


def test_success_records_completion_and_returns_the_original_model_response():
    async def run():
        session, request = setup()
        response = ModelResponse(
            text="",
            tool_calls=(),
            structured=ShoppingIntent(shopping=True, query="coffee"),
            usage=Usage(1, 1, 2),
            model="fake",
            finish_reason="stop",
        )

        class Provider:
            async def generate(self, request):
                return response

        result = await session.reason(
            "reasoning.shopping", "coffee", Provider(), request
        )
        assert result is response
        assert not session.failed and session.active is None
        node = next(
            n
            for n in session.plan.nodes
            if "reasoning.shopping" in session.library.skill(n.skill).ports
        )
        assert session.completed[node.id] == 1
        assert session.tokens == request_reservation(request)

    asyncio.run(run())


@pytest.mark.parametrize("cancel", [False, True])
def test_timeout_and_cancellation_close_the_active_step(cancel):
    async def run():
        session, request = setup()
        started = asyncio.Event()
        closed = asyncio.Event()
        if not cancel:
            session.operation_timeout = lambda: 0.01

        class Provider:
            async def generate(self, request):
                started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    closed.set()

        task = asyncio.create_task(
            session.reason("reasoning.shopping", "coffee", Provider(), request)
        )
        await asyncio.wait_for(started.wait(), 1)
        if cancel:
            task.cancel()
        with pytest.raises(asyncio.CancelledError if cancel else TimeoutError):
            await task
        assert closed.is_set()
        assert session.failed and session.active is None
        assert session.tokens == request_reservation(request)

    asyncio.run(run())
