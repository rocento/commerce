"""One owner for the resources and concurrency slot of an admitted turn."""

import asyncio
from contextlib import AsyncExitStack


class TurnLease:
    def __init__(self, semaphore: asyncio.Semaphore):
        # The caller must acquire the slot before constructing its lease.
        self.resources = AsyncExitStack()
        self._semaphore = semaphore
        self._closed = False

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            await self.resources.aclose()
        finally:
            self._semaphore.release()
