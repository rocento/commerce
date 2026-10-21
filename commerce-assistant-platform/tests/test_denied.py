"""Only explicit authorization failures become DENIED; never retry them."""

import asyncio
import json
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient
from interpretation_helpers import standard_route
from test_assistant import identity as identity  # noqa: PLC0414 -- pytest fixture

from app.commerce_action_engine.adapters.commerce import CommerceTools
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable
from app.main import create_app


@pytest.mark.parametrize(
    "method,args",
    [
        ("cart", ()),
        ("change_cart", ({"action": "clear"},)),
        ("wishlist", ()),
        ("remove_wishlist_item", (UUID(int=1),)),
        ("add_wishlist_item", (UUID(int=1),)),
        ("product", (UUID(int=1),)),
        ("search_cart_product", ("apple",)),
        ("orders", ()),
        ("order_by_number", (1,)),
        ("locations", ()),
        ("delivery", ()),
        ("support_tickets", ()),
        ("support_ticket", (UUID(int=1),)),
        ("call", ("order_status", {"order_id": str(UUID(int=1))})),
    ],
)
def test_commerce_403_is_denied_without_retry(method, args):
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(403, text="SECRET permission policy body")

    async def run():
        async with httpx.AsyncClient(
            base_url="https://commerce", transport=httpx.MockTransport(respond)
        ) as client:
            tools = CommerceTools(
                client,
                "token",
                cart_capability="token",
                catalog_capability="token",
                wishlist_capability="token",
                locations_capability="token",
                support_capability="token",
                cart_write_capability="token",
                wishlist_write_capability="token",
            )
            with pytest.raises(ToolDenied) as caught:
                await getattr(tools, method)(*args)
            assert "SECRET" not in caught.value.message

    asyncio.run(run())
    assert len(requests) == 1


@pytest.mark.parametrize("status", [401, 404, 429, 500])
def test_other_http_failures_are_not_misclassified_as_denied(status):
    async def run():
        async with httpx.AsyncClient(
            base_url="https://commerce",
            transport=httpx.MockTransport(lambda request: httpx.Response(status)),
        ) as client:
            with pytest.raises(ToolUnavailable):
                await CommerceTools(client, "token").orders()

    asyncio.run(run())


@pytest.mark.parametrize("shopping_mode", [None, "shop"])
def test_authoritative_denial_finishes_chat_without_retry(
    identity, monkeypatch, shopping_mode
):
    config, request_id, headers = identity

    async def resolve(url, text):
        return gate.Resolution(
            status="RESOLVED",
            intent="ORDER_HISTORY",
            confidence=0.99,
            message="Understood.",
        )

    monkeypatch.setattr(gate, "resolve", resolve)
    requests = []

    def forbidden(request):
        requests.append(request)
        assert request.url.path == "/v1/assistant-tools/orders"
        return httpx.Response(403, text="SECRET internal policy")

    body = {"request_id": request_id, "message": "show my orders"}
    if shopping_mode:
        body.update(shopping_mode=shopping_mode, conversation_id=request_id)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(forbidden))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**headers(), "x-commerce-tool-token": "token"},
            json=body,
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert events[-1]["type"] == "done"
    assert "your current access does not allow it" in response.text
    assert "SECRET" not in response.text
    assert not any(event["type"] in {"error", "card.order"} for event in events)
    assert len(requests) == 1


def test_denied_precedes_forged_actions_and_clarification():
    result = gate.Resolution(
        status="DENIED",
        intent="ADD_TO_CART",
        confidence=0,
        message="ignored",
        operations=["ADD_ITEM"],
        missing=["productReference"],
    )
    assert standard_route(result) == "denied"


@pytest.mark.parametrize("selection", ["ALL_SAVED", "RANDOM_SAVED"])
def test_denied_bulk_transfer_propagates_without_partial_success_or_retry(selection):
    from test_wishlist_transfer import SelectionTools, select_transfer

    class DeniedTransfer(SelectionTools):
        attempts = 0

        async def transfer_wishlist_to_cart(self, product_ids):
            self.attempts += 1
            raise ToolDenied()

    tools = DeniedTransfer()
    with pytest.raises(ToolDenied) as caught:
        select_transfer(tools, selection)
    assert tools.attempts == 1
    assert not tools.writes and not tools.removals
    assert caught.value.completed_action is None


def test_named_transfer_denial_preserves_completed_step():
    from test_wishlist_transfer import Tools, run_transfer

    class DeniedRemoval(Tools):
        async def remove_wishlist_item(self, product_id):
            raise ToolDenied()

    with pytest.raises(ToolDenied) as caught:
        run_transfer(DeniedRemoval())
    assert caught.value.completed_action == "cart_add"


def test_catalog_denial_survives_shopping_wrapper_without_model_call():
    from app.commerce_action_engine.application.catalog import registry
    from app.commerce_action_engine.application.shopping import shopping_answer
    from app.commerce_action_engine.execution.agents import Principal, default_agents

    class NoModel:
        async def generate(self, request):
            pytest.fail("Denied catalog request reached the model")

    async def run():
        tenant = UUID(int=1)
        principal = Principal(tenant=tenant, persona="shopper")
        async with httpx.AsyncClient(
            base_url="https://commerce",
            transport=httpx.MockTransport(lambda request: httpx.Response(403)),
        ) as client:
            tools = {
                tool.definition.name: tool
                for tool in registry(client, "token", principal, {})
            }
            with pytest.raises(ToolDenied):
                await shopping_answer(
                    "find apples",
                    NoModel(),
                    default_agents(tenant).load(tenant, "shopper"),
                    principal,
                    tools,
                )

    asyncio.run(run())
