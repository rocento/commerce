"""Compound coordination never broadens admission or replays uncertain writes."""

import asyncio
import time
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from test_compound_planning import WHO, Reader, interpreted, prepared, receipt, resolved

from app.commerce_action_engine.application.compound_coordinator import (
    CompoundPreparationFailed,
    CompoundRequest,
    CompoundReviewOnly,
    NoCompoundRecovery,
    PreparedCompound,
    RecoveredCompound,
    prepare_compound_review,
    publish_compound_clarification,
    recover_compound,
    review_compound,
)
from app.commerce_action_engine.application.handlers import compound
from app.commerce_action_engine.application.persistence import CompoundPersistence
from app.commerce_action_engine.execution.planning import outcomes
from app.commerce_action_engine.execution.planning.compound_review import Review


def request_for(plan):
    return CompoundRequest(
        plan.request_id,
        plan.scope.conversation_id,
        plan.revision,
        plan.input_hash,
        "add 2 banana to cart then add 1 apples to wishlist",
    )


def commerce():
    tools = Reader()
    tools.catalog_capability = "catalog"
    tools.compound = SimpleNamespace(
        read_token="receipts",
        write_token="writes",
        apply=AsyncMock(),
        receipt=AsyncMock(return_value=None),
    )
    return tools


def preparation(plan, tools, storage, *, interpretation=None, **options):
    result = interpretation or interpreted(resolved())
    review = review_compound(result)
    assert review is not None
    return prepare_compound_review(
        options.pop("review", review),
        result,
        WHO,
        options.pop("request", request_for(plan)),
        storage=storage,
        commerce_tools=tools,
        **(
            {
                "store_available": True,
                "planning_enabled": True,
                "execution_enabled": True,
            }
            | options
        ),
    )


@pytest.mark.parametrize(
    "missing", ["store", "reader", "customer", "conversation", "saved_plan"]
)
def test_recovery_missing_context_never_initializes_commerce(missing):
    plan = prepared()
    reader = SimpleNamespace(get_compound_plan=AsyncMock(return_value=None))
    ports = CompoundPersistence(reader=None if missing == "reader" else reader)
    who = WHO.model_copy(update={"subject": None}) if missing == "customer" else WHO
    request = request_for(plan)
    if missing == "conversation":
        request = replace(request, conversation_id=None)
    factory = Mock(side_effect=AssertionError("commerce must remain lazy"))
    result = asyncio.run(
        recover_compound(
            who,
            request,
            storage=ports,
            commerce_tools=factory,
            store_present=missing != "store",
        )
    )
    assert isinstance(result, NoCompoundRecovery)
    factory.assert_not_called()
    assert reader.get_compound_plan.await_count == int(missing == "saved_plan")


@pytest.mark.parametrize("reconcile", ["no_outcomes", "no_read_token", "read_only"])
def test_saved_recovery_receipt_read_is_independent_of_mutation_admission(reconcile):
    plan = prepared()
    plan = outcomes.uncertain(
        outcomes.claim(plan, plan.actions[0].id, now=int(time.time())),
        plan.actions[0].id,
    )
    tools = commerce()
    tools.catalog_capability = ""
    tools.compound.write_token = ""
    if reconcile == "no_read_token":
        tools.compound.read_token = ""
    holder = SimpleNamespace(plan=plan)
    proof = receipt(plan, 0)
    tools.compound.receipt.return_value = proof

    async def get(scope, request, fingerprint):
        assert (scope, request, fingerprint) == (
            plan.scope,
            plan.request_id,
            plan.input_hash,
        )
        return holder.plan

    async def transition(scope, request, action, *, transition, receipt):
        assert transition == "receipt" and receipt == proof
        holder.plan = outcomes.record(holder.plan, receipt)
        return holder.plan

    store = SimpleNamespace(
        get_compound_plan=AsyncMock(side_effect=get),
        transition_compound=AsyncMock(side_effect=transition),
    )
    ports = CompoundPersistence(
        reader=store,
        outcomes=None if reconcile == "no_outcomes" else store,
    )

    async def run():
        first = await recover_compound(
            WHO,
            request_for(plan),
            storage=ports,
            commerce_tools=lambda: tools,
            store_present=True,
        )
        second = await recover_compound(
            WHO,
            request_for(plan),
            storage=ports,
            commerce_tools=lambda: tools,
            store_present=True,
        )
        return first, second

    first, second = asyncio.run(run())
    assert isinstance(first, RecoveredCompound) and second == first
    assert first.plan.action_states == (
        "succeeded" if reconcile == "read_only" else "outcome_unknown",
        "not_started",
    )
    assert not first.plan.verified_receipts
    assert tools.compound.receipt.await_count == int(reconcile == "read_only")
    assert store.transition_compound.await_count == int(reconcile == "read_only")
    tools.compound.apply.assert_not_awaited()
    assert tools.calls == []


@pytest.mark.parametrize("complete", [False, True])
def test_only_all_succeeded_receipts_prove_recovered_completion(complete):
    plan = prepared()
    for index in range(2):
        plan = outcomes.claim(plan, plan.actions[index].id, now=int(time.time()))
        plan = outcomes.record(
            plan,
            receipt(plan, index, "succeeded" if complete or index == 0 else "failed"),
        )
    store = SimpleNamespace(get_compound_plan=AsyncMock(return_value=plan))
    result = asyncio.run(
        recover_compound(
            WHO,
            request_for(plan),
            storage=CompoundPersistence(reader=store),
            commerce_tools=Mock(side_effect=AssertionError("no outcome port")),
            store_present=True,
        )
    )
    assert isinstance(result, RecoveredCompound)
    assert result.plan.verified_receipts is complete
    assert result.plan.plan_id == plan.id and result.plan.choice is None


@pytest.mark.parametrize(
    "missing",
    [
        "understood",
        "pair",
        "feature",
        "store",
        "plans",
        "revision",
        "conversation",
        "catalog",
    ],
)
def test_preparation_checks_all_admission_guards_before_any_lookup(
    missing, monkeypatch
):
    plan, tools = prepared(), commerce()
    request = request_for(plan)
    options = {}
    result = interpreted(resolved())
    if missing == "understood":
        options["review"] = Review("needs_product", "Which product?", True)
    if missing == "pair":
        result = result.model_copy(
            update={
                "requested_actions": result.requested_actions.model_copy(
                    update={"requestedActions": []}
                )
            }
        )
        options["review"] = Review("understood", "Understood")
    if missing == "feature":
        options["planning_enabled"] = False
    if missing == "store":
        options["store_available"] = False
    if missing in {"revision", "conversation"}:
        request = replace(
            request,
            **{"revision" if missing == "revision" else "conversation_id": None},
        )
    if missing == "catalog":
        tools.catalog_capability = ""
    factory = Mock(return_value=tools)
    prepare = AsyncMock(side_effect=AssertionError("not eligible"))
    monkeypatch.setattr(compound, "prepare_response", prepare)
    result = asyncio.run(
        prepare_compound_review(
            options.pop("review", Review("understood", "Understood")),
            result,
            WHO,
            request,
            storage=CompoundPersistence(
                plans=None if missing == "plans" else SimpleNamespace()
            ),
            commerce_tools=factory,
            **(
                {
                    "store_available": True,
                    "planning_enabled": True,
                    "execution_enabled": True,
                }
                | options
            ),
        )
    )
    assert isinstance(result, CompoundReviewOnly)
    prepare.assert_not_awaited()
    assert factory.call_count == int(missing == "catalog")
    assert tools.calls == []
    tools.compound.apply.assert_not_awaited()


@pytest.mark.parametrize(
    "missing", [None, "feature", "write", "read", "execution_store"]
)
def test_writer_requires_both_tokens_flag_and_execution_port(missing, monkeypatch):
    plan, tools = prepared(), commerce()
    if missing in {"write", "read"}:
        setattr(tools.compound, missing + "_token", "")
    execution = None if missing == "execution_store" else SimpleNamespace()
    ports = CompoundPersistence(plans=SimpleNamespace(), execution=execution)
    prepare = AsyncMock(return_value=("saved plan", plan))
    monkeypatch.setattr(compound, "prepare_response", prepare)
    result = asyncio.run(
        preparation(
            plan,
            lambda: tools,
            ports,
            execution_enabled=missing != "feature",
        )
    )
    assert isinstance(result, PreparedCompound) and result.plan.text == "saved plan"
    assert not result.plan.verified_receipts
    kwargs = prepare.await_args.kwargs
    assert kwargs["fingerprint"] == plan.input_hash
    assert kwargs["revision"] == plan.revision
    assert kwargs["writer"] is (tools.compound if missing is None else None)
    assert kwargs["execution_store"] is execution
    prepare.assert_awaited_once()
    tools.compound.apply.assert_not_awaited()


def test_failed_preparation_is_explicit_and_cannot_supply_receipt_evidence(monkeypatch):
    plan, tools = prepared(), commerce()
    prepare = AsyncMock(return_value=("could not prepare", None))
    monkeypatch.setattr(compound, "prepare_response", prepare)
    result = asyncio.run(
        preparation(plan, lambda: tools, CompoundPersistence(plans=SimpleNamespace()))
    )
    assert isinstance(result, CompoundPreparationFailed)
    assert result.text == "could not prepare"
    prepare.assert_awaited_once()


@pytest.mark.parametrize(
    "missing",
    [
        None,
        "reply",
        "revision",
        "store",
        "publisher",
        "customer",
        "conversation",
        "rejected",
    ],
)
def test_clarification_publication_requires_exact_scope_and_acknowledgement(missing):
    plan = prepared()
    request = request_for(plan)
    if missing in {"revision", "conversation"}:
        request = replace(
            request,
            **{"revision" if missing == "revision" else "conversation_id": None},
        )
    principal = (
        WHO.model_copy(update={"subject": None}) if missing == "customer" else WHO
    )
    publisher = SimpleNamespace(
        publish_question=AsyncMock(return_value=missing != "rejected")
    )
    result = asyncio.run(
        publish_compound_clarification(
            Review("needs_product", "Which product?", missing != "reply"),
            principal,
            request,
            publisher=None if missing == "publisher" else publisher,
            store_available=missing != "store",
        )
    )
    assert (result is not None) == (missing is None)
    if missing in {None, "rejected"}:
        publisher.publish_question.assert_awaited_once_with(
            WHO.tenant,
            WHO.subject,
            plan.scope.conversation_id,
            plan.revision,
            request.message,
            "Which product?",
        )
    else:
        publisher.publish_question.assert_not_awaited()


@pytest.mark.parametrize(
    "step", ["lookup", "receipt", "receipt_save", "prepare", "question"]
)
def test_cancellation_propagates_without_repeating_reads_claims_or_publication(
    step, monkeypatch
):
    plan, tools = prepared(), commerce()
    plan = outcomes.uncertain(
        outcomes.claim(plan, plan.actions[0].id, now=int(time.time())),
        plan.actions[0].id,
    )
    proof = receipt(plan, 0)
    tools.compound.receipt.return_value = proof
    store = SimpleNamespace(
        get_compound_plan=AsyncMock(return_value=plan),
        transition_compound=AsyncMock(return_value=plan),
        publish_question=AsyncMock(return_value=True),
    )
    prepare = AsyncMock(return_value=("ready", plan))
    monkeypatch.setattr(compound, "prepare_response", prepare)

    async def run():
        entered, closed = asyncio.Event(), asyncio.Event()

        async def block(*args, **kwargs):
            entered.set()
            try:
                await asyncio.Future()
            finally:
                closed.set()

        target = {
            "lookup": store.get_compound_plan,
            "receipt": tools.compound.receipt,
            "receipt_save": store.transition_compound,
            "prepare": prepare,
            "question": store.publish_question,
        }[step]
        target.side_effect = block
        if step == "prepare":
            operation = preparation(
                plan, lambda: tools, CompoundPersistence(plans=store)
            )
        elif step == "question":
            operation = publish_compound_clarification(
                Review("needs_product", "Which?", True),
                WHO,
                request_for(plan),
                publisher=store,
                store_available=True,
            )
        else:
            operation = recover_compound(
                WHO,
                request_for(plan),
                storage=CompoundPersistence(reader=store, outcomes=store),
                commerce_tools=lambda: tools,
                store_present=True,
            )
        task = asyncio.create_task(operation)
        await asyncio.wait_for(entered.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert closed.is_set()
        target.assert_awaited_once()
        assert all(method.await_count <= 1 for method in vars(store).values())
        tools.compound.apply.assert_not_awaited()
        assert tools.calls == []

    asyncio.run(run())
