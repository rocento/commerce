import asyncio
from unittest.mock import AsyncMock
from uuid import UUID

import pytest
from interpretation_helpers import standard_route
from test_assistant import identity as identity  # noqa: PLC0414 -- pytest fixture
from test_cart_actions import ID, NAME, interpreted, snapshot
from test_shopping import product

from app.commerce_action_engine.actions.catalog.references import exact_products
from app.commerce_action_engine.actions.shopping.cart import execute
from app.commerce_action_engine.application.handlers.comparison import comparison_events
from app.commerce_action_engine.application.handlers.customer import wishlist_events
from app.commerce_action_engine.execution.language.gate import Resolution


def events(kind, **data):
    return {"type": kind, **data}


async def collect(stream):
    return [event async for event in stream]


@pytest.mark.parametrize(
    "intent", ["ADD_TO_CART", "REMOVE_FROM_CART", "ADD_TO_WISHLIST"]
)
@pytest.mark.parametrize("reference", [NAME, "demo-gro-001"])
def test_exact_name_or_sku_executes_requested_action(intent, reference):
    tools = AsyncMock()
    tools.cart.return_value = snapshot()
    tools.search_cart_product.return_value = [
        {"id": ID, "name": NAME, "sku": "DEMO-GRO-001"}
    ]
    tools.change_cart.return_value = snapshot(0)
    resolution = Resolution(
        status="RESOLVED",
        intent=intent,
        confidence=1,
        message="",
        entities={"productText": reference},
    )
    _, _, choices = asyncio.run(
        execute(interpreted(resolution), f"{intent} {reference}", tools)
    )
    if intent == "REMOVE_FROM_CART":
        assert len(choices) == 1 and choices[0]["product_id"] == ID
        tools.change_cart.assert_not_awaited()
        return
    assert not choices
    if intent == "ADD_TO_WISHLIST":
        tools.add_wishlist_item.assert_awaited_once_with(UUID(ID))
    else:
        assert tools.change_cart.await_args.args[0]["product_id"] == ID


@pytest.mark.parametrize("intent", ["ADD_TO_CART", "ADD_TO_WISHLIST"])
def test_partial_purchase_name_suggests_even_when_only_one_candidate(intent):
    tools = AsyncMock()
    tools.cart.return_value = snapshot()
    tools.search_cart_product.return_value = [
        {"id": ID, "name": NAME, "sku": "DEMO-GRO-001"}
    ]
    resolution = Resolution(
        status="RESOLVED",
        intent=intent,
        confidence=1,
        message="",
        entities={"productText": "Gala Apples"},
    )
    text, _, choices = asyncio.run(
        execute(interpreted(resolution), f"{intent} Gala Apples", tools)
    )
    assert choices and "DEMO-GRO-001" in text
    tools.change_cart.assert_not_awaited()
    tools.add_wishlist_item.assert_not_awaited()


def test_duplicate_names_are_not_unique_identities():
    assert (
        len(
            exact_products(
                [{"id": "a", "name": "Tea"}, {"id": "b", "name": "Tea"}], "tea"
            )
        )
        == 2
    )
    assert not exact_products([{"id": "a", "name": "Tea", "sku": "AB-12"}], "AB12")


@pytest.mark.parametrize(
    "reference,removed",
    [("FRUIT-001", True), ("Gala Apples 1kg", True), ("Gala", False)],
)
def test_wishlist_removal_resolves_saved_products_only(reference, removed):
    tools = AsyncMock()
    p = product(1, name="Gala Apples 1kg", sku="FRUIT-001")
    tools.wishlist.return_value = [UUID(p["id"])]
    tools.search_cart_product.return_value = [p]
    result = asyncio.run(
        collect(
            wishlist_events(
                authenticated=True,
                managing=True,
                reference=reference,
                commerce_tools=lambda: tools,
                metadata={},
                make_event=events,
            )
        )
    )
    assert result
    if removed:
        tools.remove_wishlist_item.assert_awaited_once_with(UUID(p["id"]))
    else:
        tools.remove_wishlist_item.assert_not_awaited()
        assert any(e.get("blocks") for e in result)


@pytest.mark.parametrize("partial", [False, True])
def test_comparison_uses_exact_names_and_skus_or_returns_suggestions(partial):
    tools = AsyncMock()
    tools.search_cart_product.side_effect = [
        [product(1, name="Gala Apples 1kg", sku="FRUIT-001")],
        [product(2, name="Bananas 1kg", sku="FRUIT-002")],
    ]
    refs = ["Gala" if partial else "Gala Apples 1kg", "FRUIT-002"]
    request = interpreted(
        Resolution(
            status="RESOLVED",
            intent="PRODUCT_COMPARE",
            confidence=1,
            message="",
            entities={"items": [{"productText": reference} for reference in refs]},
        )
    )
    result = asyncio.run(
        collect(
            comparison_events(
                request=request,
                commerce_tools=lambda: tools,
                make_event=events,
                metadata={},
            )
        )
    )
    kinds = [b["kind"] for e in result for b in e.get("blocks", [])]
    assert kinds == (["product_list"] if partial else ["comparison_table"])


@pytest.mark.parametrize(
    "message,expected",
    [
        ("compare Gala Apples 1kg and FRUIT-002", "comparison_table"),
        ("compare Gala and FRUIT-002", "Choose a product to compare"),
        (
            "remove FRUIT-001 from wishlist",
            "Removed Gala Apples 1kg from your wishlist",
        ),
    ],
)
def test_real_language_routes_names_and_skus_through_sse(
    identity, monkeypatch, message, expected
):
    from fastapi.testclient import TestClient
    from test_bestseller_periods import interpret

    from app.commerce_action_engine.adapters.commerce import CommerceTools
    from app.commerce_action_engine.execution.language import gate as language_gate
    from app.main import create_app

    resolved = interpret(message)

    async def resolve(url, text):
        return resolved

    monkeypatch.setattr(language_gate, "resolve", resolve)
    p = product(1, name="Gala Apples 1kg", sku="FRUIT-001", image_id=None)

    async def search(self, reference):
        return (
            [product(2, name="Bananas 1kg", sku="FRUIT-002")]
            if reference.casefold() == "fruit-002"
            else [p]
        )

    async def wishlist(self):
        return [UUID(p["id"])]

    remove = AsyncMock()
    monkeypatch.setattr(CommerceTools, "search_cart_product", search)
    monkeypatch.setattr(CommerceTools, "wishlist", wishlist)
    monkeypatch.setattr(CommerceTools, "remove_wishlist_item", remove)
    config, request_id, headers = identity
    with TestClient(create_app(config)) as client:
        result = client.post(
            "/v1/chat",
            headers=headers(),
            json={"request_id": request_id, "message": message},
        )
    assert expected in result.text, result.text
    if message.startswith("remove"):
        remove.assert_awaited_once_with(UUID(p["id"]))
    else:
        remove.assert_not_awaited()


def test_compare_picker_preserves_product_routes_and_renders_table(
    identity, monkeypatch
):
    from fastapi.testclient import TestClient
    from test_bestseller_periods import interpret

    from app.commerce_action_engine.adapters.commerce import CommerceTools
    from app.commerce_action_engine.execution.language import gate as language_gate
    from app.main import create_app

    products = [
        product(1, name="Gala Apples 1kg"),
        product(2, name="Strawberries 500g"),
    ]
    routes = ["/products/" + p["id"] for p in products]
    message = "Compare these products: " + " ".join(routes)
    resolved = interpret(message)
    assert standard_route(resolved) == "comparison"
    assert [item["productText"] for item in resolved.entities["items"]] == routes

    async def resolve(url, text):
        return resolved

    async def read(self, product_id):
        return next(p for p in products if p["id"] == str(product_id))

    monkeypatch.setattr(language_gate, "resolve", resolve)
    monkeypatch.setattr(CommerceTools, "product", read)
    config, request_id, headers = identity
    with TestClient(create_app(config)) as client:
        response = client.post(
            "/v1/chat",
            headers=headers(),
            json={"request_id": request_id, "message": message},
        )
    import json

    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert events[-1]["type"] == "done"
    block = next(e for e in events if e["type"] == "content.blocks")["blocks"][0]
    assert block["kind"] == "comparison_table"
    assert set(block) == {"kind", "title", "products", "sources", "rows"}
    assert [p["id"] for p in block["products"]] == [p["id"] for p in products]


@pytest.mark.parametrize("failure", [False, True])
def test_wishlist_clear_verifies_receipt_and_never_changes_cart(failure):
    from app.commerce_action_engine.shared.errors import ToolUnavailable

    tools = AsyncMock()
    ids = [UUID(int=101), UUID(int=102)]
    tools.wishlist.side_effect = [ids, []]
    if failure:
        tools.remove_wishlist_item.side_effect = [None, ToolUnavailable()]
    result = asyncio.run(
        collect(
            wishlist_events(
                authenticated=True,
                managing=True,
                reference="all items",
                commerce_tools=lambda: tools,
                metadata={},
                make_event=events,
            )
        )
    )
    text = " ".join(e.get("text", "") for e in result)
    assert tools.remove_wishlist_item.await_count == 2
    tools.change_cart.assert_not_awaited()
    if failure:
        assert "now empty" not in text and "Some items may" in text
    else:
        assert "now empty" in text and tools.wishlist.await_count == 2


def test_wishlist_clear_requires_login_and_bounds_bulk_work():
    tools = AsyncMock()
    tools.wishlist.return_value = [UUID(int=i + 1) for i in range(101)]
    for authenticated in [False, True]:
        result = asyncio.run(
            collect(
                wishlist_events(
                    authenticated=authenticated,
                    managing=True,
                    reference="all items",
                    commerce_tools=lambda: tools,
                    metadata={},
                    make_event=events,
                )
            )
        )
        tools.remove_wishlist_item.assert_not_awaited()
        assert any(
            "sign in" in e.get("text", "").lower() or "100 items" in e.get("text", "")
            for e in result
        )


def test_wishlist_clear_does_not_claim_success_when_receipt_retains_requested_item():
    tools = AsyncMock()
    saved = UUID(int=101)
    tools.wishlist.side_effect = [[saved], [saved]]
    result = asyncio.run(
        collect(
            wishlist_events(
                authenticated=True,
                managing=True,
                reference="all items",
                commerce_tools=lambda: tools,
                metadata={},
                make_event=events,
            )
        )
    )
    text = " ".join(e.get("text", "") for e in result)
    assert "still saved" in text
    assert "now empty" not in text
