"""Standard comparison dispatch and catalog identity/evidence boundaries."""

import asyncio
import json
from unittest.mock import AsyncMock, Mock
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_cart_actions import interpreted
from test_cart_handler import collect
from test_language_fallback import install_provider, proposal, unknown
from test_shopping import product

from app.commerce_action_engine.actions.catalog.comparison import comparison_query
from app.commerce_action_engine.application.handlers import comparison
from app.commerce_action_engine.execution.language import gate
from app.commerce_resolution_engine.admission import require_permit
from app.main import create_app


def resolution(refs=(), *, clear=False):
    return gate.Resolution(
        status="RESOLVED",
        confidence=1,
        message="",
        intent="CLEAR_COMPARISON" if clear else "PRODUCT_COMPARE",
        primaryIntent="PRODUCT_SEARCH",
        entities={} if clear else {"items": [{"productText": ref} for ref in refs]},
    )


@pytest.mark.parametrize("after_proposal", [False, True])
@pytest.mark.parametrize("mode", ["names", "selected", "prompt", "clear"])
def test_standard_dispatch_only_reads_catalog_or_requests_browser_action(
    identity, monkeypatch, after_proposal, mode
):
    config, request_id, headers = identity
    products = [product(1, name="Gala Apples"), product(2, name="Bananas")]
    refs = [p["route"] if mode == "selected" else p["name"] for p in products]
    if mode == "prompt":
        refs = ["fruit"]
    clear = mode == "clear"
    message = "clear comparison" if clear else "compare " + " and ".join(refs)
    resolved = resolution(refs, clear=clear)
    provider = install_provider(monkeypatch, proposal(resolved.intent, message))
    attempts, received, calls = [], [], []
    original = comparison.comparison_events

    async def observe(**kwargs):
        request = kwargs["request"]
        assert request.request_id == request_id
        assert request.legacy_intent == resolved.intent
        assert request.primary_intent == "PRODUCT_SEARCH"
        assert request.entities == resolved.entities
        with pytest.raises(PermissionError):
            require_permit(UUID(request_id))
        received.append(request)
        async for event in original(**kwargs):
            yield event

    async def resolve(url, text):
        attempts.append(text)
        return unknown() if after_proposal and len(attempts) == 1 else resolved

    def commerce(request):
        assert mode in {"names", "selected"}
        assert request.method == "POST" and request.url.path.endswith("/shopper")
        assert request.headers["authorization"] == "Bearer catalog"
        payload = json.loads(request.content)
        assert payload["name"] == (
            "get_product" if mode == "selected" else "search_products"
        )
        expected = (
            {"product_id": products[len(calls)]["id"]}
            if mode == "selected"
            else {"query": refs[len(calls)]}
        )
        assert payload["arguments"] == expected
        calls.append(payload)
        return httpx.Response(
            200, json={"products": [products[len(calls) - 1]], "category": None}
        )

    monkeypatch.setattr(gate, "resolve", resolve)
    monkeypatch.setattr(comparison, "comparison_events", observe)
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            headers={**headers(), "x-commerce-catalog-token": "catalog"},
            json={"request_id": request_id, "message": message},
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert events[-1]["type"] == "done" and not any(
        e["type"] == "error" for e in events
    )
    assert [e["sequence"] for e in events] == list(range(len(events)))
    if clear and after_proposal:
        # CLEAR_COMPARISON is not admitted through the model-proposal allowlist.
        assert received == [] and calls == []
        assert not any(e.get("code") == "clear_comparison" for e in events)
        assert len(provider.requests) == 1 and provider.closed
        return
    assert len(received) == 1 and len(calls) == (
        2 if mode in {"names", "selected"} else 0
    )
    if clear:
        assert sum(e.get("code") == "clear_comparison" for e in events) == 1
        assert "Requested to clear" in response.text
    else:
        assert (
            '"kind":"product_prompt"'
            if mode == "prompt"
            else '"kind":"comparison_table"'
        ) in response.text
    assert len(provider.requests) == int(after_proposal) and provider.closed
    assert not hasattr(gate, "current")


@pytest.mark.parametrize(
    "case", ["partial", "ambiguous", "wrong_id", "variant", "duplicate"]
)
def test_unsafe_product_selection_never_produces_a_comparison_table(case):
    first, second = product(1, name="Tea"), product(2, name="Coffee")
    reader = AsyncMock()
    refs = ["Tea", "Coffee"]
    if case == "partial":
        refs[0] = "Te"
    if case == "variant":
        first["product_type"] = "configurable"
    if case == "duplicate":
        second = first
    reader.search_cart_product.side_effect = [
        [first, product(3, name="Tea")] if case == "ambiguous" else [first],
        [second],
    ]
    if case == "wrong_id":
        refs[0] = "/products/" + str(UUID(int=99))
        reader.product.return_value = first
    if case == "duplicate":
        refs[1] = "Tea"
    events = asyncio.run(
        collect(
            comparison.comparison_events(
                request=interpreted(resolution(refs)),
                commerce_tools=lambda: reader,
                make_event=lambda kind, **fields: {"type": kind, **fields},
                metadata={},
            )
        )
    )
    assert not any(
        b["kind"] == "comparison_table" for e in events for b in e.get("blocks", [])
    )
    assert any(e.get("text") for e in events)
    assert reader.search_cart_product.await_count <= (2 if case == "duplicate" else 1)


def test_domain_filters_noncomparable_attributes_without_inventing_missing_facts():
    source = product(
        1,
        name="Tea",
        in_stock=None,
        attributes=[
            {"name": "color", "value": '"green"', "comparable": True},
            {"name": "private_note", "value": '"hidden"', "comparable": False},
        ],
    )
    reader = AsyncMock()
    reader.search_cart_product.return_value = [source]
    match = asyncio.run(comparison_query("Tea").execute(reader))
    assert match.product.in_stock is None
    assert [a.name for a in match.product.attributes] == ["color"]
    assert len(source["attributes"]) == 2
    source["attributes"] = []
    match = asyncio.run(comparison_query("Tea").execute(reader))
    assert match.product.attributes == []


@pytest.mark.parametrize("refs", [[], [" "], ["x"] * 6, [1, "Tea"]])
def test_invalid_comparison_inputs_do_not_construct_reader(refs):
    factory = Mock(side_effect=AssertionError("Invalid comparison entered catalog"))
    events = asyncio.run(
        collect(
            comparison.comparison_events(
                request=interpreted(resolution(refs)),
                commerce_tools=factory,
                make_event=lambda kind, **fields: {"type": kind, **fields},
                metadata={},
            )
        )
    )
    assert len(events) == 1 and "two to five" in events[0]["text"]
    factory.assert_not_called()
