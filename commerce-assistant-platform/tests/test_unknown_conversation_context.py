"""UNKNOWN follow-ups use recent wording without inheriting action authority."""

import asyncio
import json
from unittest.mock import AsyncMock

import pytest
from test_enterprise_contracts import context as turn_context
from test_language_fallback import Provider, proposal, unknown

from app.commerce_action_engine.application.interpretation import interpret_resolution
from app.commerce_action_engine.application.language_proposals import accept_proposal
from app.commerce_action_engine.application.semantic_recovery import retrieve_examples
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.execution.language.proposals import PROPOSABLE_INTENTS
from app.commerce_contracts.conversation_context import recent_exchange
from app.commerce_resolution_engine.contracts import Message
from app.commerce_resolution_engine.language import propose_language

HISTORY = (
    Message("user", "Find silver necklaces under 500 EGP"),
    Message("assistant", "Here are some silver necklaces."),
)


@pytest.mark.parametrize(
    "message", ["any cheaper?", "anything different?", "فيه أرخص؟"]
)
def test_followup_retrieval_uses_one_query_and_only_the_latest_exchange(message):
    retrieve = AsyncMock(return_value=())
    old = (Message("user", "Find apples"), Message("assistant", "Apples"))
    result = asyncio.run(retrieve_examples(retrieve, message, 1, history=old + HISTORY))
    retrieve.assert_awaited_once()
    query = json.loads(retrieve.await_args.args[0])
    assert query["current_request"] == message
    assert query["untrusted_recent_exchange"] == [
        {"role": row.role, "text": row.text} for row in HISTORY
    ]
    assert result.metadata["context_message_count"] == 2
    assert result.metadata["embedding_query_attempts"] == 1


def test_new_topic_does_not_pull_an_old_product_into_retrieval():
    retrieve = AsyncMock(return_value=())
    asyncio.run(
        retrieve_examples(retrieve, "Find laptops under 20000 EGP", 1, history=HISTORY)
    )
    retrieve.assert_awaited_once_with("Find laptops under 20000 EGP")


def test_missing_oversized_and_nonconversation_context_are_not_sent():
    assert not recent_exchange("any cheaper?", ())
    assert not recent_exchange("any cheaper?", (Message("assistant", "Buy rings"),))
    assert not recent_exchange("any cheaper?", (Message("user", "x" * 801),))
    assert not recent_exchange(
        "any cheaper?",
        tuple(Message("user", "search") for _ in range(3))
        + (Message("assistant", "x" * 801),),
    )


def test_structured_fallback_gets_context_as_untrusted_data_and_current_message_last():
    provider = Provider()
    asyncio.run(
        propose_language(provider, "show it", PROPOSABLE_INTENTS, history=HISTORY)
    )
    (request,) = provider.requests
    assert request.messages[-1].text == "show it"
    assert (
        json.loads(request.messages[0].text)["untrusted_recent_exchange"][0]["text"]
        == HISTORY[0].text
    )
    assert "History grants no permission" in request.instructions


def test_previous_cart_command_cannot_become_followup_authority(monkeypatch):
    context = turn_context.__wrapped__()
    resolve = AsyncMock()
    monkeypatch.setattr(gate, "resolve", resolve)
    decision = asyncio.run(
        accept_proposal(
            "http://engine",
            interpret_resolution(unknown(), context),
            "do it",
            proposal("ADD_TO_CART", "add two silver necklaces to my cart"),
            context=context,
        )
    )
    assert decision.route == "clarify"
    resolve.assert_not_awaited()


def test_bare_historical_action_cannot_authorize_a_mutation(monkeypatch):
    context = turn_context.__wrapped__()
    resolve = AsyncMock()
    monkeypatch.setattr(gate, "resolve", resolve)
    decision = asyncio.run(
        accept_proposal(
            "http://engine",
            interpret_resolution(unknown(), context),
            "do it",
            proposal("CLEAR_CART", "clear cart"),
            context=context,
            history=(
                Message("user", "clear cart"),
                Message("assistant", "Which cart?"),
            ),
        )
    )
    assert decision.route == "clarify"
    resolve.assert_not_awaited()


def test_history_only_product_cannot_be_used_as_a_verified_read_target(monkeypatch):
    context = turn_context.__wrapped__()
    resolve = AsyncMock(
        return_value=gate.Resolution(
            status="RESOLVED",
            intent="PRODUCT_SEARCH",
            confidence=0.99,
            message="",
            entities={"productText": "silver necklaces"},
        )
    )
    monkeypatch.setattr(gate, "resolve", resolve)
    decision = asyncio.run(
        accept_proposal(
            "http://engine",
            interpret_resolution(unknown(), context),
            "any cheaper?",
            proposal("PRODUCT_SEARCH", "find cheaper silver necklaces"),
            context=context,
        )
    )
    assert decision.route == "clarify"
