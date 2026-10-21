"""Retained direct transport preserves bounded responses and never retries a write."""

import asyncio

import httpx
import pytest

from app.commerce_action_engine.actions.registry import default_registry
from app.commerce_action_engine.actions.shopping.reorder import (
    ReorderRejected,
    ReorderUncertain,
)
from app.commerce_action_engine.adapters.reorder import ERRORS, execute


def test_registry_points_to_transport_without_enabling_chat_dispatch():
    definition = default_registry().get("order.reorder")
    assert (
        definition.implementation
        == "app.commerce_action_engine.adapters.reorder:execute"
    )
    assert definition.replay == "never"


def test_missing_capability_never_sends_a_request():
    def forbidden(request):
        pytest.fail("Missing capability reached transport")

    async def run():
        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(forbidden)
        ) as client:
            await execute(client, "", 5)

    with pytest.raises(ReorderRejected, match="Please sign in"):
        asyncio.run(run())


@pytest.mark.parametrize("code", sorted(ERRORS))
def test_gateway_rejections_preserve_reason_without_retry(code):
    calls = []

    def commerce(request):
        calls.append(request)
        return httpx.Response(409, json={"code": code})

    async def run():
        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(commerce)
        ) as client:
            await execute(client, "capability", 5)

    with pytest.raises(ReorderRejected) as caught:
        asyncio.run(run())
    assert str(caught.value) == ERRORS[code]
    assert len(calls) == 1


@pytest.mark.parametrize("mode", ["oversize", "timeout", "cancel"])
def test_interrupted_receipts_close_stream_without_retry(mode):
    class ReceiptStream(httpx.AsyncByteStream):
        closed = False

        async def __aiter__(self):
            if mode == "timeout":
                raise httpx.ReadTimeout("receipt lost")
            if mode == "cancel":
                raise asyncio.CancelledError()
            yield b" " * 32769

        async def aclose(self):
            self.closed = True

    stream, calls = ReceiptStream(), []

    def commerce(request):
        calls.append(request)
        return httpx.Response(200, stream=stream)

    async def run():
        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(commerce)
        ) as client:
            await execute(client, "capability", 5)

    with pytest.raises(
        asyncio.CancelledError if mode == "cancel" else ReorderUncertain
    ):
        asyncio.run(run())
    assert stream.closed and len(calls) == 1
