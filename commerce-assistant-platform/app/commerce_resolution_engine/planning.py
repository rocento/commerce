"""Model request sizing and structured-response validation, independent of planning state."""

import json
from typing import Protocol

from app.commerce_contracts.errors import RuntimeErrorCode
from app.commerce_resolution_engine.contracts import (
    ModelProvider,
    ModelRequest,
    ModelResponse,
)


class PlannedReasoner(Protocol):
    """An injected owner of planning admission, budgets and operation lifecycle."""

    async def reason(
        self, port: str, message: str, provider: ModelProvider, request: ModelRequest
    ) -> ModelResponse: ...


def request_reservation(request: ModelRequest) -> int:
    # UTF-8 byte reservation is a conservative token bound, including output schema and headroom.
    payload = request.instructions + "".join(m.text for m in request.messages)
    payload += (
        json.dumps(request.output_schema.model_json_schema())
        if request.output_schema
        else ""
    )
    return len(payload.encode("utf-8")) + request.max_tokens + 8192


async def resolve_planned(
    provider: ModelProvider, request: ModelRequest, *, reservation: int
) -> ModelResponse:
    """Call within an admitted session; this function grants no planning permission."""
    response = await provider.generate(request)
    if (
        response.tool_calls
        or response.finish_reason != "stop"
        or response.structured is None
    ):
        raise RuntimeErrorCode("invalid_shopping_plan")
    if response.usage.total_tokens > reservation:
        raise RuntimeErrorCode("planning_provider_usage_exceeded_reservation")
    return response
