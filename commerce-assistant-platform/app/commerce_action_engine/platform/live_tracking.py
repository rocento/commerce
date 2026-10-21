"""Bounded process-local live diagnostics; no database writes or chat backpressure.

The supported deployment runs one Uvicorn worker per demo. Cursors carry a boot
identity so a restart or retention gap is explicit, never silently replayed.
"""

import json
import threading
import time
from collections import deque
from collections.abc import Callable
from typing import Any
from uuid import uuid4

from .tracking import redact_tracking


class LiveFeed:
    def __init__(
        self,
        *,
        max_bytes: int = 4_000_000,
        max_events: int = 512,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.max_bytes, self.max_events, self.clock = max_bytes, max_events, clock
        self.tenants: dict[str, dict[str, Any]] = {}
        self.lock = threading.Lock()

    def _state(self, tenant: str) -> dict[str, Any]:
        now = self.clock()
        for key in list(self.tenants):
            if self.tenants[key]["watch_until"] + 60 < now:
                del self.tenants[key]
        if tenant not in self.tenants:
            if len(self.tenants) >= 8:
                raise ValueError("Live watcher capacity reached")
            self.tenants[tenant] = {
                "boot": str(uuid4()),
                "events": deque(),
                "sequence": 0,
                "bytes": 0,
                "watch_until": now,
            }
        return self.tenants[tenant]

    def publish(self, tenant: str, request_id: str, kind: str, data: object) -> None:
        with self.lock:
            state = self.tenants.get(tenant)
            if not state or state["watch_until"] < self.clock():
                return
            state["sequence"] += 1
            event = {
                "sequence": state["sequence"],
                "request_id": request_id,
                "kind": kind,
                "data": redact_tracking(data),
            }
            size = len(json.dumps(event, ensure_ascii=False).encode())
            if size > 1_200_000:
                event["data"] = {
                    "stage": "live_capture_gap",
                    "data": {"reason": "Live event size limit exceeded"},
                }
                event["kind"] = "stage"
                size = len(json.dumps(event).encode())
            state["events"].append((self.clock(), size, event))
            state["bytes"] += size
            self._trim(state)

    def _trim(self, state: dict[str, Any]) -> None:
        while state["events"] and (
            state["bytes"] > self.max_bytes
            or len(state["events"]) > self.max_events
            or state["events"][0][0] < self.clock() - 60
        ):
            _, size, _ = state["events"].popleft()
            state["bytes"] -= size

    def read(self, tenant: str, cursor: str | None = None) -> dict[str, Any]:
        with self.lock:
            state = self._state(tenant)
            lease_expired = state["watch_until"] < self.clock()
            state["watch_until"] = self.clock() + 15
            self._trim(state)
            after, reset = state["sequence"], False
            if cursor:
                try:
                    boot, number = cursor.split(":")
                    after = int(number)
                    if after < 0:
                        raise ValueError
                except (ValueError, TypeError):
                    raise ValueError("Invalid live cursor") from None
                oldest = (
                    state["events"][0][2]["sequence"]
                    if state["events"]
                    else state["sequence"] + 1
                )
                reset = (
                    lease_expired
                    or boot != state["boot"]
                    or after < oldest - 1
                    or after > state["sequence"]
                )
                if reset:
                    after = (
                        oldest - 1
                        if boot != state["boot"] or after > state["sequence"]
                        else max(after, oldest - 1)
                    )
            events: list[dict[str, Any]] = []
            size = 0
            for _, event_size, event in state["events"]:
                if event["sequence"] <= after:
                    continue
                if len(events) >= 128 or size + event_size > 1_300_000:
                    break
                events.append(event)
                size += event_size
            end = events[-1]["sequence"] if events else state["sequence"]
            return {
                "cursor": f"{state['boot']}:{end}",
                "reset": reset,
                "events": events,
            }


feed = LiveFeed()
