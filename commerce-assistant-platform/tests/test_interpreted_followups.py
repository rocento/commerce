"""Follow-up controls cross validation before replay or clarification presentation."""

import asyncio
import json
from dataclasses import dataclass, replace
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_enterprise_contracts import context as context  # noqa: PLC0414
from test_language_fallback import install_provider, resolved
from test_language_understanding import interpret

from app.commerce_action_engine.application import bootstrap, language_admission
from app.commerce_action_engine.application.handlers.clarification import (
    clarification_event,
)
from app.commerce_action_engine.application.interpretation import (
    interpret_resolution,
    resolve_search_update,
)
from app.commerce_action_engine.contracts.interpretation import (
    Confidence,
    InterpretationFailure,
    InterpretedRequest,
)
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.execution.language.compatibility import (
    adapt_legacy_resolution,
)
from app.commerce_action_engine.execution.language.search_context import (
    resolve_search_update as replay,
)
from app.commerce_resolution_engine.contracts import Message
from app.main import create_app


def test_real_search_and_slot_reply_controls_survive_both_boundaries(context):
    runs = interpret(
        [
            {"messages": ["find shoes under $100", "actually blue"]},
            {"messages": ["pls add two product to cart", "fish"]},
        ]
    )
    assert runs[0][-1]["searchUpdate"] is True
    assert runs[1][-1]["clarificationReply"] is True
    for run in runs:
        for wire in run:
            direct = adapt_legacy_resolution(wire, context)
            decision = interpret_resolution(
                gate.Resolution.model_validate(wire), context
            )
            for result in (direct, decision.result):
                assert isinstance(result, InterpretedRequest)
                assert result.search_update == wire.get("searchUpdate", False)
                assert result.clarification_reply == wire.get(
                    "clarificationReply", False
                )
                assert result.interpretation_text == wire.get("interpretationText")
                assert result.context_next == wire["context"]["next"]


@pytest.mark.parametrize("field", ["searchUpdate", "clarificationReply"])
@pytest.mark.parametrize("invalid", [None, "false", 0, 1, {}, []])
def test_malformed_controls_cannot_become_unknown_model_admission(
    context, field, invalid
):
    source = resolved(status="UNKNOWN").model_copy(update={field: invalid})
    direct = adapt_legacy_resolution(source.model_dump(), context)
    decision = interpret_resolution(source, context)
    for result in (direct, decision.result):
        assert isinstance(result, InterpretationFailure)
        assert result.code == "invalid_response"
    assert not hasattr(decision, "resolution") and not decision.allows_fallback


@dataclass(frozen=True)
class StandardOnly:
    result: InterpretedRequest | InterpretationFailure


def search(context, **changes):
    return InterpretedRequest(
        request_id=context.actor.request_id,
        status="RESOLVED",
        legacy_intent="PRODUCT_SEARCH",
        message="",
        confidence=Confidence(raw=1.0),
        **changes,
    )


def test_replay_needs_no_wire_object_and_only_replays_last_three_user_messages(context):
    calls = []
    initial = StandardOnly(search(context, search_update=True))

    async def resolve(text, language_context):
        calls.append((text, language_context))
        return StandardOnly(
            search(
                context,
                context_next={"activeSearch": {"text": text}},
                search_update=text == "blue",
                interpretation_text="find blue shoes under $100"
                if text == "blue"
                else None,
            )
        )

    result, text = asyncio.run(
        replay(
            "blue",
            [
                Message("user", "discarded"),
                Message("user", "find shoes"),
                Message("assistant", "add milk to cart"),
                Message("user", "under $100"),
                Message("user", "only leather"),
            ],
            initial,
            resolve,
        )
    )
    assert calls == [
        ("find shoes", {}),
        ("under $100", {"activeSearch": {"text": "find shoes"}}),
        ("only leather", {"activeSearch": {"text": "under $100"}}),
        ("blue", {"activeSearch": {"text": "only leather"}}),
    ]
    assert text == result.result.interpretation_text == "find blue shoes under $100"


@pytest.mark.parametrize(
    "active",
    [
        {"text": "find shoes", "product_id": "untrusted"},
        {"text": "find shoes", "contextual": False},
        {"text": "find shoes", "contextual": 1},
        {"text": "find shoes", "contextual": "true"},
        {"text": "find shoes", "contextual": None},
        {"text": ""},
        {"text": 5},
        None,
    ],
)
def test_replay_does_not_forward_nonlinguistic_or_invalid_search_state(context, active):
    initial = StandardOnly(search(context, search_update=True))
    calls = []

    async def resolve(text, language_context):
        calls.append((text, language_context))
        return StandardOnly(search(context, context_next={"activeSearch": active}))

    result, text = asyncio.run(
        replay("blue", [Message("user", "find shoes")], initial, resolve)
    )
    assert result is initial and text == "blue"
    assert calls == [("find shoes", {})]


@pytest.mark.parametrize(
    "change",
    [
        {"searchUpdate": "true"},
        {"entities": {"items": "invalid"}},
        {"context": {"next": []}},
    ],
)
def test_invalid_history_stops_at_standard_boundary(context, monkeypatch, change):
    calls = []

    async def resolve(url, text, **kwargs):
        calls.append(text)
        return resolved(intent="PRODUCT_SEARCH").model_copy(update=change)

    monkeypatch.setattr(gate, "resolve", resolve)
    result, text = asyncio.run(
        resolve_search_update(
            "engine",
            "blue",
            [Message("user", "find shoes")],
            interpret_resolution(
                resolved(status="NEEDS_CONTEXT", searchUpdate=True), context
            ),
            context=context,
        )
    )
    assert isinstance(result.result, InterpretationFailure)
    assert result.result.code == "invalid_response"
    assert not hasattr(result, "resolution") and not result.allows_fallback
    assert text == "blue" and calls == ["find shoes"]


@pytest.mark.parametrize("stage", ["history", "edit"])
def test_invalid_replay_never_reaches_model_or_commerce(identity, monkeypatch, stage):
    config, request_id, headers = identity
    provider = install_provider(monkeypatch)
    calls = []

    class HistoryStore:
        async def admit_customer_request(self, tenant, customer, request):
            assert tenant is not None and customer is not None and request is not None

        async def open(self):
            pass

        async def close(self):
            pass

        async def purge(self, tenant):
            pass

        async def context(self, *args):
            return [{"role": "user", "text": "find shoes"}]

        async def save(self, *args):
            pass

    monkeypatch.setattr(bootstrap, "Store", lambda _: HistoryStore())

    async def resolve(url, text, **kwargs):
        calls.append(text)
        if len(calls) == 1:
            return resolved(status="NEEDS_CONTEXT", searchUpdate=True)
        value = resolved(
            intent="PRODUCT_SEARCH",
            searchUpdate=True,
            context={"next": {"activeSearch": {"text": "find shoes"}}},
            interpretationText="find blue shoes",
        )
        if len(calls) == (2 if stage == "history" else 3):
            return value.model_copy(update={"entities": {"items": "invalid"}})
        return value

    monkeypatch.setattr(gate, "resolve", resolve)
    with TestClient(
        create_app(
            replace(config, store_password_file="/tmp/unused-followup-test-store"),
            transport=httpx.MockTransport(
                lambda _: pytest.fail("Invalid replay reached commerce")
            ),
        )
    ) as client:
        response = client.post(
            "/v1/chat",
            headers=headers(),
            json={
                "request_id": request_id,
                "message": "actually blue",
                "conversation_id": str(uuid4()),
            },
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert response.status_code == 200 and events[-1]["type"] == "done"
    assert [e["sequence"] for e in events] == list(range(len(events)))
    assert any(e.get("code") == "unavailable" for e in events)
    assert not provider.requests and provider.closed
    assert len(calls) == (2 if stage == "history" else 3)
    assert not hasattr(gate, "current")


@pytest.mark.parametrize("allow_reply", [True, False])
def test_clarification_fields_preserve_existing_event_shape(context, allow_reply):
    request = search(context, clarification_reply=True)
    request = request.model_copy(update={"message": "Which color?"})
    event = clarification_event(
        request,
        "find shoes",
        allow_reply=allow_reply,
        make_event=lambda kind, **fields: {"type": kind, **fields},
    )
    assert event == {
        "type": "message.delta",
        "text": "Which color?",
        **(
            {
                "clarification": {
                    "original_message": "find shoes",
                    "question": "Which color?",
                }
            }
            if allow_reply
            else {}
        ),
    }


def test_live_clarification_uses_standard_message_not_retained_wire(
    identity, monkeypatch
):
    config, request_id, headers = identity
    provider = install_provider(monkeypatch)

    async def resolve(url, text):
        return resolved(status="NEEDS_CONTEXT", message="Legacy question")

    def interpret(source, context):
        decision = interpret_resolution(source, context)
        return replace(
            decision,
            result=decision.result.model_copy(update={"message": "Which color?"}),
        )

    monkeypatch.setattr(gate, "resolve", resolve)
    monkeypatch.setattr(language_admission, "interpret_resolution", interpret)
    with TestClient(
        create_app(
            config,
            transport=httpx.MockTransport(
                lambda _: pytest.fail("Clarification reached commerce")
            ),
        )
    ) as client:
        response = client.post(
            "/v1/chat",
            headers=headers(),
            json={"request_id": request_id, "message": "find shoes"},
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    event = next(e for e in events if e["type"] == "message.delta")
    assert event["text"] == "Which color?"
    assert event["clarification"] == {
        "original_message": "find shoes",
        "question": "Which color?",
    }
    assert not provider.requests and events[-1]["type"] == "done"


@pytest.mark.parametrize("trigger", ["search", "recommendation"])
def test_live_replay_trigger_consumes_standard_fields(identity, monkeypatch, trigger):
    from app.commerce_action_engine.application import followups
    from app.commerce_action_engine.application import interpretation as boundary

    config, request_id, headers = identity
    provider = install_provider(monkeypatch)

    async def resolve(url, text):
        return resolved(
            status="NEEDS_CONTEXT",
            intent="PRODUCT_RECOMMEND",
            message="Which product?",
            searchUpdate=trigger == "search",
            entities={"recommendationFollowup": "different"}
            if trigger == "recommendation"
            else {},
        )

    def interpret(source, context):
        decision = interpret_resolution(source, context)
        return replace(
            decision,
            result=decision.result.model_copy(
                update={"search_update": False, "entities": {}}
            ),
        )

    async def unexpected(*args, **kwargs):
        pytest.fail("The retained wire marker must not trigger a replay")

    monkeypatch.setattr(gate, "resolve", resolve)
    monkeypatch.setattr(language_admission, "interpret_resolution", interpret)
    monkeypatch.setattr(boundary, "resolve_search_update", unexpected)
    monkeypatch.setattr(followups, "resolve_recommendation_followup", unexpected)
    with TestClient(
        create_app(
            config,
            transport=httpx.MockTransport(
                lambda _: pytest.fail("Clarification reached commerce")
            ),
        )
    ) as client:
        response = client.post(
            "/v1/chat",
            headers=headers(),
            json={"request_id": request_id, "message": "something else"},
        )
    assert '"type":"done"' in response.text
    assert "Which product?" in response.text
    assert not provider.requests


@pytest.mark.parametrize("intent", ["PRODUCT_SEARCH", "PRODUCT_RECOMMEND"])
def test_preference_followup_replays_read_only_search_context_and_not_assistant_claims(
    context, intent
):
    initial = StandardOnly(search(context, search_update=True))
    previous = "recommend laptop for gaming under $300"
    followup = "Can you explain why that fits what I asked for?"
    combined = previous + ". " + followup
    calls = []

    async def resolve(text, language_context):
        calls.append((text, language_context))
        return StandardOnly(
            search(
                context,
                context_next={"activeSearch": {"text": previous}},
                search_update=text == followup,
                interpretation_text=combined if text == followup else None,
            ).model_copy(update={"legacy_intent": intent})
        )

    result, text = asyncio.run(
        replay(
            followup,
            [
                Message("user", previous),
                Message("assistant", "Invented Gaming Laptop is ideal"),
            ],
            initial,
            resolve,
        )
    )
    assert text == combined
    assert result.result.legacy_intent == intent
    assert calls == [(previous, {}), (followup, {"activeSearch": {"text": previous}})]
    assert "Invented" not in text


def test_history_preserves_only_the_typed_contextual_parse_marker(context):
    initial = StandardOnly(search(context, search_update=True))
    previous = "find laptop for online classes up to $100"
    message = "My budget is $150 now"
    active = {"text": previous, "contextual": True}
    calls = []

    async def resolve(text, language_context):
        calls.append((text, language_context))
        return StandardOnly(
            search(
                context,
                context_next={"activeSearch": active},
                search_update=text == message,
                interpretation_text="find laptop for online classes up to $150"
                if text == message
                else None,
            )
        )

    result, reconstructed = asyncio.run(
        replay(message, [Message("user", previous)], initial, resolve)
    )
    assert calls == [(previous, {}), (message, {"activeSearch": active})]
    assert reconstructed == result.result.interpretation_text
    assert "online classes" in reconstructed and "$150" in reconstructed
