import copy
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest

from app.commerce_action_engine.execution.planning.execution import verify_receipt
from app.commerce_action_engine.platform.telemetry import (
    TurnTrace,
    execution_summary,
    trace_turn,
)
from app.commerce_resolution_engine.runtime import RuntimeErrorCode


def proposal():
    task, identifier = uuid4(), uuid4()
    now = datetime.now(UTC)
    return task, {
        "id": str(identifier),
        "can_apply": True,
        "issues": [],
        "execution": {
            "schema_version": "1.0",
            "goal_id": str(task),
            "revision": 1,
            "state": "awaiting_confirmation",
            "verdict": "pass",
            "playbook": "playbook://commerce/shop",
            "version": "1.0.0",
            "proposal_id": str(identifier),
            "observed_at": now.isoformat(),
            "expires_at": (now + timedelta(minutes=5)).isoformat(),
            "reasons": [],
        },
    }


def test_execution_receipt_is_additive_and_records_only_authoritative_reference():
    task, value = proposal()
    receipt = verify_receipt(value, task, "shop")
    assert receipt and receipt.verdict == "pass"
    trace = TurnTrace()
    with trace_turn(trace):
        execution_summary(receipt.model_dump(mode="json"))
    assert trace.execution["proposal_id"] == value["id"]
    assert "goal" not in trace.execution and "arguments" not in trace.execution
    del value["execution"]
    assert verify_receipt(value, task, "shop") is None


@pytest.mark.parametrize(
    "field,value",
    [
        ("schema_version", "9.0"),
        ("version", "9.0.0"),
        ("goal_id", str(uuid4())),
        ("proposal_id", str(uuid4())),
        ("playbook", "playbook://commerce/optimize"),
        ("state", "completed"),
        ("state", "needs_input"),
        ("verdict", "blocked"),
        ("revision", 0),
        ("reasons", ["unavailable_item"]),
        ("observed_at", "2099-01-01T00:00:00Z"),
        ("expires_at", "2000-01-01T00:00:00Z"),
        ("expires_at", "2099-01-01T00:00:00Z"),
        ("hidden_reasoning", "untrusted"),
    ],
)
def test_invalid_or_failed_receipt_cannot_be_overridden_by_success_text(field, value):
    task, data = proposal()
    data["execution"][field] = value
    with pytest.raises(RuntimeErrorCode, match="execution_verification_failed"):
        verify_receipt(data, task, "shop")


def test_unresolved_and_malformed_results_fail_closed():
    task, data = proposal()
    data["issues"] = ["Insufficient stock"]
    with pytest.raises(RuntimeErrorCode):
        verify_receipt(data, task, "shop")
    data["can_apply"] = False
    data["execution"].update(
        state="needs_input", verdict="needs_input", reasons=["unavailable_item"]
    )
    assert verify_receipt(data, task, "shop").verdict == "needs_input"
    malformed = copy.deepcopy(data)
    malformed["can_apply"] = "false"
    with pytest.raises(RuntimeErrorCode):
        verify_receipt(malformed, task, "shop")
    data["execution"] = None
    with pytest.raises(RuntimeErrorCode):
        verify_receipt(data, task, "shop")


def test_enabled_execution_cannot_silently_lose_its_receipt():
    task, data = proposal()
    del data["execution"]
    with pytest.raises(RuntimeErrorCode):
        verify_receipt(data, task, "shop", required=True)


def test_real_basket_response_path_stops_before_rendering_failed_verification(
    monkeypatch,
):
    import asyncio

    from test_baskets import (
        BasketGoal,
        BasketPlan,
        BasketTools,
        SearchLine,
        ShoppingIntent,
        scenario,
    )

    original = BasketTools.call

    async def invalid_receipt(self, method, task, draft=None):
        data = await original(self, method, task, draft)
        if method == "POST":
            _, sample = proposal()
            sample["execution"].update(
                goal_id=str(task), proposal_id=data["id"], verdict="blocked"
            )
            data["execution"] = sample["execution"]
        return data

    monkeypatch.setattr(BasketTools, "call", invalid_receipt)
    plan = BasketPlan(
        goal=BasketGoal(purpose="Shoes", budget="150", currency="USD"),
        searches=[
            SearchLine(intent=ShoppingIntent(shopping=True, query="shoes"), quantity=1)
        ],
    )
    with pytest.raises(RuntimeErrorCode, match="execution_verification_failed"):
        asyncio.run(scenario(plan))
