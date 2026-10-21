"""Direct reorder transport retained for the registry; live chat uses review only.

Only the gateway's command-bound capability can place an order. Uncertain
outcomes must never be retried here or reported as a confirmed rejection.
"""

import httpx

from app.commerce_action_engine.actions.shopping.reorder import (
    ReorderRejected,
    ReorderUncertain,
)
from app.commerce_action_engine.contracts import AssistantOrder

ERRORS = {
    "REORDER_ADDRESS_REQUIRED": "The original delivery address is no longer available. Please save a delivery address before ordering again.",
    "REORDER_ADDRESS_CHANGED": "The saved address has changed since that order. I need you to confirm the delivery address before I can reorder.",
    "REORDER_PRICE_CHANGED": "The currency or total has changed since the original order. I have not placed a new order; the updated price needs your approval.",
    "REORDER_PRODUCT_CHANGED": "A product's options, pack size, or selling unit changed. I have not placed an order; please choose the current product.",
    "REORDER_PAYMENT_REQUIRED": "The original payment method cannot be reused automatically. This flow supports cash on delivery.",
    "REORDER_ITEMS_UNAVAILABLE": "The original items cannot be reordered automatically. No new order was placed.",
    "REORDER_REQUEST_ALREADY_USED": "This request was already used for another order. Please check My orders before trying again.",
    "FULFILLMENT_PLAN_REQUIRED": "Delivery needs a new fulfillment selection before this order can be placed. No new order was placed.",
    "SLOT_SELECTION_REQUIRED": "A delivery slot is required before this order can be placed. No new order was placed.",
}


async def execute(
    client: httpx.AsyncClient, capability: str, number: int
) -> AssistantOrder:
    if not capability:
        raise ReorderRejected(
            "Please sign in and send an explicit command such as ‘buy again order 5’."
        )
    try:
        async with client.stream(
            "POST",
            "/v1/assistant-tools/reorder",
            headers={
                "Authorization": f"Bearer {capability}",
                "X-Commerce-Request": "1",
            },
            json={"order_number": number},
        ) as response:
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > 32768:
                    raise ReorderUncertain()
            if response.status_code in {400, 401, 403, 404, 409, 429}:
                if response.status_code == 404:
                    raise ReorderRejected(
                        "I could not find that order in your account. Please check its order number."
                    )
                if response.status_code in {401, 403}:
                    raise ReorderRejected(
                        "Please sign in with a verified account before ordering again."
                    )
                import json

                try:
                    code = json.loads(data).get("code", "")
                except (ValueError, AttributeError):
                    code = ""
                raise ReorderRejected(
                    ERRORS.get(
                        code,
                        "I could not verify the items, stock, or delivery for this reorder. No new order was placed.",
                    )
                )
            response.raise_for_status()
            return AssistantOrder.model_validate_json(data)
    except (httpx.HTTPError, ValueError) as error:
        raise ReorderUncertain() from error
