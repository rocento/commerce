import asyncio

import pytest

from app.commerce_action_engine.platform.singleflight import SingleFlight


def test_singleflight_coalesces_identical_read_operations():
    async def run():
        calls = 0

        async def read():
            nonlocal calls
            calls += 1
            await asyncio.sleep(0)
            return "verified"

        flight = SingleFlight()
        values = await asyncio.gather(*(flight.run("same", read) for _ in range(4)))
        assert values == ["verified"] * 4
        assert calls == 1

    asyncio.run(run())


def test_failure_retry_and_cancellation_do_not_poison_peers():
    async def run():
        flight = SingleFlight()
        started, finish = asyncio.Event(), asyncio.Event()
        calls = 0

        async def read():
            nonlocal calls
            calls += 1
            started.set()
            await finish.wait()
            return "ok"

        first = asyncio.create_task(flight.run("same", read))
        await started.wait()
        peer = asyncio.create_task(flight.run("same", read))
        await asyncio.sleep(0)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        finish.set()
        assert await peer == "ok" and calls == 1
        assert not flight.tasks

        async def failed():
            raise ValueError("failure")

        with pytest.raises(ValueError):
            await flight.run("same", failed)
        assert await flight.run("same", read) == "ok"

    asyncio.run(run())


def test_saturated_registry_does_not_lock_other_consumers():
    async def run():
        flight = SingleFlight(limit=1)
        started, finish = asyncio.Event(), asyncio.Event()

        async def slow():
            started.set()
            await finish.wait()
            return "done"

        first = asyncio.create_task(flight.run("one", slow))
        await started.wait()

        async def overflow():
            # Previously deadlocked: overflow was executed while holding lock.
            finish.set()
            return await flight.run("one", slow)

        assert await asyncio.wait_for(flight.run("two", overflow), 1) == "done"
        assert await first == "done"

    asyncio.run(run())
