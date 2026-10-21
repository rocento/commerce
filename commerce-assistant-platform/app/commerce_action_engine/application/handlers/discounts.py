"""Present only verified, currently applicable catalog discounts."""

from collections.abc import AsyncGenerator

from app.commerce_action_engine.actions.catalog.discounts import DiscountReader
from app.commerce_action_engine.application.ports import EventFactory
from app.commerce_action_engine.application.responses import card, catalog_block
from app.commerce_action_engine.contracts import AssistantEvent
from app.commerce_action_engine.platform import phase


async def discount_events(
    reader: DiscountReader, make_event: EventFactory
) -> AsyncGenerator[AssistantEvent, None]:
    yield make_event("progress", stage="catalog")
    with phase("tool"):
        result = await reader.discounts()
    scope = (
        "across all eligible catalog products"
        if result.candidate_limit is None
        else f"among up to {result.candidate_limit} checked products"
    )
    if result.offers:
        cards = []
        for row in result.offers:
            o = row.offer
            product = row.product.model_copy(update={"price": str(o.discounted_price)})
            cards.append(
                card(
                    product,
                    [
                        f"Save {o.discount_percent:.2f}% ({o.savings:f} {o.currency})",
                        f"Original price: {o.original_price:f} {o.currency}",
                    ],
                    [],
                ).model_copy(update={"original_price": str(o.original_price)})
            )
        block = catalog_block(
            "recommendation_group", cards, "Current catalog discounts"
        )
        yield make_event(
            "content.blocks", blocks=[block.model_dump(mode="json", exclude_unset=True)]
        )
        text = f"Here are the highest percentage discounts {scope}, using currently active catalog promotions for one unit. Shown prices include that catalog discount. Coupons, cart-level offers, tax and delivery are excluded; checkout confirms the final price."
    else:
        text = f"I found no eligible catalog discounts {scope} right now. Coupons and cart-level offers are separate and may apply at checkout."
    yield make_event("message.delta", text=text)
