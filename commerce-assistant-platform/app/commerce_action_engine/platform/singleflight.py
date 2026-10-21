"""Short-lived coalescing for identical read-only work; no responses are persisted."""

import asyncio
from collections.abc import Awaitable, Callable


class SingleFlight[T]:
    def __init__(self, limit: int = 128):
        self.limit = limit
        self.tasks: dict[str, asyncio.Task[T]] = {}
        self.waiters: dict[str, int] = {}
        self.lock = asyncio.Lock()

    async def run(self, key: str, operation: Callable[[], Awaitable[T]]) -> T:
        async def invoke() -> T:
            return await operation()

        async with self.lock:
            task = self.tasks.get(key)
            if task is None and len(self.tasks) < self.limit:
                task = asyncio.create_task(invoke())
                self.tasks[key] = task
                self.waiters[key] = 0
            if task is not None:
                self.waiters[key] += 1
        if task is None:
            return await operation()  # Never hold the lock across network IO.
        try:
            return await asyncio.shield(task)
        finally:
            async with self.lock:
                self.waiters[key] -= 1
                if not self.waiters[key]:
                    del self.waiters[key]
                    del self.tasks[key]
                    task.cancel()
                    # Retrieve failures even if the final consumer disconnected.
                    task.add_done_callback(
                        lambda done: None if done.cancelled() else done.exception()
                    )
