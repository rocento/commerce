"""Resolution uses injected retrieval/tracing and leaves UI validation outside."""

import asyncio
import subprocess
import sys

import pytest
from pydantic import BaseModel
from test_knowledge import AGENT, WHO, Embeddings, Index, hit
from test_runtime import (
    Data,
    FakeProvider,
    ToolCall,
    ToolPolicy,
    agent,
    calls,
    consume,
    final,
    tool,
)

from app.commerce_action_engine.adapters.runtime_knowledge import RuntimeKnowledge
from app.commerce_action_engine.application.responses import validate_blocks
from app.commerce_action_engine.execution.agents import AgentCatalog
from app.commerce_action_engine.platform.telemetry import (
    TurnTrace,
    phase,
    planning_summary,
    trace_turn,
)
from app.commerce_knowledge_rag import Retriever
from app.commerce_resolution_engine.runtime import AgentRuntime


def test_runtime_import_does_not_load_retrieval_persistence_or_ui_contracts():
    subprocess.run(
        [
            sys.executable,
            "-c",
            """
import app.commerce_resolution_engine.runtime
import sys
for name in sys.modules:
    assert not name.startswith((
        'app.commerce_action_engine', 'app.commerce_orchestration_engine',
        'httpx', 'psycopg', 'pypdf'
    )), name
""",
        ],
        check=True,
    )


@pytest.mark.parametrize("planned", [False, True])
def test_adapter_preserves_approved_sources_and_retrieval_trace(planned):
    async def run():
        runtime = AgentRuntime(
            AgentCatalog((AGENT,)),
            {"test": FakeProvider([final()])},
            retriever=RuntimeKnowledge(
                Retriever(Embeddings(), Index([hit()])),
                record_planning=planning_summary,
            ),
            commerce_planning=planned,
            trace_phase=phase,
        )
        trace = TurnTrace()
        with trace_turn(trace):
            events = [
                e
                async for e in runtime.stream(
                    agent_id="shopper", principal=WHO, message="Return a purchase"
                )
            ]
        assert events[-1].answer.sources
        assert trace.totals["retrieval_count"] == 1
        if planned:
            assert trace.planning is not None

    asyncio.run(run())


def test_runtime_cancellation_closes_retrieval_and_trace_without_model_call():
    async def run():
        started, closed = asyncio.Event(), asyncio.Event()

        class Reader:
            async def retrieve(self, *args, planned):
                started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    closed.set()

        provider = FakeProvider([])
        runtime = AgentRuntime(
            AgentCatalog((AGENT,)),
            {"test": provider},
            retriever=Reader(),
            trace_phase=phase,
        )
        trace = TurnTrace()

        async def consume():
            with trace_turn(trace):
                return [
                    e
                    async for e in runtime.stream(
                        agent_id="shopper", principal=WHO, message="Returns"
                    )
                ]

        task = asyncio.create_task(consume())
        await asyncio.wait_for(started.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert closed.is_set()
        assert provider.requests == []
        assert trace.totals["retrieval_count"] == 1

    asyncio.run(run())


def test_application_still_rejects_opaque_models_outside_the_block_schema():
    class InvalidBlock(BaseModel):
        invented: str

    with pytest.raises(ValueError):
        validate_blocks((InvalidBlock(invented="not a supported block"),))


def test_injected_tool_trace_records_the_same_scoped_read():
    async def run():
        async def read(arguments, principal):
            return Data(value=arguments.key)

        configured = agent(tools=ToolPolicy(allowed=frozenset({"lookup"})))
        provider = FakeProvider(
            [
                calls(ToolCall("read-1", "lookup", {"key": "verified"})),
                final(),
            ]
        )
        runtime = AgentRuntime(
            AgentCatalog((configured,)),
            {"test": provider},
            (tool(read),),
            trace_phase=phase,
        )
        trace = TurnTrace()
        with trace_turn(trace):
            events = await consume(runtime)
        assert events[-1].answer.tool_calls == 1
        assert trace.totals["tool_count"] == 1

    asyncio.run(run())
