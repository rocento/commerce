"""Health, configuration and metrics transport endpoints."""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Annotated
from uuid import UUID

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.commerce_action_engine.application.baseline import Baseline
from app.commerce_action_engine.contracts import (
    AssistantAcceptance,
    AssistantAcceptanceInput,
    AssistantReadiness,
)
from app.commerce_action_engine.platform import Settings, Store, authenticate
from app.commerce_resolution_engine.chat import verify_connection
from app.commerce_resolution_engine.contracts import ModelError
from app.commerce_resolution_engine.providers import (
    ProviderInput,
    ProviderSettings,
    ProviderStatus,
)


class HealthResponse(BaseModel):
    status: str = "ok"


def register_system(
    app: FastAPI,
    config: Settings,
    managed: ProviderSettings,
    settings_lock: asyncio.Lock,
    baseline: Baseline,
    store: Store | None,
    runtime_ready: Callable[[], bool],
    language_ready: Callable[[], Awaitable[str]],
) -> None:
    @app.middleware("http")
    async def limits(request: Request, call_next):  # type: ignore[no-untyped-def]
        if request.method == "POST":
            # Bound actual chunks, including requests without Content-Length.
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 16384:
                    return JSONResponse(
                        {"detail": "Request too large"}, status_code=413
                    )
            request._body = bytes(body)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, error: RequestValidationError):  # type: ignore[no-untyped-def]
        if request.url.path.startswith("/v1/provider-settings"):
            # FastAPI's default validation response includes the original input.
            return JSONResponse(
                {
                    "detail": "Invalid provider settings. Check the model and API key fields."
                },
                status_code=422,
            )
        return await request_validation_exception_handler(request, error)

    def authorize_settings(request: Request, scope: str) -> None:
        if not config.enabled:
            raise HTTPException(503, "Assistant service is disabled")
        authenticate(
            request.headers.get("authorization", "").removeprefix("Bearer "),
            config,
            scope,
        )

    @app.get("/v1/provider-settings")
    async def provider_settings(request: Request) -> ProviderStatus:
        authorize_settings(request, "provider_settings_read")
        try:
            return managed.status()
        except ModelError:
            raise HTTPException(503, "Provider settings unavailable") from None

    @app.post("/v1/provider-settings")
    async def save_provider_settings(
        body: ProviderInput, request: Request
    ) -> ProviderStatus:
        authorize_settings(request, "provider_settings_write")
        async with settings_lock:
            try:
                return managed.save(body)
            except ValueError as error:
                raise HTTPException(400, str(error)) from None
            except (ModelError, OSError):
                raise HTTPException(
                    503, "Provider settings storage unavailable"
                ) from None

    @app.post("/v1/provider-settings/test")
    async def test_provider_settings(
        body: ProviderInput, request: Request
    ) -> dict[str, object]:
        authorize_settings(request, "provider_settings_write")
        if settings_lock.locked():
            raise HTTPException(429, "A configuration operation is already running")
        async with settings_lock:
            try:
                candidate = managed.candidate(body.model_copy(update={"enabled": True}))
                test_provider = managed.provider(candidate)
                assert test_provider is not None
                await verify_connection(test_provider)
                return {"ok": True, "message": "OpenAI connection verified."}
            except ValueError as error:
                raise HTTPException(400, str(error)) from None
            except ModelError as error:
                messages = {
                    "authentication": "OpenAI rejected the API key.",
                    "rate_limit": "OpenAI rate limit or quota reached.",
                    "timeout": "OpenAI connection timed out.",
                    "invalid_request": "OpenAI rejected the model or request. Check model access.",
                    "configuration": "Enter a model and API key.",
                }
                return {
                    "ok": False,
                    "message": messages.get(
                        error.code,
                        "Could not verify the OpenAI connection. Check the model and project access.",
                    ),
                }

    @app.get("/v1/provider-settings/readiness")
    async def store_readiness(request: Request) -> AssistantReadiness:
        authorize_settings(request, "provider_settings_read")
        storage_ready = False
        if store:
            try:
                storage_ready = await store.ready()
            except Exception:  # noqa: BLE001 -- dependency boundary
                logging.getLogger("assistant").warning(
                    "assistant_readiness_storage_unavailable"
                )
        return await baseline.readiness(
            request.app.state.commerce,
            request.headers.get("x-commerce-catalog-token", ""),
            storage_ready,
        )

    @app.post("/v1/provider-settings/acceptance")
    async def store_acceptance(
        body: AssistantAcceptanceInput, request: Request
    ) -> AssistantAcceptance:
        authorize_settings(request, "provider_settings_write")
        context = authenticate(
            request.headers.get("authorization", "").removeprefix("Bearer "),
            config,
            "provider_settings_write",
        )
        if not body.query.strip():
            raise HTTPException(400, "Enter a known catalog product to test")
        if settings_lock.locked():
            raise HTTPException(429, "A configuration operation is already running")
        async with settings_lock:
            try:
                return await baseline.accept(
                    request.app.state.commerce,
                    request.headers.get("x-commerce-catalog-token", ""),
                    body.query.strip(),
                    context.request_id,
                )
            except OSError:
                raise HTTPException(503, "Acceptance storage unavailable") from None

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse()

    @app.get("/ready")
    async def ready() -> JSONResponse:
        if not config.enabled:
            return JSONResponse({"status": "disabled"}, status_code=503)

        async def storage_state() -> str:
            if not store:
                return "not_configured"
            try:
                async with asyncio.timeout(1.5):
                    return "ready" if await store.ready() else "unavailable"
            except Exception:  # noqa: BLE001 -- dependency boundary
                return "unavailable"

        language, storage = await asyncio.gather(language_ready(), storage_state())
        dependencies_ready = language == "ready" and storage != "unavailable"
        try:
            provider_status = managed.status()
            model_ready = (
                provider_status.enabled and provider_status.key_configured
                if provider_status.source == "admin"
                else runtime_ready()
            )
        except ModelError:
            model_ready = False
        return JSONResponse(
            {
                "status": "ready" if dependencies_ready else "unavailable",
                "components": {"language": language, "storage": storage},
                "mode": "grounded-commerce",
                "recommendations": "catalog-backed"
                if model_ready
                else "model-unavailable",
            },
            status_code=200 if dependencies_ready else 503,
        )

    @app.post("/v1/metrics/ack")
    async def acknowledge_metrics(
        request: Request, ids: Annotated[list[UUID], Body(max_length=256)]
    ) -> HealthResponse:
        if not config.enabled or not store:
            raise HTTPException(503, "Metrics unavailable")
        context = authenticate(
            request.headers.get("authorization", "").removeprefix("Bearer "),
            config,
            "metrics",
        )
        try:
            await store.acknowledge_metrics(context.tenant, ids)
            return HealthResponse()
        except Exception:  # noqa: BLE001 -- dependency boundary
            raise HTTPException(503, "Metrics unavailable") from None

    @app.get("/v1/metrics")
    async def metrics(request: Request) -> list[dict[str, object]]:
        if not config.enabled or not store:
            raise HTTPException(503, "Metrics unavailable")
        context = authenticate(
            request.headers.get("authorization", "").removeprefix("Bearer "),
            config,
            "metrics",
        )
        try:
            return await store.metrics(context.tenant)
        except Exception:  # noqa: BLE001 -- datastore errors stay private
            raise HTTPException(503, "Metrics unavailable") from None
