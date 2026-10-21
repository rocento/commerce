"""Admitted handler dispatch preserves route scope, lazy IO and stream cleanup."""

import asyncio
from contextlib import aclosing
from uuid import UUID

import pytest

from app.commerce_action_engine.application.handler_dispatch import (
    HANDLERS,
    HandlerBinding,
    HandlerContext,
    HandlerRoute,
    standard_handler,
)
from app.commerce_action_engine.application.handlers import orders
from app.commerce_action_engine.contracts import AssistantEvent
from app.commerce_action_engine.contracts.interpretation import (
    Confidence,
    InterpretedRequest,
)


def handler_context(*, authenticated=False):
    request_id = UUID(int=1)
    sequence = 0

    def make_event(kind, **fields):
        nonlocal sequence
        event = AssistantEvent(
            version="1",
            request_id=request_id,
            sequence=sequence,
            type=kind,
            **fields,
        )
        sequence += 1
        return event

    def no_tools():
        pytest.fail("Dispatch unexpectedly constructed commerce tools")

    return HandlerContext(
        request=InterpretedRequest(
            request_id=str(request_id),
            status="RESOLVED",
            legacy_intent="ORDER_HISTORY",
            message="Understood.",
            confidence=Confidence(raw=1),
        ),
        authenticated=authenticated,
        message="show my orders",
        commerce_tools=no_tools,
        metadata={},
        make_event=make_event,
    )


def test_all_extracted_feature_routes_have_their_existing_journey():
    expected = {
        "product_fact": "general",
        "reorder": "order",
        "comparison": "discovery",
        "comparison_clear": "discovery",
        "discounts": "discovery",
        "bestsellers": "discovery",
        "order": "order",
        "cart_action": "cart",
        "wishlist_to_cart": "general",
        "wishlist": "general",
        "wishlist_remove": "general",
        "locations": "general",
        "support": "general",
        "shipment": "general",
        "support_detail": "general",
    }
    assert {
        route.value: binding.journey for route, binding in HANDLERS.items()
    } == expected
    assert set(HANDLERS) == set(HandlerRoute)
    for route in expected:
        assert standard_handler(route) is HANDLERS[HandlerRoute(route)]


@pytest.mark.parametrize(
    "route",
    [
        "denied",
        "unsupported",
        "unavailable",
        "unmapped",
        "clarify",
        "context",
        "handoff",
        "conversation",
        "engine_response",
        "guided_action",
        "compound",
        "search",
        "cart",
        "delivery",
        "unknown",
        "future_feature",
        "",
    ],
)
def test_held_and_fallback_routes_are_left_to_turn_policy(route):
    assert standard_handler(route) is None


@pytest.mark.parametrize("route", list(HandlerRoute))
def test_selecting_a_handler_or_creating_its_stream_does_not_construct_tools(route):
    async def run():
        context = handler_context()
        binding = standard_handler(route)
        assert binding is not None
        stream = binding.events(context)
        assert context.metadata == {}
        await stream.aclose()
        assert context.metadata == {}

    asyncio.run(run())


def test_guest_order_route_emits_login_without_constructing_tools():
    async def run():
        context = handler_context()
        binding = standard_handler("order")
        assert binding is not None
        events = [event async for event in binding.events(context)]
        assert [(event.type, event.code, event.sequence) for event in events] == [
            ("message.delta", "login_required", 0)
        ]
        assert events[0].text == "Please sign in to view your orders."
        assert context.metadata == {"route_reason": "login_required"}

    asyncio.run(run())


def test_closing_real_order_progress_does_not_start_the_read():
    async def run():
        context = handler_context(authenticated=True)
        binding = standard_handler("order")
        assert binding is not None
        async with aclosing(binding.events(context)) as stream:
            progress = await anext(stream)
            assert progress.type == "progress" and progress.stage == "order"
        assert context.metadata == {}

    asyncio.run(run())


def test_partial_handler_failure_propagates_once_without_retry(monkeypatch):
    async def run():
        context = handler_context()
        attempted, closed = [], []
        failure = RuntimeError("Controlled handler failure")
        first = context.make_event("message.delta", text="Partial response")

        async def failing_order(**kwargs):
            attempted.append(kwargs["request"])
            try:
                yield first
                raise failure
            finally:
                closed.append(True)

        monkeypatch.setattr(orders, "order_events", failing_order)
        binding = standard_handler("order")
        assert binding is not None
        async with aclosing(binding.events(context)) as stream:
            assert await anext(stream) is first
            with pytest.raises(RuntimeError) as caught:
                await anext(stream)
            assert caught.value is failure
        assert attempted == [context.request]
        assert closed == [True]

    asyncio.run(run())


def test_explicit_stream_close_runs_underlying_finally_before_returning():
    async def run():
        context = handler_context()
        lifecycle = []

        async def handler(received):
            assert received is context
            lifecycle.append("started")
            try:
                yield context.make_event("message.delta", text="First response")
                pytest.fail("Closing a stream resumed its next operation")
            finally:
                lifecycle.append("closed")

        binding = HandlerBinding("general", handler)
        async with aclosing(binding.events(context)) as stream:
            await anext(stream)
            assert lifecycle == ["started"]
        # Assert inside the running loop: shutdown cleanup cannot mask a leak.
        assert lifecycle == ["started", "closed"]

    asyncio.run(run())


def test_active_cancellation_propagates_and_closes_underlying_handler():
    async def run():
        context = handler_context()
        started, release = asyncio.Event(), asyncio.Event()
        lifecycle = []

        async def handler(received):
            lifecycle.append("started")
            try:
                started.set()
                await release.wait()
                yield received.make_event("message.delta", text="Unexpected response")
            finally:
                lifecycle.append("closed")

        binding = HandlerBinding("general", handler)
        async with aclosing(binding.events(context)) as stream:
            pending = asyncio.create_task(anext(stream))
            await asyncio.wait_for(started.wait(), timeout=2)
            pending.cancel()
            with pytest.raises(asyncio.CancelledError):
                await pending
            assert lifecycle == ["started", "closed"]

    asyncio.run(run())
