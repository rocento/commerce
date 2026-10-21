"""Commerce read reservations survive facade recreation but never cross turns."""

import asyncio
import importlib
from dataclasses import replace

import httpx
import pytest
from test_assistant import identity  # noqa: F401 -- shared authentication fixture
from test_assistant import test_order_card_grounding_and_sse as order_journey
from test_planned_commerce_adapter import DATA

from app.commerce_action_engine.adapters.commerce import CommerceTools
from app.commerce_action_engine.adapters.read_budget import CommerceReadBudget
from app.commerce_action_engine.shared.errors import ToolUnavailable


@pytest.mark.parametrize("planning", [False, True])
def test_turn_factory_shares_budget_and_new_turn_starts_fresh(
    identity,  # noqa: F811 -- imported pytest fixture
    monkeypatch,
    planning,
):
    bootstrap = importlib.import_module(
        "app.commerce_action_engine.application.bootstrap"
    )
    original = bootstrap.HandleTurn
    budgets = []

    def capture(prepared, body):
        first, second = prepared.commerce_tools(), prepared.commerce_tools()
        assert first is not second
        assert first.calls == second.calls == 0
        first._reserve_read()
        assert first.calls == second.calls == 1
        second._reserve_read()
        assert first.calls == second.calls == 2
        budgets.append(first.read_budget)
        return original(prepared, body)

    monkeypatch.setattr(bootstrap, "HandleTurn", capture)
    config, request_id, headers = identity
    config = replace(
        config, feature_flags=frozenset({"commerce_planning"} if planning else ())
    )
    for _ in range(2):
        order_journey((config, request_id, headers))
    assert len(budgets) == 2 and budgets[0] is not budgets[1]
    assert all(budget.calls > 2 for budget in budgets)


@pytest.mark.parametrize("failure", [None, "timeout", "cancelled"])
def test_mixed_facades_share_attempts_and_stop_before_fifth_http_request(failure):
    async def run():
        requests = []

        async def backend(request):
            requests.append(request)
            if len(requests) == 1 and failure == "timeout":
                raise httpx.ReadTimeout("test timeout", request=request)
            if len(requests) == 1 and failure == "cancelled":
                raise asyncio.CancelledError()
            kind = "delivery" if request.url.path.endswith("delivery") else "cart"
            return httpx.Response(200, json=DATA[kind])

        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(backend)
        ) as client:
            budget = CommerceReadBudget()
            first = CommerceTools(
                client, "", cart_capability="cart", read_budget=budget
            )
            second = CommerceTools(
                client, "", catalog_capability="catalog", read_budget=budget
            )
            if failure:
                error = (
                    asyncio.CancelledError
                    if failure == "cancelled"
                    else ToolUnavailable
                )
                with pytest.raises(error):
                    await first.cart()
            else:
                await first.cart()
            await second.delivery()
            await first.cart()
            await second.delivery()
            with pytest.raises(ToolUnavailable):
                await first.cart()
            assert first.calls == second.calls == 5
            assert len(requests) == 4

    asyncio.run(run())
