"""Public route behavior for customer reads and support conversations."""

import json
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity  # noqa: F401

from app.commerce_action_engine.adapters.commerce import CommerceTools, ToolUnavailable
from app.commerce_action_engine.contracts import AssistantTicket, AssistantTicketDetail
from app.commerce_action_engine.execution.language import gate as language_gate
from app.main import create_app

ID = UUID(int=42)


def ticket(number=7):
    return AssistantTicket.model_validate(
        {
            "id": str(ID),
            "number": number,
            "subject": "Order question",
            "category": "order_issue",
            "status": "open",
            "priority": "normal",
            "order_id": None,
            "created_at": "2026-09-23T10:00:00Z",
        }
    )


@pytest.mark.parametrize(
    "intent,variant,expected",
    [
        ("VIEW_WISHLIST", "empty", "Your wishlist is empty."),
        ("VIEW_WISHLIST", "normal", "You have 5 saved items"),
        (
            "REMOVE_FROM_WISHLIST",
            "partial",
            "Choose one of the items below to remove it",
        ),
        (
            "VIEW_WISHLIST",
            "unavailable_products",
            "couldn't load their current product details",
        ),
        ("VIEW_WISHLIST", "failure", "Assistant temporarily unavailable"),
        ("ACCOUNT_ADDRESS_LIST", "empty", "You have no saved addresses."),
        ("ACCOUNT_ADDRESS_LIST", "normal", "Home (default): Private address"),
        (
            "ACCOUNT_ADDRESS_ADD",
            "normal",
            "Enter your new delivery address in the form, then save it when you're ready.",
        ),
        ("ACCOUNT_ADDRESS_LIST", "failure", "Assistant temporarily unavailable"),
        ("SUPPORT_TICKET_STATUS", "empty", "You have no support tickets."),
        ("SUPPORT_TICKET_STATUS", "normal", "#10 — Order question (open)"),
        ("SUPPORT_TICKET_CLOSE", "normal", "Open the ticket in Support"),
        ("SUPPORT_TICKET_STATUS", "failure", "Assistant temporarily unavailable"),
        ("SUPPORT_CHAT_HISTORY", "normal", "admin: We are checking."),
        ("SUPPORT_CHAT_HISTORY", "empty", "No messages are available yet."),
        (
            "SUPPORT_CHAT_HISTORY",
            "failure",
            "I couldn’t load that support conversation.",
        ),
        (
            "SUPPORT_CHAT_HISTORY",
            "missing",
            "Please choose one from your support tickets.",
        ),
        ("SUPPORT_CHAT_HISTORY", "invalid", "Please choose it from Support."),
    ],
)
def test_customer_support_reads(identity, monkeypatch, intent, variant, expected):  # noqa: F811
    config, request_id, headers = identity
    calls = []
    entities = (
        {}
        if variant == "missing"
        else {"ticketId": "bad" if variant == "invalid" else str(ID)}
    )

    async def resolve(url, text):
        return language_gate.Resolution(
            status="RESOLVED",
            intent=intent,
            message="Understood.",
            confidence=0.99,
            entities=entities,
        )

    def record(name):
        calls.append(name)
        if variant == "failure":
            raise ToolUnavailable()

    async def wishlist(self):
        record("wishlist")
        return [] if variant == "empty" else [UUID(int=i) for i in range(1, 6)]

    async def product(self, product_id):
        calls.append(f"product:{product_id.int}")
        if variant == "unavailable_products" or (
            variant == "partial" and product_id.int == 1
        ):
            raise ToolUnavailable()
        return {
            "id": str(product_id),
            "image_id": None,
            "name": "Tea",
            "price": "10.00",
            "currency": "USD",
            "in_stock": True,
            "route": f"/products/{product_id}",
            "attributes": [{"name": f"attr{i}", "value": "value"} for i in range(25)],
        }

    async def locations(self):
        record("locations")
        return (
            []
            if variant == "empty"
            else [
                {
                    "label": "Home",
                    "is_default": True,
                    "formatted_address": "Private address",
                }
            ]
        )

    async def support_tickets(self):
        record("support_tickets")
        return [] if variant == "empty" else [ticket(n) for n in range(1, 13)]

    async def support_ticket(self, ticket_id):
        assert ticket_id == ID
        record("support_ticket")
        return AssistantTicketDetail.model_validate(
            {
                "ticket": ticket().model_dump(),
                "messages": []
                if variant == "empty"
                else [
                    {
                        "id": str(ID),
                        "sender": "admin",
                        "body": "We are checking.",
                        "created_at": "2026-09-23T10:05:00Z",
                    }
                ],
                "contact_name": None,
                "contact": None,
            }
        )

    monkeypatch.setattr(language_gate, "resolve", resolve)
    for name, fn in [
        ("wishlist", wishlist),
        ("product", product),
        ("locations", locations),
        ("support_tickets", support_tickets),
        ("support_ticket", support_ticket),
    ]:
        monkeypatch.setattr(CommerceTools, name, fn)

    def unexpected(request):
        pytest.fail(f"Unexpected commerce call: {request.method} {request.url.path}")

    with TestClient(
        create_app(config, transport=httpx.MockTransport(unexpected))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers=headers(),
            json={"request_id": request_id, "message": "check my account request"},
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    text = "".join(event.get("text", "") for event in events)
    assert response.status_code == 200
    assert expected in text
    assert "#11 —" not in text
    assert events[-1]["type"] == "done"
    assert [event["sequence"] for event in events] == list(range(len(events)))
    assert all(event.get("response_source", "R") == "R" for event in events)
    blocks = [block for event in events for block in event.get("blocks", [])]
    if "WISHLIST" in intent:
        assert calls == ["wishlist"] + (
            ["product:1", "product:2", "product:3"]
            if variant not in {"empty", "failure"}
            else []
        )
        if variant in {"normal", "partial"}:
            assert blocks[0]["kind"] == (
                "wishlist_manage"
                if intent == "REMOVE_FROM_WISHLIST"
                else "product_list"
            )
            assert len(blocks[0]["products"]) == (2 if variant == "partial" else 3)
            assert all(
                len(product["attributes"]) == 20 for product in blocks[0]["products"]
            )
            assert [source["product_id"] for source in blocks[0]["sources"]] == [
                product["id"] for product in blocks[0]["products"]
            ]
    elif intent == "ACCOUNT_ADDRESS_ADD":
        assert calls == []
        assert events[1]["code"] == "open_address_form"
    elif intent.startswith("ACCOUNT"):
        assert calls == ["locations"]
    else:
        assert calls == (
            []
            if variant in {"missing", "invalid"}
            else [
                "support_ticket"
                if intent == "SUPPORT_CHAT_HISTORY"
                else "support_tickets"
            ]
        )
    types = ["progress"] + (["progress"] if "WISHLIST" in intent else [])
    types += [
        "error"
        if variant == "failure" and intent != "SUPPORT_CHAT_HISTORY"
        else "message.delta"
    ]
    types += (["content.blocks"] if blocks else []) + ["done"]
    assert [event["type"] for event in events] == types


@pytest.mark.parametrize(
    "intent",
    [
        "VIEW_WISHLIST",
        "REMOVE_FROM_WISHLIST",
        "ACCOUNT_ADDRESS_LIST",
        "SUPPORT_TICKET_STATUS",
        "SUPPORT_CHAT_HISTORY",
    ],
)
def test_customer_support_guests_never_call_tools(identity, monkeypatch, intent):  # noqa: F811
    config, request_id, headers = identity

    async def resolve(url, text):
        return language_gate.Resolution(
            status="RESOLVED",
            intent=intent,
            message="Understood.",
            confidence=0.99,
            entities={"ticketId": str(ID)},
        )

    async def forbidden(*args):
        pytest.fail("Guest read reached commerce")

    monkeypatch.setattr(language_gate, "resolve", resolve)
    for name in (
        "wishlist",
        "product",
        "locations",
        "support_tickets",
        "support_ticket",
    ):
        monkeypatch.setattr(CommerceTools, name, forbidden)
    with TestClient(create_app(config)) as client:
        response = client.post(
            "/v1/chat",
            headers=headers(sub=None, sid=None),
            json={"request_id": request_id, "message": "check my account request"},
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert [event["type"] for event in events] == ["progress", "message.delta", "done"]
    assert events[1]["code"] == "login_required"
