"""Shopping uses the interpretation bound to its invocation, not ambient wire state."""

import asyncio

from test_enterprise_contracts import context as context  # noqa: PLC0414
from test_language_fallback import resolved
from test_shopping import product, scenario

from app.commerce_action_engine.application.interpretation import interpret_resolution
from app.commerce_action_engine.contracts.interpretation import InterpretationFailure
from app.commerce_action_engine.execution.language import gate


def test_explicit_interpretation_needs_no_ambient_wire(context):
    standard = interpret_resolution(
        resolved(intent="PRODUCT_SEARCH", entities={"productText": "shoes"}), context
    ).result
    assert not hasattr(gate, "current")
    answer, requests = asyncio.run(
        scenario("find shoes", {"query": "WRONG"}, [product()], interpretation=standard)
    )
    assert requests[0]["arguments"]["query"] == "shoes"
    assert answer.model == "commerce-language-engine"


def test_failure_cannot_fall_back_to_model(context):
    failure = InterpretationFailure(
        request_id=context.actor.request_id, code="invalid_response"
    )
    answer, requests = asyncio.run(
        scenario("find shoes", {"query": "WRONG"}, [product()], interpretation=failure)
    )
    assert not requests
    assert answer.model == "commerce-language-engine"
    assert "unavailable" in answer.text


def test_malformed_recommendation_references_stop_before_product_reads(context):
    request = interpret_resolution(
        resolved(
            intent="PRODUCT_SEARCH",
            entities={"productText": "shoes", "cheaperReferences": {"id": "bad"}},
        ),
        context,
    ).result
    answer, requests = asyncio.run(
        scenario("find shoes", {"query": "WRONG"}, [product()], interpretation=request)
    )
    assert not requests
    assert "couldn't verify" in answer.text
