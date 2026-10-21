"""Authenticated history, feedback and insights transport endpoints."""

from collections.abc import Awaitable, Callable
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, ConfigDict
from starlette.responses import JSONResponse, Response

from app.commerce_action_engine.contracts import (
    AssistantFeedback,
)
from app.commerce_action_engine.platform import Settings, Store, authenticate


class DeliveryEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conversation_id: UUID


def register_history(app: FastAPI, config: Settings, store: Store | None) -> None:
    @app.middleware("http")
    async def privacy_admission(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if store and request.url.path in {"/v1/chat", "/v1/delivery-event"}:
            scope = "chat" if request.url.path == "/v1/chat" else "delivery_event"
            try:
                context = authenticate(
                    request.headers.get("authorization", "").removeprefix("Bearer "),
                    config,
                    scope,
                )
                if context.sub is not None:
                    await store.admit_customer_request(
                        context.tenant, context.sub, context.request_id
                    )
            except HTTPException as error:
                return JSONResponse(
                    {"detail": error.detail}, status_code=error.status_code
                )
            except Exception:  # noqa: BLE001 -- keep storage details private
                return JSONResponse(
                    {"detail": "Account storage unavailable"}, status_code=503
                )
        return await call_next(request)

    @app.post("/v1/account-deletion")
    async def account_deletion(request: Request) -> dict[str, bool]:
        context = authenticate(
            request.headers.get("authorization", "").removeprefix("Bearer "),
            config,
            "account_deletion",
        )
        if context.sub is None:
            raise HTTPException(401, "Customer context required")
        if store is None:
            raise HTTPException(503, "Account storage unavailable")
        try:
            await store.erase_customer(context.tenant, context.sub)
        except Exception:  # noqa: BLE001 -- keep storage details private
            raise HTTPException(503, "Account deletion will retry") from None
        return {"deleted": True}

    @app.post("/v1/delivery-event")
    async def delivery_event(body: DeliveryEvent, request: Request) -> dict[str, bool]:
        if not config.enabled or not store:
            raise HTTPException(503, "History unavailable")
        context = authenticate(
            request.headers.get("authorization", "").removeprefix("Bearer "),
            config,
            "delivery_event",
        )
        if context.sub is None:
            raise HTTPException(401, "Sign in required")
        try:
            await store.save(
                context.tenant,
                context.sub,
                body.conversation_id,
                context.request_id,
                "Delivery location selected",
                "Delivery location updated. Product availability has been refreshed. You can continue shopping.",
                metadata={
                    "event_kind": "delivery_location_selected",
                    "response_source": "R",
                },
            )
        except Exception:  # noqa: BLE001 -- keep storage details private  # noqa: BLE001 -- keep storage details private
            raise HTTPException(503, "Confirmation could not be saved") from None
        return {"saved": True}

    @app.get("/v1/history")
    async def history(
        request: Request, conversation_id: UUID | None = None
    ) -> list[dict[str, object]]:
        if not config.enabled or not store:
            raise HTTPException(503, "History unavailable")
        value = request.headers.get("authorization", "")
        context = authenticate(value.removeprefix("Bearer "), config, "history")
        if context.sub is None:
            raise HTTPException(401, "Sign in to view history")
        try:
            return await store.history(context.tenant, context.sub, conversation_id)
        except Exception:  # noqa: BLE001 -- keep storage details private  # noqa: BLE001 -- do not expose database error details
            raise HTTPException(503, "History temporarily unavailable") from None

    @app.post("/v1/feedback")
    async def feedback(body: AssistantFeedback, request: Request) -> dict[str, bool]:
        if not config.enabled or not store:
            raise HTTPException(503, "Feedback unavailable")
        context = authenticate(
            request.headers.get("authorization", "").removeprefix("Bearer "),
            config,
            "feedback",
        )
        if context.sub is None:
            raise HTTPException(401, "Sign in required")
        if not await store.feedback(
            context.tenant, context.sub, body.request_id, body.helpful
        ):
            raise HTTPException(404, "Message unavailable")
        return {"saved": True}

    @app.get("/v1/insights")
    async def insights(request: Request) -> dict[str, object]:
        if not config.enabled or not store:
            raise HTTPException(503, "Insights unavailable")
        context = authenticate(
            request.headers.get("authorization", "").removeprefix("Bearer "),
            config,
            "metrics",
        )
        return await store.insights(context.tenant)
