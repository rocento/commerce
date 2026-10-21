"""Private gateway-only operator reports. Shopper tokens never admit this scope."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import FastAPI, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict

from app.commerce_action_engine.platform import (
    Settings,
    Store,
    authenticate,
    tracking_control,
)
from app.commerce_action_engine.platform.live_tracking import feed


class TrackingInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    enabled: bool


def register_tracking(app: FastAPI, config: Settings, store: Store | None) -> None:
    def admit(request: Request, scope: str = "tracking_read") -> Store:
        context = authenticate(
            request.headers.get("authorization", "").removeprefix("Bearer "),
            config,
            scope,
        )
        if context.sub is not None or context.sid is not None:
            raise HTTPException(403, "Operator context required")
        if store is None:
            raise HTTPException(503, "Assistant tracking storage unavailable")
        return store

    @app.get("/v1/provider-settings/tracking")
    async def capture_settings(request: Request) -> dict[str, object]:
        admit(request)
        return tracking_control.status(config)

    @app.post("/v1/provider-settings/tracking")
    async def update_capture(
        body: TrackingInput, request: Request
    ) -> dict[str, object]:
        admit(request, "provider_settings_write")
        try:
            return tracking_control.save(config, body.enabled)
        except ValueError:
            raise HTTPException(
                409, "Tracking is locked by deployment configuration"
            ) from None
        except OSError:
            raise HTTPException(503, "Tracking settings could not be saved") from None

    @app.get("/v1/tracking")
    async def tracking(
        request: Request,
        limit: int = Query(25, ge=1, le=50),
        hours: int = Query(24, ge=1, le=168),
        outcome: Literal["completed", "unavailable", "disconnected", "denied"]
        | None = None,
        request_id: UUID | None = None,
        cursor: str | None = Query(None, max_length=100),
    ) -> dict[str, object]:
        selected = admit(request)
        before, before_id = None, None
        if cursor:
            try:
                date, ident = cursor.split("|", 1)
                before, before_id = datetime.fromisoformat(date), UUID(ident)
                if before.tzinfo is None:
                    raise ValueError("Missing timezone")
            except ValueError:
                raise HTTPException(422, "Invalid tracking cursor") from None
        try:
            rows = await selected.tracking_list(
                UUID(config.tenant_id),
                limit=limit + 1,
                hours=hours,
                outcome=outcome,
                request_id=request_id,
                before=before,
                before_id=before_id,
            )
        except Exception:  # noqa: BLE001 -- never expose database details
            raise HTTPException(
                503, "Assistant tracking unavailable; check storage migrations"
            ) from None
        more = len(rows) > limit
        rows = rows[:limit]
        next_cursor = (
            f"{rows[-1]['created_at'].isoformat()}|{rows[-1]['request_id']}"
            if more
            else None
        )
        return {
            "capture_enabled": tracking_control.status(config)["enabled"],
            "retention_days": 7,
            "items": rows,
            "next_cursor": next_cursor,
        }

    @app.get("/v1/tracking/live")
    async def live(
        request: Request, cursor: str | None = Query(None, max_length=100)
    ) -> dict[str, object]:
        admit(request)
        try:
            result = feed.read(config.tenant_id, cursor)
        except ValueError:
            raise HTTPException(
                422, "Invalid live cursor or watcher capacity"
            ) from None
        return {**result, "capture_enabled": tracking_control.status(config)["enabled"]}

    @app.get("/v1/tracking/{request_id}")
    async def detail(request_id: UUID, request: Request) -> dict[str, object]:
        selected = admit(request)
        try:
            report = await selected.tracking_report(UUID(config.tenant_id), request_id)
        except Exception:  # noqa: BLE001
            raise HTTPException(503, "Assistant tracking unavailable") from None
        if report is None:
            raise HTTPException(404, "Report was not captured or has expired")
        return report
