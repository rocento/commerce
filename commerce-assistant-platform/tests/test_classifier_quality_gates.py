"""Classifier abstention rules also hold at the untrusted proposal boundary."""

import asyncio
from unittest.mock import AsyncMock

import pytest
from test_enterprise_contracts import context as turn_context

from app.commerce_action_engine.application.interpretation import interpret_resolution
from app.commerce_action_engine.application.language_proposals import accept_proposal
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.execution.language.proposals import (
    permits_reinterpretation,
)
from app.commerce_contracts.language_proposal import LanguageProposal


def proposal(intent: str, canonical: str) -> LanguageProposal:
    return LanguageProposal(
        status="INTERPRETED", intent=intent, canonical_text=canonical
    )


def assert_rejected_before_resolver(monkeypatch, message, value):
    # Even a fresh resolver that claims the action is executable cannot override
    # the shopper's condition or turn a denied desire into an affirmative request.
    resolver = AsyncMock(
        return_value=gate.Resolution(
            status="RESOLVED", intent=value.intent, confidence=1, message=""
        )
    )
    monkeypatch.setattr(gate, "resolve", resolver)
    context = turn_context.__wrapped__()
    original = interpret_resolution(
        gate.Resolution(status="UNKNOWN", confidence=0, message=""), context
    )
    result = asyncio.run(
        accept_proposal("http://engine", original, message, value, context=context)
    )
    assert result.route == "clarify"
    resolver.assert_not_awaited()


@pytest.mark.parametrize(
    "condition",
    [
        "if stock is available",
        "only if stock is available",
        "only when stock is available",
        "provided that stock is available",
        "as long as stock is available",
        "unless stock is unavailable",
    ],
)
@pytest.mark.parametrize("retain_condition", [True, False])
def test_conditional_write_is_rejected_even_when_model_preserves_condition(
    monkeypatch, condition, retain_condition
):
    command = "add two apples to my cart"
    message = f"{command} {condition}"
    canonical = message if retain_condition else command
    assert_rejected_before_resolver(
        monkeypatch, message, proposal("ADD_TO_CART", canonical)
    )


def test_live_conditional_price_rewrite_is_rejected_before_resolver(monkeypatch):
    assert_rejected_before_resolver(
        monkeypatch,
        "If apples cost less than $7, add two to my cart",
        proposal(
            "ADD_TO_CART",
            "add two apples to my cart if apples cost less than $7",
        ),
    )


@pytest.mark.parametrize(
    "intent,command",
    [
        ("CLEAR_CART", "clear my cart"),
        ("CREATE_ORDER", "create order"),
        ("ACCOUNT_ADDRESS_REMOVE", "remove my address"),
        ("SUPPORT_TICKET_CLOSE", "close my support ticket"),
        ("CANCEL_ORDER", "cancel my order"),
    ],
)
def test_condition_cannot_authorize_other_write_workflows(monkeypatch, intent, command):
    message = f"{command} only when I am eligible"
    assert_rejected_before_resolver(monkeypatch, message, proposal(intent, message))


def test_model_cannot_invent_a_conditional_write(monkeypatch):
    assert_rejected_before_resolver(
        monkeypatch,
        "add apples to my cart",
        proposal("ADD_TO_CART", "add apples to my cart if stock is available"),
    )


@pytest.mark.parametrize(
    "message",
    [
        "I do not want apple",
        "I don't want apple",
        "I don’t want apple",
        "We do not need dinner",
        "We never want apple",
        "Please I do not need apple.",
    ],
)
@pytest.mark.parametrize("intent", ["DENY", "PRODUCT_SEARCH"])
def test_bare_denied_desire_cannot_become_context_reply_or_exclusion_search(
    monkeypatch, message, intent
):
    assert_rejected_before_resolver(monkeypatch, message, proposal(intent, message))


@pytest.mark.parametrize(
    "message",
    [
        "find milk but not almond milk",
        "show apples without nuts",
        "I need milk not almond milk",
        "find products excluding apple",
    ],
)
def test_positive_exclusion_reads_remain_eligible_for_full_engine_validation(message):
    assert permits_reinterpretation(message, proposal("PRODUCT_SEARCH", message))


def test_exclusion_read_cannot_silently_drop_excluding_marker(monkeypatch):
    assert_rejected_before_resolver(
        monkeypatch,
        "find milk excluding almond milk",
        proposal("PRODUCT_SEARCH", "find milk"),
    )


def test_preserved_excluding_read_remains_eligible_for_full_engine_validation():
    message = "find milk excluding almond milk"
    assert permits_reinterpretation(message, proposal("PRODUCT_SEARCH", message))


@pytest.mark.parametrize(
    "condition",
    [
        "only if stock is available",
        "only when stock is available",
        "provided that stock is available",
        "as long as stock is available",
    ],
)
def test_conditional_read_cannot_silently_lose_its_multiword_condition(
    monkeypatch, condition
):
    assert_rejected_before_resolver(
        monkeypatch,
        f"find apples {condition}",
        proposal("PRODUCT_SEARCH", "find apples"),
    )


@pytest.mark.parametrize(
    "condition",
    [
        "only if stock is available",
        "only when stock is available",
        "provided that stock is available",
        "as long as stock is available",
    ],
)
def test_preserved_conditional_read_reaches_full_engine_validation(condition):
    message = f"find apples {condition}"
    assert permits_reinterpretation(message, proposal("PRODUCT_SEARCH", message))


@pytest.mark.parametrize(
    "marker", ["only if", "only when", "provided that", "as long as"]
)
def test_multiword_condition_preservation_normalizes_case_and_whitespace(marker):
    irregular_marker = "  \t".join(marker.upper().split())
    message = f"find apples {irregular_marker} stock is available"
    canonical = f"find apples {marker} stock is available"
    assert permits_reinterpretation(message, proposal("PRODUCT_SEARCH", canonical))


def test_quoted_multiword_condition_remains_a_compatible_product_literal():
    message = 'find the book "As Long As"'
    assert permits_reinterpretation(message, proposal("PRODUCT_SEARCH", message))


@pytest.mark.parametrize("message", ["no", "no thanks", "nope"])
def test_normal_deny_confirmation_is_not_a_bare_denied_desire(message):
    assert permits_reinterpretation(message, proposal("DENY", message))


@pytest.mark.parametrize(
    "message",
    [
        'add two bottles of "If" perfume to my cart',
        "add two bottles of “If” perfume to my cart",
        'add "Only When" perfume to my cart',
        "add Gift perfume to my cart",
        "add Cliff bars to my cart",
    ],
)
def test_quoted_product_literals_and_incidental_substrings_are_not_conditions(message):
    assert permits_reinterpretation(message, proposal("ADD_TO_CART", message))


def test_condition_outside_a_quoted_product_still_blocks_write(monkeypatch):
    message = 'add two bottles of "If" perfume only when stock is available'
    assert_rejected_before_resolver(
        monkeypatch, message, proposal("ADD_TO_CART", message)
    )


def test_negated_desire_inside_product_literal_does_not_block_clear_request():
    message = 'find the book "I do not want apple"'
    assert permits_reinterpretation(message, proposal("PRODUCT_SEARCH", message))
