"""SSE wire formatting and transport-owned stream cleanup."""

from collections.abc import AsyncGenerator
from contextlib import aclosing

from anyio import CancelScope
from starlette.responses import StreamingResponse
from starlette.types import Receive, Scope, Send

from app.commerce_action_engine.application.handle_turn import HandleTurn
from app.commerce_action_engine.contracts import AssistantEvent


def serialize_event(event: AssistantEvent) -> str:
    return f"event: {event.type}\ndata: {event.model_dump_json(exclude_unset=True)}\n\n"


class TurnStreamingResponse(StreamingResponse):
    def __init__(self, turn: HandleTurn):
        self.turn = turn
        self._events = self.events()
        super().__init__(
            self._events,
            media_type="text/event-stream",
            headers={"X-Accel-Buffering": "no"},
        )

    async def events(self) -> AsyncGenerator[str, None]:
        async with aclosing(self.turn.run()) as events:
            async for event in events:
                yield serialize_event(event)

    async def stream_response(self, send: Send) -> None:
        try:
            await super().stream_response(send)
        finally:
            # Close in the same producer task that opened context variables.
            # A task-group disconnect must not cancel resource cleanup halfway.
            with CancelScope(shield=True):
                await self._events.aclose()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            with CancelScope(shield=True):
                await self.turn.aclose()
