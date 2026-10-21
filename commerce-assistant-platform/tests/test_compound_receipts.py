"""Authoritative transport, correlation and read-only recovery of lost replies."""

import asyncio
import json
import time
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
from pydantic import ValidationError
from test_compound_plan_store import row, store_for
from test_compound_planning import prepared, receipt

from app.commerce_action_engine.adapters.compound import CompoundCommerce
from app.commerce_action_engine.application.handlers.compound import describe
from app.commerce_action_engine.execution.planning import outcomes
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable
from app.commerce_contracts.compound_write import (
    CompoundCommand,
    CompoundDispatch,
)
from app.commerce_orchestration_engine.journeys.compound import reconcile


def test_shared_gateway_fixture_and_complete_request_binding():
    fixture = (
        Path(__file__).resolve().parents[2]
        / "commerce-assistant-platform/contracts/commerce-planning/v1/compound-dispatch.json"
    )
    dispatch = CompoundDispatch.model_validate_json(fixture.read_bytes())
    assert dispatch.command.actions[0].quantity == 2
    assert dispatch.command.actions[1].quantity == 1
    plan = prepared()
    assert not plan.execution_enabled
    assert (
        CompoundCommand.from_plan(plan).actions[1].product_id
        == plan.actions[1].binding.product_id
    )
    payload = dispatch.model_dump(mode="json")
    for path, value in [
        (("command", "actions", 1, "quantity"), 2),
        (("command", "actions", 1, "destination"), "cart"),
        (("command", "actions", 0, "expires_at"), 1790726499),
        (("command", "actions", 0, "operation_id"), str(uuid4())),
        (("action_id",), str(uuid4())),
        (("command", "scope", "customer_id"), str(UUID(int=0))),
        (("schema_version",), "2.0"),
    ]:
        changed = json.loads(json.dumps(payload))
        target = changed
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value
        with pytest.raises(ValidationError):
            CompoundDispatch.model_validate_json(json.dumps(changed))


def run_transport(
    plan, responder, *, read=False, read_token="receipt-only", write_token="write-only"
):
    async def run():
        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(responder)
        ) as client:
            gateway = CompoundCommerce(client, read_token, write_token)
            command = CompoundCommand.from_plan(plan)
            return await (gateway.receipt if read else gateway.apply)(
                command, plan.actions[0].id
            )

    return asyncio.run(run())


@pytest.mark.parametrize("outcome", ["succeeded", "failed"])
def test_verified_receipt_uses_only_its_own_scoped_token(outcome):
    plan = prepared()
    proof = receipt(plan, 0, outcome)
    calls = []

    def responder(request):
        calls.append(request)
        assert request.url.path == "/v1/assistant-tools/compound-actions"
        assert request.headers["Authorization"] == "Bearer write-only"
        dispatch = CompoundDispatch.model_validate_json(request.content)
        assert dispatch.command == CompoundCommand.from_plan(plan)
        return httpx.Response(200, json=proof.model_dump(mode="json"))

    assert run_transport(plan, responder) == proof
    assert len(calls) == 1
    with pytest.raises(ToolUnavailable):
        run_transport(plan, responder, write_token="")
    assert len(calls) == 1


@pytest.mark.parametrize(
    "field,value",
    [
        ("action_id", str(uuid4())),
        ("operation_id", str(uuid4())),
        ("product_id", str(uuid4())),
        ("revision", str(uuid4())),
        ("quantity", 3),
        ("destination", "wishlist"),
        ("receipt_id", str(UUID(int=0))),
        ("observed_at", 0),
        ("observed_at", int(time.time()) + 3600),
    ],
)
def test_uncorrelated_receipt_cannot_establish_outcome(field, value):
    plan = prepared()
    proof = receipt(plan, 0).model_dump(mode="json")
    proof[field] = value
    with pytest.raises(ToolUnavailable):
        run_transport(plan, lambda _: httpx.Response(200, json=proof))


@pytest.mark.parametrize("field", ["tenant_id", "customer_id", "conversation_id"])
def test_cross_scope_receipt_cannot_establish_outcome(field):
    plan = prepared()
    proof = receipt(plan, 0).model_dump(mode="json")
    proof["scope"][field] = str(uuid4())
    with pytest.raises(ToolUnavailable):
        run_transport(plan, lambda _: httpx.Response(200, json=proof))


@pytest.mark.parametrize(
    "failure", ["timeout", "malformed", "oversized", "http", "denied"]
)
def test_lost_or_invalid_response_never_retries_or_invents_failure(failure):
    plan = prepared()
    calls = []

    def responder(request):
        calls.append(request)
        if failure == "timeout":
            raise httpx.ReadTimeout("lost reply")
        if failure == "malformed":
            return httpx.Response(200, json={"outcome": "succeeded"})
        if failure == "oversized":
            return httpx.Response(200, content=b" " * 16385)
        return httpx.Response(403 if failure == "denied" else 500)

    with pytest.raises(ToolDenied if failure == "denied" else ToolUnavailable):
        run_transport(plan, responder)
    assert len(calls) == 1


@pytest.mark.parametrize("saved", [False, True])
def test_lost_reply_reconciles_by_read_without_repeating_success_or_starting_successor(
    saved,
):
    plan = prepared()
    running = outcomes.claim(plan, plan.actions[0].id, now=int(time.time()))
    unknown = outcomes.uncertain(running, plan.actions[0].id)
    proof = receipt(plan, 0)
    store, connection = store_for(row(unknown))
    calls = []

    def responder(request):
        calls.append(request)
        assert request.url.path.endswith("/receipt")
        assert request.headers["Authorization"] == "Bearer receipt-only"
        return httpx.Response(
            200,
            json={
                "schema_version": "1.0",
                "receipt": proof.model_dump(mode="json") if saved else None,
            },
        )

    async def run():
        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(responder)
        ) as client:
            port = CompoundCommerce(client, "receipt-only")
            result = await reconcile(unknown, port, store)
            if saved:
                assert await reconcile(result, port, store) == result
            return result

    result = asyncio.run(run())
    assert len(calls) == 1
    assert result.actions[0].state == ("succeeded" if saved else "outcome_unknown")
    assert result.actions[1].state == "not_started"
    assert bool(connection.calls) == saved


def test_failed_first_operation_is_presented_as_failure():
    plan = prepared()
    running = outcomes.claim(plan, plan.actions[0].id, now=int(time.time()))
    failed = outcomes.record(running, receipt(plan, 0, "failed"))
    message = describe(failed)
    assert "cart: failed" in message and "wishlist: not started" in message
