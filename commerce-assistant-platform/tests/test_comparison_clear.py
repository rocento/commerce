"""Comparison clearing must reach the client action, not a cart/catalog tool."""

import httpx
import pytest
from fastapi.testclient import TestClient
from interpretation_helpers import standard_route
from test_assistant import identity as identity  # noqa: PLC0414
from test_product_guidance import frames, real_engine
from test_product_guidance import no_model as no_model  # noqa: PLC0414

from app.commerce_action_engine.execution.language import Resolution
from app.main import create_app


@pytest.mark.parametrize("pending_question", [None, "add two products to cart"])
@pytest.mark.parametrize(
    "message",
    [
        "remove all compare list",
        "Please clear my comparison list",
        "remove everything from comparison",
        "Could you empty the comparison tray for me?",
        "start comparison from scratch",
    ],
)
def test_real_language_to_sse_requests_only_browser_comparison_clear(
    identity, monkeypatch, message, pending_question
):
    real_engine(monkeypatch)
    config, request_id, headers = identity

    def no_commerce(request):
        pytest.fail(
            f"Must not touch cart, wishlist or catalog: {request.method} {request.url.path}"
        )

    with TestClient(
        create_app(config, transport=httpx.MockTransport(no_commerce))
    ) as client:
        events = frames(
            client.post(
                "/v1/chat",
                headers=headers(),
                json={
                    "request_id": request_id,
                    "message": message,
                    **(
                        {
                            "clarification": {
                                "original_message": pending_question,
                                "question": "Which product or items do you mean?",
                            }
                        }
                        if pending_question
                        else {}
                    ),
                },
            )
        )
    commands = [event for event in events if event.get("code") == "clear_comparison"]
    if pending_question and message in {
        "remove all compare list",
        "remove everything from comparison",
        "start comparison from scratch",
    }:
        # Only explicit clear/reset/empty comparison commands interrupt a pending
        # slot question. Other wording retains the existing clarification guard.
        assert commands == []
        assert not any(event["type"] == "content.blocks" for event in events)
        assert any(
            event.get("clarification", {}).get("original_message") == pending_question
            for event in events
        )
        return
    assert len(commands) == 1
    assert (
        commands[0]["type"] == "message.delta" and commands[0]["response_source"] == "R"
    )
    # The server cannot attest to browser state; only the client reports completion.
    assert (
        commands[0]["text"]
        == "Requested to clear your comparison list in this browser."
    )
    assert not any(event["type"] == "content.blocks" for event in events)


@pytest.mark.parametrize(
    "change",
    [
        {"status": "UNKNOWN"},
        {"status": "DENIED"},
        {"status": "UNSUPPORTED"},
        {"status": "NEEDS_CONTEXT"},
        {"confidence": 0.4},
        {"missing": ["item"]},
        {"requestType": "MULTI_ACTION"},
        {"entities": {"productText": "Gala"}},
    ],
)
def test_incomplete_or_unsafe_resolution_cannot_request_comparison_clear(change):
    resolution = Resolution.model_validate(
        {
            "status": "RESOLVED",
            "intent": "CLEAR_COMPARISON",
            "confidence": 1.0,
            "message": "",
            **change,
        }
    )
    assert standard_route(resolution) != "comparison_clear"
