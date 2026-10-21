"""Opt-in real model acceptance with synthetic, read/propose-only commerce fixtures.

No application database, customer account, cart mutation or checkout is reachable.
Set BASKET_LIVE_KEY_FILE and BASKET_LIVE_MODEL explicitly to enable.
"""

import asyncio
import os
from pathlib import Path

import pytest
from test_baskets import scenario
from test_shopping import product

from app.commerce_resolution_engine.providers.openai import OpenAIProvider


@pytest.mark.skipif(
    not os.getenv("BASKET_LIVE_KEY_FILE") or not os.getenv("BASKET_LIVE_MODEL"),
    reason="Explicit isolated live basket-provider configuration is absent",
)
def test_real_provider_plans_and_refines_without_transaction_permissions():
    async def run():
        provider = OpenAIProvider(
            model=os.environ["BASKET_LIVE_MODEL"],
            api_key=Path(os.environ["BASKET_LIVE_KEY_FILE"]).read_text().strip(),
            timeout=30,
        )
        try:
            products = [
                product(
                    name="Silver necklace",
                    category="Necklaces",
                    attributes=[{"name": "metal", "value": '"silver"'}],
                )
            ]
            _, drafts, calls, _ = await scenario(
                None,
                provider_override=provider,
                products=products,
                message="Propose one silver necklace under USD 150. This is a merchandise-only budget; no substitutions.",
            )
            first = drafts[0]
            assert len(first["selections"]) == 1
            assert first["selections"][0]["required_attributes"]["metal"] == "silver"
            assert first["goal"]["budget"] == "150"
            assert not first["goal"]["unresolved"]
            _, drafts, _, _ = await scenario(
                None,
                provider_override=provider,
                products=products,
                previous=first,
                message="Keep this necklace unchanged.",
            )
            assert (
                first["selections"][0]["product_id"]
                in drafts[0]["goal"]["locked_products"]
            )
            assert drafts[0]["selections"] == first["selections"]
            _, drafts, _, _ = await scenario(
                None,
                provider_override=provider,
                products=products,
                message="Propose one silver necklace under EGP 500, merchandise only.",
            )
            assert drafts[0]["goal"]["currency"] == "EGP"
            assert not drafts[0]["selections"]
            assert drafts[0]["goal"]["unresolved"]
            assert all(
                "/apply" not in path and "/checkout" not in path for _, path in calls
            )
        finally:
            await provider.aclose()

    asyncio.run(run())
