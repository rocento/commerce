"""M05 plan safety and integration with the real existing scoped transport adapters."""

import asyncio
import json
from pathlib import Path
from uuid import UUID

import pytest
from pydantic import ValidationError

from app.commerce_action_engine.actions.catalog import CatalogResult, SchemaArgs
from app.commerce_action_engine.contracts.action import ActorContext, DefinitionRef
from app.commerce_action_engine.execution.agents import Principal
from app.commerce_action_engine.execution.core.meaning import ConstraintFrame
from app.commerce_action_engine.execution.core.planning import (
    PlannedNode,
    PlanningBudget,
    PlanningError,
    PlanningLibrary,
    Procedure,
)
from app.commerce_action_engine.execution.core.policy import PolicyFacts, evaluate
from app.commerce_action_engine.execution.planning.library import (
    GoalInput,
    LocalReceipt,
    document,
    industry_rules,
    library,
)
from app.commerce_action_engine.execution.planning.runtime import (
    PlanningSession,
    start_planning,
)
from app.commerce_action_engine.platform.telemetry import (
    TurnTrace,
    planning_summary,
    trace_turn,
)
from app.commerce_resolution_engine.contracts import Message, ModelRequest
from app.commerce_resolution_engine.runtime import RuntimeErrorCode

UID = str(UUID(int=1))
WHO = Principal(tenant=UUID(UID), persona="shopper", subject=UUID(int=2))
CONTEXT = ActorContext(
    tenant_id=UID,
    store_id=UID,
    actor_id=str(WHO.subject),
    session_id=UID,
    request_id=UID,
    channel="evaluation",
)
PORTS = frozenset(port for s in document().skills for port in s.ports)
REF = DefinitionRef(id="playbook://commerce/discovery", version="1.0.0")


def compile_plan(**overrides):
    args = {"capabilities": PORTS, "available_context": frozenset(), "now": 100}
    return library().compile(REF, CONTEXT, **{**args, **overrides})


def session(journey="discovery"):
    return PlanningSession(journey, WHO, PORTS)


def test_all_atomic_skills_declare_contracts_behavior_evidence():
    assert len(document().skills) >= 16
    for skill in document().skills:
        assert skill.input_contract in library().schemas
        assert skill.output_contract in library().schemas
        assert skill.purpose and skill.intents and skill.ports and skill.produces
        assert skill.timeout_ms > 0 and skill.max_attempts >= 1
    assert (
        next(s for s in document().skills if s.id.endswith("apply-approved")).executor
        == "rust_ui"
    )


@pytest.mark.parametrize("name", ["shop", "optimize", "buy-again"])
def test_proven_journeys_have_distinct_versioned_playbooks(name):
    plan = library().compile(
        DefinitionRef(id="playbook://commerce/" + name, version="1.0.0"),
        CONTEXT,
        capabilities=PORTS,
        available_context=frozenset({"basket_capability"}),
    )
    assert plan.playbook.version == "1.0.0" and plan.nodes
    assert plan.reserved.mutations == 0


def test_new_procedure_works_without_planner_core_change():
    original = document().procedures[0]
    added = original.model_copy(
        update={"id": "playbook://commerce/summer-gift", "intents": ("summer_gift",)}
    )
    extension = PlanningLibrary(
        document().skills, (*document().procedures, added), library().schemas
    )
    plan = extension.compile(
        DefinitionRef(id=added.id, version=added.version),
        CONTEXT,
        capabilities=PORTS,
        available_context=frozenset(),
    )
    assert plan.playbook.id == added.id


@pytest.mark.parametrize(
    "field,value",
    [
        ("max_steps", 1),
        ("max_tool_calls", 0),
        ("max_model_calls", 0),
        ("max_tokens", 1),
        ("max_cost_micros", 0),
    ],
)
def test_each_budget_rejects_before_execution(field, value):
    with pytest.raises(PlanningError, match="budget"):
        compile_plan(budget=PlanningBudget(**{field: value}))


def test_unknown_version_tool_arguments_and_cycle_fail_before_execution():
    original = document().procedures[0]
    for nodes, code in [
        (
            (
                original.nodes[0].model_copy(
                    update={
                        "skill": DefinitionRef(
                            id="skill://unregistered/execute", version="1.0.0"
                        )
                    }
                ),
            ),
            "unknown_skill_version",
        ),
        (
            (original.nodes[0].model_copy(update={"depends_on": ("schema",)}),),
            "invalid_or_cyclic_plan",
        ),
        (
            (
                original.nodes[0].model_copy(
                    update={"arguments_json": '{"sql":"delete everything"}'}
                ),
            ),
            "invalid_skill_arguments",
        ),
        ((), "step_budget"),
    ]:
        with pytest.raises(PlanningError, match=code):
            compile_plan(proposed_nodes=nodes)


def test_composition_cannot_remove_mandatory_steps_or_weaken_dependencies():
    nodes = document().procedures[0].nodes
    with pytest.raises(PlanningError, match="required_step_missing"):
        compile_plan(proposed_nodes=(nodes[0],))
    with pytest.raises(PlanningError, match="weakens"):
        compile_plan(
            proposed_nodes=(
                nodes[0],
                nodes[1].model_copy(update={"depends_on": ()}),
                *nodes[2:],
            )
        )


def test_missing_store_capability_and_scope_reject():
    with pytest.raises(PlanningError, match="port_unavailable"):
        compile_plan(capabilities=frozenset())
    original = document().skills[0]
    private = original.model_copy(
        update={
            "visibility": original.visibility.model_copy(
                update={"tenants": (str(UUID(int=99)),)}
            )
        }
    )
    scoped = PlanningLibrary(
        (private, *document().skills[1:]), document().procedures, library().schemas
    )
    with pytest.raises(PlanningError, match="not_authorized"):
        scoped.compile(REF, CONTEXT, capabilities=PORTS, available_context=frozenset())


def test_conflicts_are_recomputed_not_trusted_from_model():
    from test_commerce_meaning import req

    frame = ConstraintFrame(requirements=(req(), req(operator="gte", number="200")))
    assert not frame.conflicts
    with pytest.raises(PlanningError, match="hard_constraint_conflict"):
        compile_plan(constraints=frame)


def test_read_plans_cannot_compose_mutations():
    mutation = next(
        p for p in document().procedures if p.mode == "action_proposal"
    ).nodes[0]
    with pytest.raises(PlanningError):
        compile_plan(proposed_nodes=(*document().procedures[0].nodes, mutation))


def test_action_proposal_requires_matching_scope_policy_and_mutation_budget():
    ref = DefinitionRef(id="playbook://commerce/apply-approved", version="1.0.0")
    actor = CONTEXT.model_copy(update={"scopes": ("cart_write",)})
    kwargs = {
        "capabilities": PORTS,
        "available_context": frozenset({"authenticated", "approved_proposal"}),
        "now": 100,
    }
    with pytest.raises(PlanningError, match="risk_not_authorized"):
        library().compile(ref, actor, **kwargs)
    decision = evaluate(
        PolicyFacts(
            context=actor,
            action="cart_apply",
            resource_tenant=UID,
            resource_store=UID,
            available=True,
            authorized=True,
            evidence_verified=True,
            fresh_until=200,
        ),
        now=100,
    )
    assert decision.outcome == "require_confirmation"
    with pytest.raises(PlanningError, match="resource_budget"):
        library().compile(ref, actor, decisions=(decision,), **kwargs)
    plan = library().compile(
        ref,
        actor,
        decisions=(decision,),
        budget=PlanningBudget(max_mutations=1),
        **kwargs,
    )
    assert (
        plan.mode == "action_proposal"
        and plan.policies[0].outcome == "require_confirmation"
    )
    with pytest.raises(PlanningError, match="risk_not_authorized"):
        library().compile(
            ref,
            actor,
            decisions=(decision.model_copy(update={"actor": CONTEXT}),),
            budget=PlanningBudget(max_mutations=1),
            **kwargs,
        )


def test_dependencies_concurrency_and_call_limit_enforced_at_actual_dispatch():
    s = session()
    with pytest.raises(RuntimeErrorCode, match="dependency_incomplete"):
        s.start("reasoning.shopping", GoalInput(message="coffee"))
    s.start("catalog.get_catalog_schema", SchemaArgs())
    with pytest.raises(RuntimeErrorCode, match="concurrent"):
        s.start("catalog.get_catalog_schema", SchemaArgs())
    s.finish(CatalogResult(products=[], category=None))
    with pytest.raises(RuntimeErrorCode, match="attempt_budget"):
        s.start("catalog.get_catalog_schema", SchemaArgs())


def test_failed_operation_never_replays_or_calls_legacy():
    async def run():
        s = session()
        calls = 0

        async def failed():
            nonlocal calls
            calls += 1
            raise TimeoutError()

        with pytest.raises(TimeoutError):
            await s.perform(
                "catalog.get_catalog_schema", SchemaArgs(), failed, lambda r: r
            )
        with pytest.raises(RuntimeErrorCode, match="stopped"):
            await s.perform(
                "catalog.get_catalog_schema", SchemaArgs(), failed, lambda r: r
            )
        assert calls == 1 and s.failed

    asyncio.run(run())


def test_invalid_output_stops_downstream_execution():
    async def run():
        s = session()

        async def wrong():
            return LocalReceipt(status="checked")

        with pytest.raises(RuntimeErrorCode, match="invalid_result"):
            await s.perform(
                "catalog.get_catalog_schema", SchemaArgs(), wrong, lambda r: r
            )
        assert s.failed

    asyncio.run(run())


def test_model_and_token_reservation_precedes_provider_call():
    async def run():
        from app.commerce_action_engine.actions.shopping import ShoppingIntent

        s = session()
        s.start("catalog.get_catalog_schema", SchemaArgs())
        s.finish(CatalogResult(products=[], category=None))

        class Provider:
            async def generate(self, request):
                raise AssertionError("provider must not run")

        request = ModelRequest(
            messages=(Message("user", "x" * 100000),),
            instructions="",
            max_tokens=100,
            output_schema=ShoppingIntent,
        )
        with pytest.raises(RuntimeErrorCode, match="token_budget"):
            await s.reason("reasoning.shopping", "coffee", Provider(), request)

    asyncio.run(run())


def test_model_assisted_basket_composes_bounded_atomic_search_and_rank():
    s = session("shop")
    s.compose_basket(2)
    by_id = {n.id: n for n in s.plan.nodes}
    assert by_id["search"].max_calls == 2 and by_id["rank"].max_calls == 2
    assert s.plan.reason == "validated_composition"
    assert s.plan.reserved.tools == 5
    with pytest.raises(RuntimeErrorCode):
        s.compose_basket(6)


def test_industry_packs_use_actual_attributes_and_do_not_claim_new_industries():
    assert industry_rules("grocery", ("roast", "imaginary_allergen")).attributes == (
        "roast",
    )
    assert industry_rules(
        "jewelry", ("metal", "gemstone_color", "hallucinated_purity")
    ).attributes == ("metal", "gemstone_color")
    for name in ["pharmacy", "skincare", "electronics"]:
        assert industry_rules(name, ("anything",)).status == "schema_ready"


def test_disabled_or_unavailable_library_falls_back_before_start(monkeypatch):
    assert start_planning(False, "discovery", WHO, {}) is None

    def missing():
        raise OSError()

    monkeypatch.setattr(
        "app.commerce_action_engine.execution.planning.runtime.library", missing
    )
    trace = TurnTrace()
    with trace_turn(trace):
        assert (
            start_planning(True, "discovery", WHO, {}, record_planning=planning_summary)
            is None
        )
    assert trace.planning["reason"] == "planning_library_unavailable"


def test_playbooks_are_data_and_core_has_no_client_imports():
    path = (
        Path(__file__).resolve().parents[1]
        / "app"
        / "commerce_action_engine"
        / "execution"
        / "planning"
        / "planning_library.json"
    )
    payload = json.loads(path.read_text())
    assert set(payload) == {"schema_version", "skills", "procedures", "industries"}
    assert all("nodes" in p and "policies" in p for p in payload["procedures"])
    with pytest.raises(ValidationError):
        Procedure.model_validate_json(
            json.dumps({**payload["procedures"][0], "python": "import psycopg"})
        )


def test_explanation_records_pins_and_no_private_prompt():
    trace = TurnTrace()
    with trace_turn(trace):
        s = PlanningSession("discovery", WHO, PORTS, record_planning=planning_summary)
    assert trace.planning["playbook"] == REF.id
    assert all(row["version"] == "1.0.0" for row in trace.planning["skills"])
    assert "arguments_json" not in json.dumps(trace.planning)
    assert s.plan.reason == "known_journey"


def test_shared_planning_wire_fixtures_and_generation():
    import importlib.util
    import subprocess
    import sys

    root = Path(__file__).resolve().parents[2]
    generator = root / "commerce-ops/scripts/contracts/generate_planning_contracts.py"
    spec = importlib.util.spec_from_file_location("planning_generator", generator)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    models = module.models()
    for fixture in json.loads(
        (root / "commerce-assistant-platform/contracts/commerce-planning/v1/fixtures.json").read_text()
    ):
        if fixture["valid"]:
            models[fixture["contract"]].model_validate_json(
                json.dumps(fixture["value"])
            )
        else:
            with pytest.raises(ValidationError):
                models[fixture["contract"]].model_validate_json(
                    json.dumps(fixture["value"])
                )
    subprocess.run(
        [sys.executable, str(generator), "--check"], check=True, capture_output=True
    )


@pytest.mark.parametrize(
    "prices,code",
    [
        (None, "pricing_unavailable"),
        ((0, 0), "pricing_unavailable"),
        ((1000000, 1000000), "spend_budget"),
    ],
)
def test_missing_or_excessive_price_fails_before_paid_call(prices, code):
    async def run():
        from app.commerce_action_engine.actions.shopping import ShoppingIntent

        s = PlanningSession("discovery", WHO, PORTS, prices=prices)
        s.start("catalog.get_catalog_schema", SchemaArgs())
        s.finish(CatalogResult(products=[], category=None))

        class Provider:
            async def generate(self, request):
                raise AssertionError("must not spend")

        request = ModelRequest(
            messages=(Message("user", "coffee"),),
            instructions="",
            max_tokens=100,
            output_schema=ShoppingIntent,
        )
        with pytest.raises(RuntimeErrorCode, match=code):
            await s.reason("reasoning.shopping", "coffee", Provider(), request)

    asyncio.run(run())


def test_expired_session_cannot_start_operation():
    s = session()
    s.started -= 1000
    with pytest.raises(RuntimeErrorCode, match="deadline"):
        s.start("catalog.get_catalog_schema", SchemaArgs())


def test_composition_cannot_reset_already_consumed_limits():
    s = session("shop")
    s.attempts["search"] = 1
    with pytest.raises(RuntimeErrorCode, match="invalid_composition"):
        s.compose_basket(1)


def test_new_procedure_executes_existing_typed_transport(monkeypatch):
    import httpx
    from test_shopping import product

    from app.commerce_action_engine.actions.catalog import ProductArgs
    from app.commerce_action_engine.application.catalog import registry

    async def run():
        price = next(s for s in document().skills if s.id == "skill://pricing/quote")
        procedure = Procedure(
            id="playbook://commerce/price-review",
            version="1.0.0",
            intents=("price_review",),
            nodes=(
                PlannedNode(
                    id="quote", skill=DefinitionRef(id=price.id, version=price.version)
                ),
            ),
            policies=document().procedures[0].policies,
            verification=("current_price",),
        )
        extended = PlanningLibrary(
            document().skills, (*document().procedures, procedure), library().schemas
        )
        monkeypatch.setattr(
            "app.commerce_action_engine.execution.planning.runtime.library",
            lambda: extended,
        )
        called = []

        def handler(request):
            assert request.url.path == "/v1/assistant-tools/shopper"
            assert request.headers["Authorization"] == "Bearer scoped-catalog-token"
            body = json.loads(request.content)
            called.append(body["name"])
            return httpx.Response(200, json={"products": [product()], "category": None})

        async with httpx.AsyncClient(
            base_url="http://assistant-tools:8081",
            transport=httpx.MockTransport(handler),
        ) as client:
            tools = {
                t.definition.name: t
                for t in registry(client, "scoped-catalog-token", WHO, {})
            }
            s = PlanningSession(
                "price-review", WHO, frozenset({"catalog.get_product_price"})
            )
            args = ProductArgs(product_id=product()["id"])
            result = await s.perform(
                "catalog.get_product_price",
                args,
                lambda: tools["get_product_price"].handler(args, WHO),
                lambda r: r,
            )
            assert result.products[0].price == "99"
        assert called == ["get_product_price"] and s.completed == {"quote": 1}

    asyncio.run(run())


def test_model_price_pin_prevents_silent_model_change():
    from app.commerce_action_engine.execution.planning.library import pinned_prices

    assert pinned_prices("approved", "approved", 400, 1600) == (400, 1600)
    assert pinned_prices("different", "approved", 400, 1600) is None
    assert pinned_prices("approved", "approved", 0, 1600) is None


def test_readiness_revision_includes_operator_price_configuration():
    from dataclasses import replace

    from app.commerce_action_engine.actions.policy import PolicyAnswers
    from app.commerce_action_engine.application.baseline import Baseline
    from app.commerce_action_engine.platform.settings import Settings

    settings = Settings(tenant_id=UID)
    first = Baseline(settings, PolicyAnswers())
    second = Baseline(replace(settings, model_input_micros_per_1k=400), PolicyAnswers())
    assert first.revision() != second.revision()


@pytest.mark.parametrize("count", [1, 3, 5])
def test_category_discovery_reserves_bounded_searches(count):
    plan = session("discovery")
    plan.compose_category_search(count)
    assert plan.plan.playbook.id == "playbook://commerce/category-discovery"
    assert (
        next(node for node in plan.plan.nodes if node.id == "search").max_calls == count
    )
    assert plan.plan.reserved.tools == count + 1  # schema plus searches


@pytest.mark.parametrize("count", [0, 6])
def test_category_discovery_rejects_unbounded_searches(count):
    with pytest.raises(RuntimeErrorCode):
        session("discovery").compose_category_search(count)


def test_category_discovery_cannot_expand_after_product_retrieval():
    plan = session("discovery")
    plan.attempts["search"] = 1
    with pytest.raises(RuntimeErrorCode):
        plan.compose_category_search(3)
