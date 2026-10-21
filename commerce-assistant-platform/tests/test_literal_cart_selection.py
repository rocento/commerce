import asyncio
from dataclasses import replace
from unittest.mock import AsyncMock
from uuid import UUID

import pytest
from test_assistant import identity as identity  # noqa: PLC0414
from test_enterprise_contracts import context as context  # noqa: PLC0414
from test_language_admission import setup
from test_language_understanding import real_resolve

from app.commerce_action_engine.application import language_admission as admission
from app.commerce_action_engine.application.literal_cart_selection import (
    literal_cart_selection,
)
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.shared.errors import ToolUnavailable

PRODUCT = UUID(int=42)


@pytest.mark.parametrize(
    "name",
    [
        "Silver Twist Ring — US Size 8",
        "Apple iPhone SE (3rd Gen) — 64 GB",
        "Estée Lauder Nutritious Booster Drops Serum",
    ],
)
def test_exact_name_uses_published_cart_admission(identity, context, monkeypatch, name):
    state, ports = setup(identity, context)
    message = f"Add 2 {name} to my cart"
    state.body = state.body.model_copy(update={"message": message})
    lookup = AsyncMock(return_value=[{"id": str(PRODUCT), "name": name}])
    ports = replace(ports, lookup_cart_product=lookup)
    monkeypatch.setattr(gate, "resolve", real_resolve)

    async def scenario():
        try:
            await admission.admit_language(state, ports=ports, history=(), metadata={})
        finally:
            state.close()

    asyncio.run(scenario())
    assert state.body.message == message
    assert state.body.product_id == PRODUCT
    assert state.interpretation.route == "cart_action"
    ports.select_provider.assert_not_called()


@pytest.mark.parametrize(
    "message",
    [
        "Add 1 Serum under $20 to my cart",
        "Add 1 Serum and checkout to my cart",
        "Add 1 unknown product to my cart",
    ],
)
def test_partial_names_and_conditions_are_not_discarded(message):
    lookup = AsyncMock(return_value=[{"id": str(PRODUCT), "name": "Serum"}])
    assert asyncio.run(literal_cart_selection(message, lookup)) is None


def test_duplicate_names_remain_ambiguous():
    lookup = AsyncMock(
        return_value=[{"id": str(UUID(int=i)), "name": "Serum"} for i in (1, 2)]
    )
    assert asyncio.run(literal_cart_selection("Add Serum to my cart", lookup)) is None


def test_unavailable_catalog_does_not_select():
    lookup = AsyncMock(side_effect=ToolUnavailable("unavailable"))
    assert asyncio.run(literal_cart_selection("Add Serum to my cart", lookup)) is None


@pytest.mark.parametrize(
    "message",
    [
        "Do not add Serum to my cart",
        "Add 0 Serum to my cart and checkout",
        "Remove Serum from my cart",
    ],
)
def test_other_commands_do_not_lookup(message):
    lookup = AsyncMock()
    assert asyncio.run(literal_cart_selection(message, lookup)) is None
    lookup.assert_not_awaited()
