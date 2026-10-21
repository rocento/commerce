"""Complete-request binding through the existing planner and serial receipt rules."""

import asyncio
import json
import time
from copy import deepcopy
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from test_requested_actions_contract import metadata
from test_shopping import product

from app.commerce_action_engine.contracts.action import ActorContext
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.agents import Principal
from app.commerce_action_engine.execution.core.planning import PlanningError
from app.commerce_action_engine.execution.language.compatibility import (
    adapt_legacy_resolution,
)
from app.commerce_action_engine.execution.language.gate import Resolution
from app.commerce_action_engine.execution.planning import outcomes
from app.commerce_action_engine.execution.planning.compound import admissible, prepare
from app.commerce_action_engine.execution.planning.runtime import PlanningSession
from app.commerce_action_engine.shared.errors import RuntimeErrorCode, ToolUnavailable
from app.commerce_contracts.compound_plan import (
    CompoundPlan,
    CompoundReceipt,
)

WHO = Principal(tenant=UUID(int=1), subject=UUID(int=2), persona="shopper")
CONVERSATION = UUID(int=3)


def resolved():
    data = metadata()
    data["requestedActions"][0]["items"] = [{"productText": "banana", "quantity": 2}]
    data["requestedActions"][1]["items"] = [{"productText": "apples", "quantity": 1}]
    return Resolution.model_validate(
        {**data, "status": "NEEDS_CONTEXT", "confidence": 0, "message": "Review"}
    )


class Reader:
    def __init__(self):
        self.calls = []
        self.results = {
            "banana": [product(1, name="banana", sku="BAN-1")],
            "apples": [product(2, name="apples", sku="APP-1")],
        }
        self.failed = False
        self.wrong_product = False

    async def search_cart_product(self, query):
        self.calls.append(("search", query))
        if self.failed:
            raise ToolUnavailable()
        return self.results[query]

    async def product(self, product_id):
        self.calls.append(("product", product_id))
        if self.wrong_product:
            return product(99, name="unrelated")
        return next(
            p
            for group in self.results.values()
            for p in group
            if p["id"] == str(product_id)
        )


def interpreted(result, request=None):
    context = SimpleNamespace(
        actor=ActorContext(
            tenant_id=str(WHO.tenant),
            store_id=str(WHO.tenant),
            session_id=str(CONVERSATION),
            request_id=str(request or UUID(int=4)),
            channel="evaluation",
        )
    )
    projected = adapt_legacy_resolution(result.model_dump(), context)
    assert isinstance(projected, InterpretedRequest)
    return projected


def prepared(reader=None, resolution=None, **kwargs):
    return asyncio.run(
        prepare(
            interpreted(resolution or resolved()),
            WHO,
            reader or Reader(),
            conversation=CONVERSATION,
            request=kwargs.get("request", uuid4()),
            revision=kwargs.get("revision", uuid4()),
            input_hash="a" * 64,
        )
    )


def receipt(plan, index, outcome="succeeded", **updates):
    action = plan.actions[index]
    values = {
        "scope": plan.scope,
        "revision": plan.revision,
        "action_id": action.id,
        "operation_id": action.operation_id,
        "receipt_id": uuid4(),
        "product_id": action.binding.product_id,
        "quantity": action.quantity,
        "destination": action.destination,
        "outcome": outcome,
        "observed_at": int(time.time()),
    }
    return CompoundReceipt(**{**values, **updates})


def test_full_pair_maps_parent_actions_and_per_action_identity():
    reader = Reader()
    plan = prepared(reader)
    assert plan.playbook == "playbook://commerce/compound-review"
    assert [a.state for a in plan.actions] == ["ready", "ready"]
    assert [a.operation for a in plan.actions] == ["cart.add", "cart.save_to_wishlist"]
    assert [a.quantity for a in plan.actions] == [2, 1]
    assert [a.binding.product_id for a in plan.actions] == [UUID(int=11), UUID(int=12)]
    assert (
        plan.actions[1].depends_on
        == plan.actions[1].customer_after
        == plan.actions[0].id
    )
    assert len({a.operation_id for a in plan.actions}) == 2
    assert len(reader.calls) == 4 and plan.execution_enabled is False
    assert CompoundPlan.model_validate_json(plan.model_dump_json()) == plan


def test_identity_stable_for_same_revision_but_new_explicit_request_is_distinct():
    revision = uuid4()
    a, b = prepared(revision=revision), prepared(revision=revision)
    assert a.id == b.id and a.actions[0].operation_id == b.actions[0].operation_id
    assert prepared().actions[0].operation_id != a.actions[0].operation_id


def test_same_product_still_has_two_distinct_parent_and_operation_ids():
    result = resolved()
    result.requestedActions[1].items[0].productText = "banana"
    plan = prepared(resolution=result)
    assert plan.actions[0].binding.product_id == plan.actions[1].binding.product_id
    assert plan.actions[0].operation_id != plan.actions[1].operation_id


@pytest.mark.parametrize(
    "kind",
    [
        "ambiguous",
        "missing",
        "stock",
        "variant",
        "wrong_identity",
        "outage",
        "wishlist_quantity",
    ],
)
def test_incomplete_binding_prevents_first_operation(kind):
    reader, result = Reader(), resolved()
    if kind == "ambiguous":
        reader.results["banana"].append(product(3, name="banana", sku="BAN-2"))
    elif kind == "missing":
        reader.results["banana"] = []
    elif kind == "stock":
        reader.results["banana"][0]["in_stock"] = None
    elif kind == "variant":
        reader.results["banana"][0]["product_type"] = "configurable"
    elif kind == "wrong_identity":
        reader.wrong_product = True
    elif kind == "outage":
        reader.failed = True
    else:
        result.requestedActions[1].items[0].quantity = 2
    plan = prepared(reader, result)
    assert any(a.state == "needs_input" for a in plan.actions)
    with pytest.raises(ValueError):
        outcomes.claim(plan, plan.actions[0].id, now=int(time.time()))
    if kind == "outage":
        assert len(reader.calls) == 1
    if kind == "ambiguous":
        assert len(plan.actions[0].choices) == 2
    if kind == "wishlist_quantity":
        assert plan.actions[1].reason == "quantity_not_supported"


def test_unsupported_shapes_stop_before_any_read():
    for change in ["extra_item", "unit", "condition", "cancel", "denied"]:
        value = resolved().model_dump(mode="json")
        if change == "extra_item":
            value["requestedActions"][0]["items"].append({"productText": "milk"})
        elif change == "unit":
            value["requestedActions"][0]["items"][0]["unit"] = "kg"
        elif change == "condition":
            value["entities"] = {"requestConstraints": []}
        elif change == "cancel":
            value["compoundReply"] = "cancelled"
        else:
            value["status"] = "DENIED"
        result = Resolution.model_validate_json(json.dumps(value))
        assert not admissible(interpreted(result))
        reader = Reader()
        with pytest.raises(PlanningError):
            prepared(reader, result)
        assert reader.calls == []


def test_unavailable_planner_fails_before_catalog_and_explicit_node_cannot_bypass_dependency(
    monkeypatch,
):
    def missing():
        raise OSError("missing library")

    reader = Reader()
    with monkeypatch.context() as patch:
        patch.setattr(
            "app.commerce_action_engine.execution.planning.runtime.library", missing
        )
        with pytest.raises(OSError):
            prepared(reader)
    assert not reader.calls
    from app.commerce_action_engine.actions.catalog import SearchArgs

    session = PlanningSession(
        "compound-review",
        WHO,
        frozenset({"catalog.search_products", "catalog.get_product"}),
    )
    with pytest.raises(RuntimeErrorCode, match="unregistered_port"):
        session.start("catalog.search_products", SearchArgs(query="banana"))
    with pytest.raises(RuntimeErrorCode, match="dependency_incomplete"):
        session.start(
            "catalog.search_products", SearchArgs(query="banana"), node_id="lookup2"
        )


def test_success_receipts_preserve_serial_order_and_are_idempotent():
    plan = prepared()
    now = int(time.time())
    with pytest.raises(ValueError):
        outcomes.claim(plan, plan.actions[1].id, now=now)
    first = outcomes.claim(plan, plan.actions[0].id, now=now)
    with pytest.raises(ValueError):
        outcomes.claim(first, first.actions[0].id, now=now)
    evidence = receipt(first, 0)
    first = outcomes.record(first, evidence)
    assert outcomes.record(first, evidence) == first
    second = outcomes.claim(first, first.actions[1].id, now=now)
    done = outcomes.record(second, receipt(second, 1))
    assert outcomes.recovery(done) == "completed"
    with pytest.raises(ValueError):
        outcomes.claim(done, done.actions[0].id, now=now)


def test_failure_and_timeout_stop_subsequent_actions_without_erasing_success():
    plan = prepared()
    running = outcomes.claim(plan, plan.actions[0].id, now=int(time.time()))
    failed = outcomes.record(running, receipt(running, 0, "failed"))
    assert [a.state for a in failed.actions] == ["failed", "not_started"]
    unknown = outcomes.uncertain(running, running.actions[0].id)
    assert [a.state for a in unknown.actions] == ["outcome_unknown", "not_started"]
    assert outcomes.recovery(unknown) == "reconcile_required"
    with pytest.raises(ValueError):
        outcomes.claim(unknown, unknown.actions[0].id, now=int(time.time()))
    reconciled = outcomes.record(unknown, receipt(unknown, 0))
    assert (
        reconciled.actions[0].state == "succeeded"
        and reconciled.actions[1].state == "not_started"
    )
    first = outcomes.record(running, receipt(running, 0))
    second = outcomes.claim(first, first.actions[1].id, now=int(time.time()))
    partial = outcomes.record(second, receipt(second, 1, "failed"))
    assert (
        outcomes.recovery(partial) == "partial"
        and partial.actions[0].receipt == first.actions[0].receipt
    )


@pytest.mark.parametrize(
    "field",
    ["scope", "revision", "operation_id", "product_id", "quantity", "destination"],
)
def test_forged_or_mismatched_receipt_cannot_create_success(field):
    plan = prepared()
    plan = outcomes.claim(plan, plan.actions[0].id, now=int(time.time()))
    data = receipt(plan, 0).model_dump(mode="json")
    if field == "scope":
        data["scope"]["customer_id"] = str(uuid4())
    elif field == "quantity":
        data[field] = 999
    elif field == "destination":
        data[field] = "wishlist"
    else:
        data[field] = str(uuid4())
    with pytest.raises(ValueError):
        outcomes.record(plan, CompoundReceipt.model_validate_json(json.dumps(data)))


def test_stale_binding_supersession_and_contract_forgery():
    plan = prepared()
    with pytest.raises(ValueError, match="revalidation"):
        outcomes.claim(plan, plan.actions[0].id, now=plan.created_at + 60)
    stale = outcomes.supersede(plan)
    assert [a.state for a in stale.actions] == ["superseded", "superseded"]
    with pytest.raises(ValueError):
        outcomes.claim(stale, stale.actions[0].id, now=int(time.time()))
    for field, value in [("execution_enabled", True), ("id", str(uuid4()))]:
        data = deepcopy(plan.model_dump(mode="json"))
        data[field] = value
        with pytest.raises(ValidationError):
            CompoundPlan.model_validate_json(json.dumps(data))


def test_wishlist_first_preserves_customer_sequence_and_both_operation_mappings():
    data = resolved().model_dump(mode="json")
    actions = data["requestedActions"]
    data["requestedActions"] = [actions[1], actions[0]]
    data["requestedActions"][0].update(id="request1", after=None)
    data["requestedActions"][1].update(id="request2", after="request1")
    plan = prepared(resolution=Resolution.model_validate_json(json.dumps(data)))
    assert [a.operation for a in plan.actions] == ["cart.save_to_wishlist", "cart.add"]
    assert [a.quantity for a in plan.actions] == [1, 2]
    assert plan.actions[1].customer_after == plan.actions[0].id


def test_second_missing_product_blocks_an_otherwise_ready_first_action():
    reader = Reader()
    reader.results["apples"] = []
    plan = prepared(reader)
    assert [a.state for a in plan.actions] == ["ready", "needs_input"]
    with pytest.raises(ValueError):
        outcomes.claim(plan, plan.actions[0].id, now=int(time.time()))


def test_interpretation_disagreement_stops_before_catalog_preparation():
    data = resolved().model_dump(mode="json")
    data["requestedActionIssues"] = ["INTERPRETATION_CONFLICT"]
    reader = Reader()
    with pytest.raises(PlanningError, match="compound_request_not_admitted"):
        prepared(reader, resolution=Resolution.model_validate_json(json.dumps(data)))
    assert reader.calls == []
