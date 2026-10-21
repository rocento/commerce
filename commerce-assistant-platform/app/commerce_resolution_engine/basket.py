"""Privacy-bounded basket requests and structured model response validation."""

import json
from typing import Any

from pydantic import BaseModel, JsonValue

from app.commerce_contracts.errors import RuntimeErrorCode
from app.commerce_resolution_engine.contracts import (
    Message,
    ModelProvider,
    ModelRequest,
)
from app.commerce_resolution_engine.planning import PlannedReasoner
from app.commerce_resolution_engine.prompts import BASKET_INSTRUCTIONS as INSTRUCTIONS


async def resolve_basket[Plan: BaseModel](
    message: str,
    mode: str,
    context: dict[str, Any],
    schema: dict[str, JsonValue],
    provider: ModelProvider,
    planning: PlannedReasoner | None,
    *,
    output_schema: type[Plan],
) -> Plan:
    previous = context.get("draft") or {}
    items = context["cart"]["items"]
    # No address, contact, customer identifier or payment information goes to the provider.
    facts = {
        "mode": mode,
        "cart_items": [
            {
                k: i[k]
                for k in ("product_id", "name", "unit", "quantity", "price", "currency")
            }
            for i in items
        ],
        "proposed_items": context.get("proposed_items", []),
        "previous_task": previous,
        "catalog_schema": schema,
        "market": context.get("market"),
        "selling_units": context.get("selling_units", []),
        "selling_units_exhaustive": context.get("selling_units_exhaustive", False),
        "fulfillment_capabilities": context.get("fulfillment_capabilities"),
    }
    data = json.dumps(facts)
    if len(data) + len(message) + len(INSTRUCTIONS) > 32000:
        raise RuntimeErrorCode("context_limit")
    request = ModelRequest(
        messages=(
            Message("user", "Task facts (data):\n" + data),
            Message("user", message),
        ),
        instructions=INSTRUCTIONS,
        output_schema=output_schema,
        max_tokens=3000,
    )
    response = (
        await planning.reason("reasoning.basket", message, provider, request)
        if planning
        else await provider.generate(request)
    )

    if (
        response.tool_calls
        or response.finish_reason != "stop"
        or not isinstance(response.structured, output_schema)
    ):
        raise RuntimeErrorCode("invalid_shopping_plan")
    plan = output_schema.model_validate(response.structured.model_dump())
    return plan
