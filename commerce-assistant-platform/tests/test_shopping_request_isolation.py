"""Concurrent per-turn shopping interpretations stay local and cancel independently."""

import asyncio
from functools import partial
from types import SimpleNamespace

import pytest
from test_runtime import AgentCatalog, FakeProvider, agent, principal

from app.commerce_action_engine.contracts.interpretation import (
    Confidence,
    InterpretedRequest,
)
from app.commerce_resolution_engine.contracts import Usage
from app.commerce_resolution_engine.runtime import AgentRuntime


@pytest.mark.parametrize("cancel_first", [False, True])
def test_shared_runtime_does_not_retain_or_cross_request_interpretations(cancel_first):
    async def scenario():
        entered = {name: asyncio.Event() for name in ("shoes", "tea")}
        closed = {name: asyncio.Event() for name in entered}
        release = asyncio.Event()

        def answer(text):
            return SimpleNamespace(
                text=text, usage=Usage(0, 0, 0), calls=0, model="test", blocks=()
            )

        async def configured(*args, **kwargs):
            return answer("configured handler")

        async def bound(*args, interpretation, **kwargs):
            name = interpretation.entities["productText"]
            entered[name].set()
            try:
                await release.wait()
                return answer(name)
            finally:
                closed[name].set()

        provider = FakeProvider([])
        runtime = AgentRuntime(
            AgentCatalog((agent(),)),
            {"test": provider},
            shopping=True,
            shopping_handler=configured,
        )

        async def collect(handler=None):
            return [
                event
                async for event in runtime.stream(
                    agent_id="shopper",
                    principal=principal(),
                    message="find products",
                    shopping_handler=handler,
                )
            ]

        tasks = []
        for number, name in enumerate(entered, start=1):
            interpretation = InterpretedRequest(
                request_id=f"00000000-0000-0000-0000-{number:012d}",
                status="RESOLVED",
                legacy_intent="PRODUCT_SEARCH",
                confidence=Confidence(raw=1.0),
                message="",
                entities={"productText": name},
            )
            tasks.append(
                asyncio.create_task(
                    collect(partial(bound, interpretation=interpretation))
                )
            )
        try:
            async with asyncio.timeout(2):
                await asyncio.gather(*(event.wait() for event in entered.values()))
                if cancel_first:
                    tasks[0].cancel()
                    with pytest.raises(asyncio.CancelledError):
                        await tasks[0]
                    assert closed["shoes"].is_set()
                    assert not closed["tea"].is_set()
                release.set()
                tea = await tasks[1]
                assert tea[-1].answer.text == "tea"
                if not cancel_first:
                    shoes = await tasks[0]
                    assert shoes[-1].answer.text == "shoes"
                assert (await collect())[-1].answer.text == "configured handler"
                assert runtime.shopping_handler is configured
                assert not provider.requests
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    asyncio.run(scenario())
