"""Address interpretation stays separate from authenticated reads and form saves."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_language_fallback import install_provider, proposal, unknown

from app.commerce_action_engine.application.handlers import customer
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.language import gate
from app.main import create_app

INTENTS = [
    "ACCOUNT_ADDRESS_LIST",
    "ACCOUNT_ADDRESS_ADD",
    "ACCOUNT_ADDRESS_REMOVE",
    "ACCOUNT_ADDRESS_DEFAULT",
]
MESSAGE = "check account settings"


def events_from(response):
    assert response.status_code == 200
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert events[-1]["type"] == "done"
    assert [event["sequence"] for event in events] == list(range(len(events)))
    return events


@pytest.mark.parametrize("after_proposal", [False, True])
@pytest.mark.parametrize("intent", INTENTS)
def test_address_handler_receives_standard_request(
    identity, monkeypatch, after_proposal, intent
):
    config, request_id, headers = identity
    provider = install_provider(monkeypatch, proposal(intent, MESSAGE))
    attempts, received, calls = [], [], []
    original = customer.location_events

    async def observe(**kwargs):
        assert "gate" not in kwargs
        request = kwargs["request"]
        assert isinstance(request, InterpretedRequest)
        assert request.request_id == request_id
        assert request.legacy_intent == intent
        received.append(request)
        async for event in original(**kwargs):
            yield event

    async def resolve(url, text):
        attempts.append(text)
        if after_proposal and len(attempts) == 1:
            return unknown()
        return gate.Resolution(
            status="RESOLVED",
            intent=intent,
            confidence=1,
            message="Understood.",
            primaryIntent="ACCOUNT_ADDRESS_REMOVE"
            if intent == "ACCOUNT_ADDRESS_LIST"
            else "ACCOUNT_ADDRESS_LIST",
        )

    def commerce(request):
        calls.append(request.url.path)
        assert request.method == "GET"
        assert request.headers["authorization"] == "Bearer locations-read"
        return httpx.Response(
            200,
            json=[
                {
                    "label": "Home",
                    "is_default": True,
                    "formatted_address": "Private address",
                }
            ],
        )

    monkeypatch.setattr(gate, "resolve", resolve)
    monkeypatch.setattr(customer, "location_events", observe)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**headers(), "x-commerce-locations-token": "locations-read"},
            json={"request_id": request_id, "message": MESSAGE},
        )
    events = events_from(response)
    assert [event["type"] for event in events] == ["progress", "message.delta", "done"]
    assert len(received) == 1
    assert len(provider.requests) == int(after_proposal)
    assert len(attempts) == 1 + int(after_proposal)
    if intent == "ACCOUNT_ADDRESS_ADD":
        assert calls == []
        assert events[1]["code"] == "open_address_form"
        assert (
            events[1]["text"]
            == "Enter your new delivery address in the form, then save it when you're ready."
        )
    else:
        assert calls == ["/v1/assistant-tools/locations"]
        assert "Home (default): Private address" in events[1]["text"]
        assert ("Review the address in your account" in events[1]["text"]) == (
            intent != "ACCOUNT_ADDRESS_LIST"
        )
    assert provider.closed


@pytest.mark.parametrize("intent", INTENTS)
@pytest.mark.parametrize("case", ["guest", "no_capability", "invalid_interpretation"])
def test_address_no_read_without_admission(identity, monkeypatch, intent, case):
    config, request_id, headers = identity
    provider = install_provider(monkeypatch)

    async def resolve(url, text):
        return gate.Resolution(
            status="RESOLVED",
            intent=intent,
            confidence=1,
            message="",
            entities={"items": "invalid"} if case == "invalid_interpretation" else {},
        )

    monkeypatch.setattr(gate, "resolve", resolve)
    with TestClient(
        create_app(
            config,
            transport=httpx.MockTransport(
                lambda _: pytest.fail("Address request unexpectedly reached commerce")
            ),
        )
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={
                **(headers(sub=None, sid=None) if case == "guest" else headers()),
                **(
                    {"x-commerce-locations-token": "locations-read"}
                    if case != "no_capability"
                    else {}
                ),
            },
            json={"request_id": request_id, "message": MESSAGE},
        )
    events = events_from(response)
    code = (
        "unavailable"
        if case == "invalid_interpretation"
        else "open_address_form"
        if intent == "ACCOUNT_ADDRESS_ADD"
        else "login_required"
        if case == "guest"
        else "unavailable"
    )
    assert any(event.get("code") == code for event in events)
    assert not provider.requests
    assert provider.closed


@pytest.mark.parametrize("authenticated", [False, True])
def test_saved_address_picker_remains_independent_of_interpretation(
    identity, monkeypatch, authenticated
):
    config, request_id, headers = identity
    provider = install_provider(monkeypatch)

    async def forbidden(*args, **kwargs):
        pytest.fail("Saved-address picker must not request language interpretation")

    monkeypatch.setattr(gate, "resolve", forbidden)
    with TestClient(
        create_app(
            config,
            transport=httpx.MockTransport(
                lambda _: pytest.fail("Saved-address picker must not call commerce")
            ),
        )
    ) as client:
        response = client.post(
            "/v1/chat",
            headers=headers() if authenticated else headers(sub=None, sid=None),
            json={"request_id": request_id, "message": "show my saved addresses"},
        )
    events = events_from(response)
    blocks = [block for event in events for block in event.get("blocks", [])]
    assert blocks == ([{"kind": "saved_addresses"}] if authenticated else [])
    assert any(event.get("code") == "login_required" for event in events) == (
        not authenticated
    )
    assert not provider.requests
    assert provider.closed
