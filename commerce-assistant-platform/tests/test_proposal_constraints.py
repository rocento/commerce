"""A canonical rewrite must preserve meaning already present in UNKNOWN input."""

import asyncio
import json
import shutil
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from test_enterprise_contracts import context as test_context

from app.commerce_action_engine.application.interpretation import interpret_resolution
from app.commerce_action_engine.application.language_proposals import accept_proposal
from app.commerce_action_engine.execution.language import gate
from app.commerce_contracts.language_proposal import LanguageProposal


def unknown(entities=None):
    return gate.Resolution(
        status="UNKNOWN", confidence=0, message="", entities=entities or {}
    )


@pytest.mark.parametrize(
    "message,canonical,intent",
    [
        ("rustle up apples below 20", "show apples over 20", "PRODUCT_SEARCH"),
        ("rustle up apples below 20", "show apples up to 20", "PRODUCT_SEARCH"),
        ("rustle up apples under $20", "show apples under 20", "PRODUCT_SEARCH"),
        ("rustle up apples under USD 20", "show apples under EUR 20", "PRODUCT_SEARCH"),
        ("rustle up apples under 20 euros", "show apples under 20", "PRODUCT_SEARCH"),
        (
            "rustle up apples under 20 euros",
            "show apples under 20 US dollars",
            "PRODUCT_SEARCH",
        ),
        (
            "rustle up apples between 10 and 20 euros",
            "show apples under EUR 20",
            "PRODUCT_SEARCH",
        ),
        ("bung two kg apples in cart", "add two lb apples to cart", "ADD_TO_CART"),
        ("how do I empty this cart", "clear my cart", "CLEAR_CART"),
        ("can I empty the cart", "clear my cart", "CLEAR_CART"),
        ("what happens when I empty my cart", "clear my cart", "CLEAR_CART"),
    ],
)
def test_literal_change_or_action_question_stops_before_engine(
    monkeypatch, message, canonical, intent
):
    resolver = AsyncMock(side_effect=AssertionError("Must reject before revalidation"))
    monkeypatch.setattr(gate, "resolve", resolver)
    result = asyncio.run(
        accept_proposal(
            "http://engine",
            interpret_resolution(unknown(), test_context.__wrapped__()),
            message,
            LanguageProposal(
                status="INTERPRETED",
                intent=intent,
                canonical_text=canonical,
            ),
            context=test_context.__wrapped__(),
        )
    )
    assert result.route == "clarify"
    resolver.assert_not_awaited()


@pytest.mark.parametrize(
    "entities",
    [
        {"color": "red"},
        {"size": "xl"},
        {"brand": "example"},
        {"quantity": 2},
        {"excluded": {"material": ["wool"]}},
        {"price": {"operator": "<=", "value": 20}},
        {"future_requirement": {"scope": "product", "value": "required"}},
    ],
)
def test_unknown_partial_entities_cannot_disappear(monkeypatch, entities):
    monkeypatch.setattr(
        gate,
        "resolve",
        AsyncMock(
            return_value=gate.Resolution(
                status="RESOLVED",
                confidence=1,
                message="",
                intent="PRODUCT_SEARCH",
                entities={"productText": "apples"},
            )
        ),
    )
    result = asyncio.run(
        accept_proposal(
            "http://engine",
            interpret_resolution(unknown(entities), test_context.__wrapped__()),
            "rustle up apples",
            LanguageProposal(
                status="INTERPRETED",
                intent="PRODUCT_SEARCH",
                canonical_text="show apples",
            ),
            context=test_context.__wrapped__(),
        )
    )
    assert result.route == "clarify"


def test_real_parser_preserves_colour_and_price_constraints(monkeypatch):
    if not shutil.which("node"):
        pytest.skip("Node is required for the real parser")
    messages = [
        "Could ya rustle up apples below 20?",
        "show me apples over 20",
        "Can ya rustle up red apples below 20?",
        "show me apples under 20",
        "show me red apples under 20",
    ]
    script = """
import {loadRuntime} from './app/commerce_language_engine/src/runtime.ts';
import {resolve} from './app/commerce_language_engine/src/engine.ts';
const engine=await loadRuntime();
console.log(JSON.stringify(JSON.parse(process.argv[1]).map(text=>resolve(engine,text,{}))));
"""
    raw = subprocess.check_output(
        ["node", "--input-type=module", "-e", script, json.dumps(messages)],
        cwd=Path(__file__).resolve().parents[1],
        text=True,
    )
    resolutions = [gate.Resolution.model_validate(value) for value in json.loads(raw)]
    for original, canonical, expected in [
        (0, 1, "clarify"),
        (2, 3, "clarify"),
        (2, 4, "search"),
    ]:
        assert resolutions[original].status == "UNKNOWN"
        monkeypatch.setattr(
            gate, "resolve", AsyncMock(return_value=resolutions[canonical])
        )
        result = asyncio.run(
            accept_proposal(
                "http://engine",
                interpret_resolution(resolutions[original], test_context.__wrapped__()),
                messages[original],
                LanguageProposal(
                    status="INTERPRETED",
                    intent="PRODUCT_SEARCH",
                    canonical_text=messages[canonical],
                ),
                context=test_context.__wrapped__(),
            )
        )
        assert result.route == expected


@pytest.mark.parametrize("malformed_original", [False, True])
def test_proposal_rejects_malformed_semantics_before_acceptance(
    monkeypatch, malformed_original
):
    source = unknown().model_copy(update={"entities": {"items": "invalid"}})
    resolved = gate.Resolution(
        status="RESOLVED", intent="VIEW_CART", confidence=1, message=""
    )
    resolver = AsyncMock(
        return_value=resolved.model_copy(update={"entities": {"items": "invalid"}})
    )
    monkeypatch.setattr(gate, "resolve", resolver)
    result = asyncio.run(
        accept_proposal(
            "http://engine",
            interpret_resolution(
                source if malformed_original else unknown(), test_context.__wrapped__()
            ),
            "show my cart",
            LanguageProposal(
                status="INTERPRETED", intent="VIEW_CART", canonical_text="show my cart"
            ),
            context=test_context.__wrapped__(),
        )
    )
    assert not hasattr(result, "resolution")
    assert result.route == "unavailable"
    assert resolver.await_count == (0 if malformed_original else 1)


def test_proposal_acceptance_uses_canonical_route_without_wire_adapter(monkeypatch):
    resolved = gate.Resolution(
        status="RESOLVED", intent="VIEW_CART", confidence=1, message=""
    )
    resolver = AsyncMock(return_value=resolved)
    monkeypatch.setattr(gate, "resolve", resolver)
    monkeypatch.setattr(
        gate,
        "route",
        lambda *_: pytest.fail("Legacy route must not be used"),
        raising=False,
    )
    result = asyncio.run(
        accept_proposal(
            "http://engine",
            interpret_resolution(unknown(), test_context.__wrapped__()),
            "show my cart",
            LanguageProposal(
                status="INTERPRETED", intent="VIEW_CART", canonical_text="show my cart"
            ),
            context=test_context.__wrapped__(),
        )
    )
    assert (
        result.result
        == interpret_resolution(resolved, test_context.__wrapped__()).result
    )
    assert result.route == "cart"
    resolver.assert_awaited_once_with("http://engine", "show my cart")
