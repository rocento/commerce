"""The Node action list survives a strict, non-authorizing Python boundary."""

import asyncio
import json
import subprocess
from copy import deepcopy
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from interpretation_helpers import standard_route
from pydantic import ValidationError
from test_assistant import identity as identity  # noqa: PLC0414
from test_enterprise_contracts import context as context  # noqa: PLC0414
from test_shopping import interpreted

from app.commerce_action_engine.application.interpretation import (
    interpret_resolution,
    shopping_plan,
)
from app.commerce_action_engine.application.interpretation_diagnostics import (
    diagnostic_summary,
)
from app.commerce_action_engine.execution.language import gate
from app.main import create_app

ENGINE = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"


def metadata():
    return {
        "requestedActionsVersion": 1,
        "intentCount": 2,
        "uniqueIntentCount": 2,
        "intentCountStatus": "EXACT",
        "requestedActionIssues": [],
        "requestedActions": [
            {
                "id": "request1",
                "intent": "ADD_TO_CART",
                "text": "add banana",
                "items": [{"productText": "banana", "quantity": 1}],
            },
            {
                "id": "request2",
                "intent": "ADD_TO_WISHLIST",
                "text": "also to wishlist",
                "items": [{"productText": "banana"}],
                "after": "request1",
            },
        ],
    }


def payload():
    return {
        "status": "NEEDS_CONTEXT",
        "intent": "ADD_TO_CART",
        "message": "Review the request",
        "confidence": 0.0,
        **metadata(),
    }


@pytest.fixture(scope="module")
def interpretations():
    messages = [
        "add banana to cart and also to wishlist",
        "add to cart 1 banana then also to wishlist",
        "add banana to cart and also apple to wishlist",
        "add banana to cart, actually wishlist instead",
        "add banana to cart or to wishlist",
        "add it to cart and also to wishlist",
        "add banana to cart if cheap",
        "do not add banana to cart",
        "add zero bananas to cart",
        "add 1000001 bananas to cart",
        "add 1.5 bananas to cart",
        "add bananas and apples to cart",
        "add banana to cart and add apple to cart",
        "show my cart",
        "create order for two apples and deliver to my home address",
        "hello",
        "gibberish xyz",
    ]
    output = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import {loadRuntime} from './src/runtime.ts'; import {resolve} from './src/engine.ts';"
                "const c=await loadRuntime();console.log(JSON.stringify(JSON.parse(process.argv[1]).map(text=>resolve(c,text))));"
            ),
            json.dumps(messages),
        ],
        cwd=ENGINE,
        capture_output=True,
        text=True,
        check=True,
    )
    return dict(zip(messages, json.loads(output.stdout), strict=True))


def test_real_node_payloads_validate_and_serialize(interpretations):
    for message, raw in interpretations.items():
        result = gate.Resolution.model_validate(raw)
        assert result.requestedActionsVersion == 1, message
        assert gate.Resolution.model_validate_json(result.model_dump_json()) == result


def test_resolved_complete_pair_cannot_enter_single_action_routing(interpretations):
    raw = interpretations["add banana to cart and also to wishlist"]
    result = gate.Resolution.model_validate(raw)
    assert result.intentCount == 2
    assert result.requestedActionIssues == []
    assert result.compoundInterpretationVersion == 1
    assert result.status == "RESOLVED"
    assert standard_route(result) == "clarify"
    assert shopping_plan(interpreted(result), raw["text"]) is None


def test_existing_compound_preparation_and_simple_cart_routes_survive(interpretations):
    order = gate.Resolution.model_validate(
        interpretations["create order for two apples and deliver to my home address"]
    )
    assert order.intentCount == 2
    assert len(order.operations) == 3
    assert standard_route(order) == "guided_action"
    cart = gate.Resolution.model_validate(interpretations["show my cart"])
    assert standard_route(cart) == "cart"


def test_zero_actions_cannot_enter_unknown_model_fallback(interpretations):
    result = gate.Resolution.model_validate(
        interpretations["do not add banana to cart"]
    )
    assert result.intentCount == 0
    assert result.status == "NEEDS_CONTEXT"
    assert standard_route(result) == "clarify"


@pytest.mark.parametrize(
    "status", ["NEEDS_CONTEXT", "AMBIGUOUS", "UNSUPPORTED", "DENIED", "UNKNOWN"]
)
def test_exact_count_does_not_upgrade_existing_status(status):
    result = gate.Resolution.model_validate({**payload(), "status": status})
    assert result.status == ("NEEDS_CONTEXT" if status == "UNKNOWN" else status)
    assert standard_route(result) != "fallback"
    assert standard_route(result) not in {"cart_action", "search", "cart"}


def test_legacy_metadata_absent_survives_round_trip():
    raw = {
        "status": "RESOLVED",
        "intent": "VIEW_CART",
        "message": "Cart",
        "confidence": 1.0,
    }
    result = gate.Resolution.model_validate(raw)
    assert result.requested_action_shadow() == {"metadata": "absent"}
    assert "requestedActionsVersion" not in result.model_dump()
    assert standard_route(gate.Resolution.model_validate(result.model_dump())) == "cart"


@pytest.mark.parametrize(
    "field,value",
    [
        ("requestedActionsVersion", 2),
        ("requestedActionsVersion", True),
        ("intentCount", True),
        ("intentCount", "2"),
        ("intentCount", 1),
        ("uniqueIntentCount", 1),
        ("intentCountStatus", None),
        ("requestedActions", None),
        ("requestedActions", []),
        ("requestedActionIssues", ["INVENTED"]),
        ("requestedActionIssues", ["UNRESOLVED_PRODUCT"]),
    ],
)
def test_invalid_top_level_metadata_is_rejected(field, value):
    with pytest.raises(ValidationError):
        gate.Resolution.model_validate({**payload(), field: value})


@pytest.mark.parametrize("field", list(metadata()))
def test_partial_metadata_is_rejected(field):
    raw = payload()
    del raw[field]
    with pytest.raises(ValidationError):
        gate.Resolution.model_validate(raw)


@pytest.mark.parametrize(
    "patch",
    [
        {"after": "request2"},
        {"after": "request9"},
        {"id": "request1"},
        {"intent": "arbitrary tool"},
        {"executor": "cart.add"},
        {"items": [{"productText": "banana", "productId": "forged"}]},
        {"items": [{"productText": "banana", "quantity": True}]},
        {"items": [{"productText": "banana", "quantity": -1}]},
        {"items": [{"productText": "banana", "quantity": 1.5}]},
        {"items": [{"productText": "banana", "quantity": 1000001}]},
        {"items": [{"productText": "banana", "unit": "invented"}]},
        {"items": [{}]},
        {"items": [{"productText": "banana"}] * 51},
    ],
)
def test_invalid_actions_or_authority_claims_are_rejected(patch):
    raw = payload()
    raw["requestedActions"][1].update(patch)
    with pytest.raises(ValidationError):
        gate.Resolution.model_validate(raw)


def test_cyclic_or_forward_dependency_is_rejected():
    raw = payload()
    raw["requestedActions"][0]["after"] = "request2"
    with pytest.raises(ValidationError):
        gate.Resolution.model_validate(raw)


def test_uncertainty_requires_null_counts_and_a_reason():
    raw = {
        **payload(),
        "intentCountStatus": "NEEDS_CLARIFICATION",
        "intentCount": None,
        "uniqueIntentCount": None,
        "requestedActionIssues": ["UNRESOLVED_PRODUCT"],
    }
    assert gate.Resolution.model_validate(raw).intentCount is None
    for patch in (
        {"intentCount": 2},
        {"uniqueIntentCount": 2},
        {"requestedActionIssues": []},
    ):
        with pytest.raises(ValidationError):
            gate.Resolution.model_validate({**raw, **patch})


def test_shadow_diagnostics_contain_no_customer_or_product_content(context):
    result = gate.Resolution.model_validate(payload())
    decision = interpret_resolution(result, context)
    snapshot = diagnostic_summary(decision.result, decision.route)
    rendered = json.dumps(snapshot)
    assert "banana" not in rendered and "also to wishlist" not in rendered
    assert snapshot["requested_actions"]["action_count"] == 2
    assert snapshot["requested_actions"]["metadata"] == "validated"


def test_http_boundary_rejects_malformed_metadata_without_falling_back(
    monkeypatch, interpretations
):
    response_body = deepcopy(interpretations["show my cart"])
    real_client = httpx.AsyncClient

    async def respond(request):
        assert request.url.path == "/api/resolve"
        return httpx.Response(200, json=response_body)

    monkeypatch.setattr(
        gate.httpx,
        "AsyncClient",
        lambda **kw: real_client(**kw, transport=httpx.MockTransport(respond)),
    )
    good = asyncio.run(gate.resolve("http://language.test", "show my cart"))
    assert standard_route(good) == "cart"
    response_body["requestedActions"][0]["capability"] = "forged"
    rejected = asyncio.run(gate.resolve("http://language.test", "show my cart"))
    assert isinstance(rejected, gate.ResolutionFailure)
    assert rejected.code == "invalid_response"
    assert standard_route(rejected) == "unavailable"


@pytest.mark.parametrize(
    "message", ["add banana to cart and also to wishlist", "do not add banana to cart"]
)
def test_review_requests_do_not_reach_commerce_or_models(
    identity, monkeypatch, interpretations, message
):
    async def interpreted(url, text, *, context=None):
        return gate.Resolution.model_validate(interpretations[text])

    monkeypatch.setattr(gate, "resolve", interpreted)

    def commerce(request):
        pytest.fail("Review request reached commerce")

    class NoModel:
        async def generate(self, request):
            pytest.fail("Review request reached a model")

        async def stream(self, request):
            pytest.fail("Review request reached a model")
            yield

        async def aclose(self):
            pass

    config, request_id, headers = identity
    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce), model=NoModel())
    ) as client:
        response = client.post(
            "/v1/chat",
            headers=headers(),
            json={"request_id": request_id, "message": message},
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert response.status_code == 200
    assert events[-1]["type"] == "done"
    if "wishlist" in message:
        assert not any(event.get("clarification") for event in events)
        assert "Requested actions:" in response.text
        assert "No changes have been made" in response.text
    else:
        assert any(event.get("clarification") for event in events)
    assert not any(event["type"] == "error" for event in events)


def test_python_independently_blocks_a_stale_single_action_status():
    result = gate.Resolution.model_validate(
        {**payload(), "status": "RESOLVED", "confidence": 1.0}
    )
    assert result.status == "NEEDS_CONTEXT"
    assert result.requestedActionIssues == ["INTERPRETATION_CONFLICT"]
    assert standard_route(result) == "clarify"


def test_python_independently_blocks_a_different_single_action():
    raw = payload()
    raw.update(status="RESOLVED", confidence=1.0, intentCount=1, uniqueIntentCount=1)
    raw["requestedActions"] = [raw["requestedActions"][0]]
    raw["requestedActions"][0]["intent"] = "ADD_TO_WISHLIST"
    result = gate.Resolution.model_validate(raw)
    assert result.status == "NEEDS_CONTEXT"
    assert standard_route(result) == "clarify"
