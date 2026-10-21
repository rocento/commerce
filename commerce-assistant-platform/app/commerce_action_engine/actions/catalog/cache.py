"""Bounded conditional cache. A hit always requires fresh authorization and revision validation."""

import time
from collections import OrderedDict
from dataclasses import dataclass


@dataclass(frozen=True)
class Entry:
    revision: str
    body: bytes
    expires: float


class CatalogCache:
    def __init__(self, ttl: float = 15, limit: int = 64):
        self.ttl = ttl
        self.limit = limit
        self.entries: OrderedDict[str, Entry] = OrderedDict()

    def get(self, key: str) -> Entry | None:
        entry = self.entries.get(key)
        if entry is None:
            return None
        if entry.expires <= time.monotonic():
            del self.entries[key]
            return None
        self.entries.move_to_end(key)
        return entry

    def put(self, key: str, revision: str, body: bytes) -> None:
        if not revision or len(revision) > 100 or len(body) > 131072:
            return
        self.entries[key] = Entry(revision, body, time.monotonic() + self.ttl)
        self.entries.move_to_end(key)
        while len(self.entries) > self.limit:
            self.entries.popitem(last=False)
