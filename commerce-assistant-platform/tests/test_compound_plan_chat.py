"""Real language → existing planner → scoped catalog reads → saved plan/SSE."""

import json
import time
from dataclasses import replace
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414
from test_compound_clarification import NoModel, Revisions, question, text
from test_compound_planning import receipt
from test_language_understanding import real_resolve
from test_shopping import product

from app.commerce_action_engine.application import bootstrap
from app.commerce_action_engine.application.handlers import compound
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.language import gate
from app.commerce_action_engine.execution.planning import outcomes
from app.commerce_action_engine.execution.planning.outcomes import supersede

MESSAGE = "add 2 banana to cart then add 1 apples to wishlist"


class Plans(Revisions):
    def __init__(self):
        super().__init__()
        self.plans = {}
        self.receipts = {}

    async def transition_compound(
        self, scope, request, action_id, *, transition, receipt=None
    ):
        plan = self.plans[(scope, request)]
        if transition == "dispatch":
            current = self.active.get(
                (scope.tenant_id, scope.customer_id, scope.conversation_id)
            )
            if not plan.execution_enabled or not current or current[0] != plan.revision:
                raise ValueError("superseded or non-executable")
            result = outcomes.claim(plan, action_id, now=int(time.time()))
        elif transition == "uncertain":
            result = outcomes.uncertain(plan, action_id)
        elif transition == "stop":
            result = outcomes.stop(plan)
        else:
            assert transition == "receipt" and receipt.action_id == action_id
            result = outcomes.record(plan, receipt)
        self.plans[(scope, request)] = result
        return result

    async def get_compound_plan(self, scope, request, fingerprint):
        plan = self.plans.get((scope, request))
        if plan is None:
            return None
        if plan.input_hash != fingerprint:
            raise ValueError("changed request")
        current = self.active.get(
            (scope.tenant_id, scope.customer_id, scope.conversation_id)
        )
        return plan if current and current[0] == plan.revision else supersede(plan)

    async def save_compound_plan(self, plan):
        scope = plan.scope
        current = self.active.get(
            (scope.tenant_id, scope.customer_id, scope.conversation_id)
        )
        if not current or current[0] != plan.revision:
            return None
        self.plans.setdefault((scope, plan.request_id), plan)
        return self.plans[(scope, plan.request_id)]


@pytest.fixture
def chat(identity, monkeypatch, request):
    settings, _, headers = identity
    store = Plans()
    monkeypatch.setattr(bootstrap, "Store", lambda _: store)
    monkeypatch.setattr(gate, "resolve", real_resolve)
    prepare_journey = compound.prepare_journey

    async def checked_journey(result, *args, **kwargs):
        assert isinstance(result, InterpretedRequest)
        assert result.request_id == str(kwargs["request"])
        assert result.requested_actions.intentCount == 2
        assert len(result.requested_actions.requestedActions) == 2
        return await prepare_journey(result, *args, **kwargs)

    monkeypatch.setattr(compound, "prepare_journey", checked_journey)
    calls = []
    mode = getattr(request, "param", True)
    products = [
        product(1, name="banana", sku="BAN-1"),
        product(2, name="apples", sku="APP-1"),
    ]

    def commerce(request):
        if request.url.path == "/v1/assistant-tools/compound-actions":
            assert mode in {"execute", "lost_first", "fail_second"}
            assert request.headers["Authorization"] == "Bearer write-test"
            data = json.loads(request.content)
            calls.append(data)
            plan = next(
                p
                for p in store.plans.values()
                if str(p.request_id) == data["command"]["request_id"]
            )
            index = next(
                i for i, a in enumerate(plan.actions) if str(a.id) == data["action_id"]
            )
            assert plan.actions[index].state == "running"
            if index:
                assert plan.actions[0].state == "succeeded"
            proof = receipt(
                plan,
                index,
                "failed" if mode == "fail_second" and index == 1 else "succeeded",
            )
            store.receipts[data["action_id"]] = proof
            if mode == "lost_first" and index == 0:
                raise httpx.ReadTimeout("response lost after commit")
            return httpx.Response(200, json=proof.model_dump(mode="json"))
        if request.url.path == "/v1/assistant-tools/compound-actions/receipt":
            assert request.headers["Authorization"] == "Bearer receipt-test"
            data = json.loads(request.content)
            calls.append(data)
            proof = store.receipts.get(data["action_id"])
            return httpx.Response(
                200,
                json={
                    "schema_version": "1.0",
                    "receipt": proof.model_dump(mode="json") if proof else None,
                },
            )
        assert request.url.path == "/v1/assistant-tools/shopper", (
            "Unexpected mutation endpoint"
        )
        assert request.headers["Authorization"] == "Bearer catalog-test"
        data = json.loads(request.content)
        assert data["name"] in {"search_products", "get_product"}, (
            "Unexpected commerce mutation"
        )
        calls.append(data)
        key = "name" if data["name"] == "search_products" else "id"
        value = data["arguments"]["query" if key == "name" else "product_id"]
        return httpx.Response(
            200,
            json={
                "products": [
                    p
                    for p in products
                    if p[key] == value
                    or key == "name"
                    and (
                        value.lower() in p["name"].lower()
                        or value.lower() == p["sku"].lower()
                    )
                ],
                "category": None,
            },
        )

    settings = replace(
        settings,
        store_password_file="test-only",
        feature_flags=frozenset(
            {"commerce_planning"}
            | (
                {"compound_execution"}
                if mode in {"execute", "lost_first", "fail_second", "missing_write"}
                else set()
            )
        )
        if mode
        else frozenset(),
    )
    with TestClient(
        bootstrap.create_app(
            settings, model=NoModel(), transport=httpx.MockTransport(commerce)
        )
    ) as client:
        conversation = str(uuid4())

        def send(message=MESSAGE, *, request=None, clarification=None):
            request = request or str(uuid4())
            response = client.post(
                "/v1/chat",
                headers={
                    **headers(request_id=request),
                    "x-commerce-catalog-token": "catalog-test",
                    "x-commerce-compound-read-token": "receipt-test",
                    **(
                        {"x-commerce-compound-write-token": "write-test"}
                        if mode
                        in {"execute", "lost_first", "fail_second", "flag_off_token"}
                        else {}
                    ),
                },
                json={
                    "request_id": request,
                    "conversation_id": conversation,
                    "message": message,
                    **({"clarification": clarification} if clarification else {}),
                },
            )
            assert response.status_code == 200
            events = [
                json.loads(line[6:])
                for line in response.text.splitlines()
                if line.startswith("data: ")
            ]
            assert events[-1]["type"] == "done"
            return events

        yield send, store, calls, products


def test_complete_pair_is_read_only_persisted_and_recovered_without_new_calls(chat):
    send, store, calls, _ = chat
    request = str(uuid4())
    first = send(request=request)
    assert "I matched both" in text(first), first
    assert "No changes have been made" in text(first)
    assert len(calls) == 4 and len(store.plans) == 1
    plan = next(iter(store.plans.values()))
    assert plan.language_status == "RESOLVED"
    assert plan.execution_enabled is False
    assert [a.quantity for a in plan.actions] == [2, 1]
    assert all(a.state == "ready" for a in plan.actions)
    assert "I matched both" in text(send(request=request))
    assert len(calls) == 4 and len(store.plans) == 1
    bad = send("add 8 banana to cart and also to wishlist", request=request)
    assert any(e["type"] == "error" for e in bad)
    assert len(calls) == 4


def test_product_clarification_enters_planning_with_complete_actions(chat):
    send, store, calls, _ = chat
    pending = question(send("add 2 of it to cart then add 1 apples to wishlist"))
    assert not calls
    answer = send("banana", clarification=pending)
    assert "I matched both" in text(answer), answer
    assert len(store.plans) == 1
    plan = next(iter(store.plans.values()))
    assert [a.quantity for a in plan.actions] == [2, 1]
    assert plan.language_status == "RESOLVED"


def test_interpretation_conflict_asks_before_any_catalog_or_write_call(
    chat, monkeypatch
):
    send, store, calls, _ = chat

    async def conflicting(url, message, *, context=None):
        result = await real_resolve(url, message, context=context)
        return gate.Resolution.model_validate(
            {
                **result.model_dump(),
                "requestedActionIssues": ["INTERPRETATION_CONFLICT"],
            }
        )

    monkeypatch.setattr(gate, "resolve", conflicting)
    response = send()
    assert "interpretations disagree" in text(response)
    assert question(response)
    assert not calls and not store.plans


def test_saved_unknown_outcome_reconciles_on_chat_replay_without_write_or_language(
    chat,
):
    send, store, calls, _ = chat
    request = str(uuid4())
    send(request=request)
    plan = next(iter(store.plans.values()))
    running = outcomes.claim(plan, plan.actions[0].id, now=int(time.time()))
    unknown = outcomes.uncertain(running, plan.actions[0].id)
    store.plans[(plan.scope, plan.request_id)] = unknown
    assert "unconfirmed" in text(send(request=request))
    proof = receipt(plan, 0)
    store.receipts[str(plan.actions[0].id)] = proof
    assert "cart: succeeded; wishlist: not started" in text(send(request=request))
    call_count = len(calls)
    assert "cart: succeeded" in text(send(request=request))
    assert len(calls) == call_count == 6


def test_new_request_supersedes_old_plan_without_replaying_it(chat):
    send, store, calls, _ = chat
    request = str(uuid4())
    send(request=request)
    old = next(iter(store.plans.values()))
    send()
    assert len(store.plans) == 2
    assert len(calls) == 8
    response = send(request=request)
    assert "was replaced" in text(response) and len(calls) == 8
    assert next(iter(store.plans.values())).id == old.id


def test_ambiguous_product_keeps_both_actions_without_false_completion(chat):
    send, store, calls, products = chat
    products.append(product(3, name="banana", sku="BAN-2"))
    answer = send()
    assert "choose the exact product" in text(answer)
    assert "BAN-1" in json.dumps(answer) and "BAN-2" in json.dumps(answer)
    plan = next(iter(store.plans.values()))
    assert plan.actions[0].state == "needs_input" and plan.actions[1].state == "ready"
    assert len(calls) == 3
    assert store.saved[-1][-1]["completion"]["status"] == "clarification"


def test_missing_procedure_never_falls_back_to_a_single_action(chat, monkeypatch):
    send, store, calls, _ = chat

    def unavailable():
        raise OSError("missing")

    monkeypatch.setattr(
        "app.commerce_action_engine.execution.planning.runtime.library", unavailable
    )
    answer = send()
    assert "could not prepare the complete request" in text(answer)
    assert not calls and not store.plans


@pytest.mark.parametrize("chat", [False], indirect=True)
def test_disabled_planner_keeps_review_without_reading_or_writing(chat):
    send, store, calls, _ = chat
    response = send()
    assert "Requested actions:" in text(response)
    assert "No changes have been made" in text(response)
    assert not calls and not store.plans


@pytest.mark.parametrize("chat", ["execute"], indirect=True)
def test_enabled_chat_executes_serially_and_replay_never_dispatches(chat):
    send, store, calls, _ = chat
    request = str(uuid4())
    events = send(request=request)
    assert "cart: succeeded; wishlist: succeeded" in text(events)
    plan = next(iter(store.plans.values()))
    assert plan.execution_enabled and all(a.receipt for a in plan.actions)
    assert len([c for c in calls if "command" in c]) == 2
    assert store.saved[-1][-1]["completion"]["status"] == "completed"
    count = len(calls)
    assert "cart: succeeded; wishlist: succeeded" in text(send(request=request))
    assert len(calls) == count


@pytest.mark.parametrize("chat", ["lost_first"], indirect=True)
def test_lost_http_response_reconciles_without_resending_or_starting_successor(chat):
    send, store, calls, _ = chat
    request = str(uuid4())
    assert "cart: unconfirmed; wishlist: not started" in text(send(request=request))
    assert store.saved[-1][-1]["completion"]["status"] == "unverified"
    assert len([c for c in calls if "command" in c]) == 1
    assert "cart: succeeded; wishlist: not started" in text(send(request=request))
    assert len(store.receipts) == 1
    assert (
        len([c for c in calls if "command" in c]) == 2
    )  # One write, one receipt lookup.
    count = len(calls)
    send(request=request)
    assert len(calls) == count


@pytest.mark.parametrize("chat", ["fail_second"], indirect=True)
def test_chat_preserves_first_success_when_second_fails(chat):
    send, store, _calls, _ = chat
    assert "cart: succeeded; wishlist: failed" in text(send())
    assert len(store.receipts) == 2
    assert store.saved[-1][-1]["completion"]["status"] == "unverified"


@pytest.mark.parametrize("chat", ["missing_write", "flag_off_token"], indirect=True)
def test_feature_flag_and_delegated_capability_are_both_required(chat):
    send, store, calls, _ = chat
    assert "No changes have been made" in text(send())
    assert not next(iter(store.plans.values())).execution_enabled
    assert all("command" not in c for c in calls)


@pytest.mark.parametrize("chat", ["execute"], indirect=True)
def test_enabled_chat_still_clarifies_before_any_writes(chat):
    send, store, calls, _ = chat
    pending = question(send("add 2 of it to cart then add 1 apples to wishlist"))
    assert not calls
    events = send("banana", clarification=pending)
    assert "cart: succeeded; wishlist: succeeded" in text(events)
    assert len(store.receipts) == 2


@pytest.mark.parametrize("chat", ["execute"], indirect=True)
def test_product_cards_confirm_full_request_and_recheck_before_writes(chat):
    send, _store, calls, products = chat
    products[0]["name"] = "Bananas 1kg"
    first = send()
    assert not any("command" in call for call in calls)
    blocks = [b for e in first for b in e.get("blocks", [])]
    card = next(b["compound_choice"] for b in blocks if b["kind"] == "compound_choice")
    assert [a["quantity"] for a in card["actions"]] == [2, 1]
    assert card["actions"][0]["choices"][0]["name"] == "Bananas 1kg"
    request = str(uuid4())
    command = 'Add 2 "BAN-1" to cart then Add 1 "APP-1" to wishlist'
    completed = send(command, request=request)
    assert "cart: succeeded; wishlist: succeeded" in text(completed), completed
    writes = [c for c in calls if "command" in c]
    assert len(writes) == 2
    send(command, request=request)
    assert len([c for c in calls if "command" in c]) == 2
