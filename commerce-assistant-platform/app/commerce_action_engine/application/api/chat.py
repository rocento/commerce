"""Authenticated chat admission. Business routing belongs to HandleTurn."""

import asyncio
from collections.abc import Awaitable, Callable, Mapping

from anyio import CancelScope
from fastapi import FastAPI, HTTPException, Request

from app.commerce_action_engine.application.api.events import TurnStreamingResponse
from app.commerce_action_engine.application.handle_turn import HandleTurn
from app.commerce_action_engine.application.resources import TurnLease
from app.commerce_action_engine.contracts import AssistantChatInput
from app.commerce_action_engine.platform import Context, Settings, authenticate
from app.commerce_resolution_engine.contracts import ModelError
from app.commerce_resolution_engine.providers import ProviderSettings, StoredSettings

PrepareTurn = Callable[
    [AssistantChatInput, Context, Mapping[str, str], StoredSettings | None, TurnLease],
    Awaitable[HandleTurn],
]


def register_chat(
    app: FastAPI,
    config: Settings,
    managed: ProviderSettings,
    semaphore: asyncio.Semaphore,
    prepare_turn: PrepareTurn,
) -> None:
    @app.post("/v1/chat")
    async def chat(body: AssistantChatInput, request: Request) -> TurnStreamingResponse:
        if not config.enabled:
            raise HTTPException(503, "Assistant is disabled")
        value = request.headers.get("authorization", "")
        if not value.startswith("Bearer "):
            raise HTTPException(401, "Gateway context required")
        context = authenticate(value[7:], config)
        if (
            sum(
                (
                    body.order_id is not None,
                    body.product_id is not None,
                    bool(body.cart_context),
                )
            )
            > 1
        ):
            raise HTTPException(400, "Choose only one conversation context")
        if body.ticket and (
            body.ticket.request_id != body.request_id or context.sub is None
        ):
            raise HTTPException(403, "Ticket context mismatch")
        if context.request_id != body.request_id:
            raise HTTPException(403, "Request context mismatch")
        if body.clarification and body.ticket:
            raise HTTPException(
                400, "Clarification cannot be combined with another journey"
            )
        try:
            # A configured settings store defaults to off. Configuration routes
            # stay available so an administrator can enable it without a restart.
            saved = managed.read()
        except ModelError:
            raise HTTPException(503, "Provider configuration unavailable") from None
        if (saved is not None and not saved.enabled) or (
            managed.path is not None and saved is None
        ):
            raise HTTPException(503, "AI assistant is turned off in System settings")
        if semaphore.locked():
            raise HTTPException(429, "Assistant busy; please retry")
        await semaphore.acquire()
        lease = TurnLease(semaphore)
        try:
            turn = await prepare_turn(
                body, context, dict(request.headers), saved, lease
            )
            return TurnStreamingResponse(turn)
        except BaseException:
            with CancelScope(shield=True):
                await lease.aclose()
            raise
