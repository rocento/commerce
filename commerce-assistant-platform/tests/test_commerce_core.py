"""Core fitness, compatibility, isolation and side-effect-preserving extraction."""

import ast
import asyncio
import importlib
import json
import os
import subprocess
import sys
from dataclasses import replace
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from test_assistant import identity as identity  # noqa: PLC0414 -- fixture
from test_baskets import BasketGoal, BasketPlan, scenario
from test_catalog_schema import catalog_schema
from test_shopping import product

from app.commerce_action_engine.actions.shopping import ShoppingIntent
from app.commerce_action_engine.adapters.core import (
    CommerceCatalogAdapter,
    StoreTraceAdapter,
    SystemClock,
    SystemIds,
)
from app.commerce_action_engine.adapters.reasoning import reasoning_adapter
from app.commerce_action_engine.application.catalog import registry as tool_registry
from app.commerce_action_engine.contracts import action as c
from app.commerce_action_engine.contracts import ports
from app.commerce_action_engine.execution.agents import Principal
from app.commerce_action_engine.execution.core.facade import CompatibilityFacade
from app.commerce_action_engine.execution.core.library import (
    CORE_CONTRACTS,
    build_registry,
    journey_ref,
    provider_capabilities,
)
from app.commerce_action_engine.execution.core.registry import (
    Registry,
    RegistryError,
    reference,
    select_model,
)
from app.commerce_action_engine.execution.core.state import (
    read_goal,
    transition_execution,
    transition_goal,
)
from app.commerce_resolution_engine.contracts import (
    ModelError,
    ModelRequest,
    ModelResponse,
    Usage,
)
from app.main import create_app
from evals.lab.models import EvaluationScope, load_dataset
from evals.lab.runner import run

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = json.loads(
    (
        ROOT / "commerce-api/rocento-api/crates/commerce-core-contracts/contract/v1/fixtures.json"
    ).read_text()
)
UID = str(UUID(int=1))


def context(**changes):
    return c.ActorContext(
        tenant_id=UID,
        store_id=UID,
        session_id=UID,
        request_id=UID,
        channel="storefront",
        **changes,
    )


def skill(**changes):
    return c.SkillDefinition(
        id="skill://catalog/search",
        version="1.0.0",
        input_contract="legacy://assistant/request-v1",
        output_contract="legacy://assistant/result-v1",
        **changes,
    )


@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda f: f["id"])
def test_shared_wire_fixture(fixture):
    model = getattr(c, fixture["contract"], None) or getattr(ports, fixture["contract"])
    if fixture["valid"]:
        model.model_validate_json(json.dumps(fixture["value"]))
    else:
        with pytest.raises(ValidationError):
            model.model_validate_json(json.dumps(fixture["value"]))


def test_schema_generation_is_current():
    subprocess.run(
        [sys.executable, str(ROOT / "commerce-ops/scripts/generate_core_contracts.py"), "--check"],
        check=True,
        capture_output=True,
    )


def test_dependency_direction_and_no_infrastructure_calls():
    allowed = {
        "collections",
        "contextlib",
        "dataclasses",
        "decimal",
        "re",
        "enum",
        "json",
        "typing",
        "types",
        "pydantic",
    }
    core = ROOT / "commerce-assistant-platform/app/commerce_action_engine/execution/core"
    for path in core.glob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                names = (
                    [node.module or ""]
                    if isinstance(node, ast.ImportFrom)
                    else [alias.name for alias in node.names]
                )
                for name in names:
                    assert (
                        name.startswith(
                            (
                                "app.commerce_action_engine.execution.core.",
                                "app.commerce_action_engine.contracts.",
                            )
                        )
                        or name.split(".")[0] in allowed
                    ), (path, name)
            if isinstance(node, ast.Call):
                name = (
                    node.func.id
                    if isinstance(node.func, ast.Name)
                    else node.func.attr
                    if isinstance(node.func, ast.Attribute)
                    else ""
                )
                if (
                    name == "compile"
                    and isinstance(node.func, ast.Attribute)
                    and isinstance(node.func.value, ast.Name)
                    and node.func.value.id == "re"
                ):
                    continue  # Regex compilation is pure; Python code compilation stays forbidden.
                assert name not in {
                    "__import__",
                    "import_module",
                    "open",
                    "exec",
                    "eval",
                    "compile",
                    "connect",
                    "execute",
                    "generate",
                    "stream",
                }, (path, name)
    assert c.PlaybookDefinition.model_config["frozen"]
    assert c.PlaybookDefinition.model_config["extra"] == "forbid"


def test_core_journey_changes_invalidate_store_acceptance(identity):
    from app.commerce_action_engine.actions.policy import PolicyAnswers
    from app.commerce_action_engine.application.baseline import Baseline

    config, _, _ = identity
    original = Baseline(config, PolicyAnswers()).revision()
    changed = Baseline(
        replace(config, core_journeys=frozenset({"shop"})), PolicyAnswers()
    ).revision()
    assert changed != original


@pytest.mark.parametrize(
    "fault",
    [
        "duplicate",
        "missing",
        "wrong_version",
        "cycle",
        "contract",
        "wrong_kind",
        "step_not_skill",
        "duplicate_dependency",
    ],
)
def test_registry_rejects_invalid_startup(fault):
    item = skill()
    definitions = [item]
    if fault == "duplicate":
        definitions += [item]
    if fault in {"missing", "wrong_version", "cycle", "duplicate_dependency"}:
        dependency = c.DefinitionRef(
            id=item.id if fault != "missing" else "skill://missing",
            version="2.0.0" if fault == "wrong_version" else "1.0.0",
        )
        definitions = [
            skill(
                dependencies=(dependency, dependency)
                if fault == "duplicate_dependency"
                else (dependency,)
            )
        ]
    if fault == "contract":
        definitions = [item.model_copy(update={"input_contract": "unknown://input"})]
    if fault == "wrong_kind":
        definitions = [item.model_copy(update={"id": "policy://wrong"})]
    if fault == "step_not_skill":
        policy = c.PolicyDefinition(
            id="policy://authority", version="1.0.0", reason_codes=("allow",)
        )
        definitions = [
            policy,
            c.PlaybookDefinition(
                id="playbook://test",
                version="1.0.0",
                journey="shop",
                steps=(reference(policy),),
            ),
        ]
    with pytest.raises(RegistryError):
        Registry(definitions, contracts=CORE_CONTRACTS)


def test_registry_pins_aliases_filters_dependencies_and_rejects_expired_versions():
    item = skill(
        visibility=c.Visibility(
            tenants=(UID,), channels=("storefront",), required_scopes=("catalog.read",)
        ),
        deprecated_after=100,
        disabled_after=200,
    )
    book = c.PlaybookDefinition(
        id="playbook://test", version="1.0.0", journey="shop", steps=(reference(item),)
    )
    registry = Registry(
        [item, book], contracts=CORE_CONTRACTS, aliases={"search": reference(item)}
    )
    who = context(scopes=("catalog.read",))
    assert registry.resolve(reference(book), who, now=150) == (item, book)
    assert registry.alias("search", pinned=reference(item)) == reference(item)
    with pytest.raises(RegistryError):
        registry.alias("search", pinned=c.DefinitionRef(id=item.id, version="2.0.0"))
    with pytest.raises(RegistryError):
        registry.resolve(reference(book), context(), now=150)
    with pytest.raises(RegistryError):
        registry.resolve(
            reference(book),
            who.model_copy(update={"tenant_id": str(UUID(int=2))}),
            now=150,
        )
    with pytest.raises(RegistryError):
        registry.resolve(
            reference(book), who.model_copy(update={"channel": "admin"}), now=150
        )
    with pytest.raises(RegistryError):
        registry.resolve(reference(book), who, now=200)
    assert registry.visible(context(), now=150) == ()
    with pytest.raises(ValidationError):
        item.version = "2.0.0"


@pytest.mark.parametrize(
    "risk,confirmation",
    [
        (c.Risk.R1, c.Confirmation.NONE),
        (c.Risk.R2, c.Confirmation.NONE),
        (c.Risk.R3, c.Confirmation.INTENT),
        (c.Risk.R4, c.Confirmation.FRESH),
    ],
)
def test_risk_cannot_be_weakened(risk, confirmation):
    with pytest.raises(ValidationError):
        skill(risk=risk, confirmation=confirmation)


def test_mutation_requires_scopes_freshness_idempotency_and_revision():
    with pytest.raises(ValidationError):
        skill(risk=c.Risk.R2, confirmation=c.Confirmation.INTENT)
    valid = skill(
        risk=c.Risk.R2,
        confirmation=c.Confirmation.INTENT,
        idempotency="required",
        freshness_seconds=300,
        visibility=c.Visibility(required_scopes=("cart.write",)),
    )
    assert valid.risk is c.Risk.R2
    with pytest.raises(ValidationError):
        c.ActionEnvelope(
            context=context(scopes=("cart.write",)),
            risk=c.Risk.R2,
            confirmation=c.Confirmation.INTENT,
            idempotency_key=UID,
            expires_at=300,
        )


def test_goal_transitions_revision_reader_and_isolation():
    state = c.GoalState(id=UID, context=context())
    with pytest.raises(ValueError):
        transition_goal(state, c.GoalStatus.SUCCEEDED, expected_revision=0)
    planned = transition_goal(state, c.GoalStatus.PLANNED, expected_revision=0)
    with pytest.raises(ValueError):
        transition_goal(planned, c.GoalStatus.RUNNING, expected_revision=0)
    running = transition_goal(planned, c.GoalStatus.RUNNING, expected_revision=1)
    done = transition_goal(running, c.GoalStatus.SUCCEEDED, expected_revision=2)
    with pytest.raises(ValueError):
        transition_goal(done, c.GoalStatus.RUNNING, expected_revision=3)
    stored = state.model_dump_json()
    assert read_goal(stored, tenant_id=UID, store_id=UID, session_id=UID) == state
    for field in ("tenant_id", "store_id", "session_id"):
        with pytest.raises(ValueError):
            read_goal(
                stored,
                **{
                    "tenant_id": UID,
                    "store_id": UID,
                    "session_id": UID,
                    field: str(UUID(int=2)),
                },
            )
    with pytest.raises(ValidationError):
        read_goal(
            json.dumps({**state.model_dump(mode="json"), "unexpected": True}),
            tenant_id=UID,
            store_id=UID,
            session_id=UID,
        )
    for version in ("0.9", "2.0"):
        with pytest.raises(ValueError, match="Unsupported persisted schema"):
            read_goal(
                json.dumps(
                    {**state.model_dump(mode="json"), "schema_version": version}
                ),
                tenant_id=UID,
                store_id=UID,
                session_id=UID,
            )
    execution = transition_execution(
        c.ExecutionState(step_id="search"), c.ExecutionStatus.RUNNING
    )
    assert execution.attempts == 1
    execution = transition_execution(execution, c.ExecutionStatus.SUCCEEDED)
    with pytest.raises(ValueError):
        transition_execution(execution, c.ExecutionStatus.RUNNING)


def test_evidence_plan_and_verification_invariants():
    freshness = c.Freshness(observed_at=100, expires_at=200)
    assert (
        freshness.valid_at(100)
        and not freshness.valid_at(99)
        and not freshness.valid_at(200)
    )
    with pytest.raises(ValidationError):
        c.Freshness(observed_at=200, expires_at=100)
    with pytest.raises(ValidationError):
        c.ExecutionPlan(
            goal_id=UID,
            playbook=journey_ref("shop"),
            steps=(c.PlanStep(id="a", skill=reference(skill()), depends_on=("b",)),),
        )
    with pytest.raises(ValidationError):
        c.VerificationReport(
            goal_id=UID,
            status="unknown",
            constraints_satisfied=True,
            policies_satisfied=True,
            evidence_fresh=True,
            action_ready=True,
        )


@pytest.mark.parametrize(
    "enabled,journeys,available,deterministic,path,reason",
    [
        (False, {"shop"}, True, False, "legacy", "flag_off"),
        (True, {"shop"}, True, False, "core", "core_selected"),
        (True, {"discovery"}, True, False, "legacy", "journey_disabled"),
        (True, {"shop"}, False, False, "deterministic", "provider_unavailable"),
        (True, {"shop"}, True, True, "deterministic", "existing_deterministic"),
    ],
)
def test_facade_selection_and_version_trace(
    enabled, journeys, available, deterministic, path, reason
):
    facade = CompatibilityFacade(
        build_registry(), SystemClock(), enabled=enabled, journeys=frozenset(journeys)
    )
    decision = facade.select(
        context(), "shop", provider_available=available, deterministic=deterministic
    )
    assert (decision.path, decision.reason) == (path, reason)
    assert journey_ref("shop") in decision.versions
    assert "prompt" not in decision.model_dump_json()


def test_unavailable_core_falls_back_before_execution():
    decision = CompatibilityFacade(Registry([]), SystemClock(), enabled=True).select(
        context(), "shop"
    )
    assert decision.path == "legacy" and decision.reason == "core_unavailable"


def test_provider_selection_and_fake_swap_has_no_core_vendor_dependency():
    class Fake:
        calls = 0

        async def generate(self, request):
            self.calls += 1
            return ModelResponse("same", (), None, Usage(1, 1, 2), "fake", "stop")

    delegate = Fake()
    adapter = reasoning_adapter(delegate, provider_capabilities())
    assert asyncio.run(adapter.generate(ModelRequest(messages=()))).text == "same"
    assert delegate.calls == 1
    no_structured = provider_capabilities().model_copy(
        update={"structured_output": False}
    )
    with pytest.raises(ModelError):
        asyncio.run(
            reasoning_adapter(delegate, no_structured).generate(
                ModelRequest(messages=(), output_schema=ShoppingIntent)
            )
        )
    assert delegate.calls == 1
    with pytest.raises(RegistryError):
        select_model(
            (provider_capabilities(),),
            c.ModelRequirements(vision=True),
            configured=frozenset({"default"}),
        )
    with pytest.raises(RegistryError):
        select_model(
            (provider_capabilities(),), c.ModelRequirements(), configured=frozenset()
        )
    assert SystemIds().idempotency_key(
        context(), "proposal"
    ) == SystemIds().idempotency_key(context(), "proposal")
    assert SystemIds().idempotency_key(
        context(), "proposal"
    ) != SystemIds().idempotency_key(context(), "apply")


def test_search_adapter_and_fake_substitution_keep_scoping():
    async def check():
        calls = []

        def transport(request):
            calls.append(json.loads(request.content)["name"])
            return httpx.Response(200, json={"products": [product()], "category": None})

        principal = Principal(tenant=UUID(UID), persona="shopper")
        async with httpx.AsyncClient(
            base_url="http://commerce", transport=httpx.MockTransport(transport)
        ) as client:
            tools = {
                t.definition.name: t
                for t in tool_registry(client, "scoped", principal, {})
            }
            adapter = CommerceCatalogAdapter(tools, principal, context())
            result = await adapter.search(context(), ports.SearchQuery(text="shoes"))
            assert (
                not result.exhaustive and result.products[0].name == product()["name"]
            )

            class FakeSearch:
                async def search(self, actor, query):
                    return result

            async def consume(port: ports.ProductSearchPort):
                return await port.search(context(), ports.SearchQuery(text="shoes"))

            assert await consume(FakeSearch()) == result
            with pytest.raises(RegistryError):
                await adapter.search(
                    context().model_copy(update={"tenant_id": str(UUID(int=2))}),
                    ports.SearchQuery(text="shoes"),
                )
            with pytest.raises(RegistryError):
                await adapter.search(
                    context(),
                    ports.SearchQuery(
                        text="shoes", constraints=c.ConstraintSet(conflict="deny")
                    ),
                )
            assert calls == ["search_products"]

    asyncio.run(check())


def test_all_english_cases_match_under_both_facade_paths():
    dataset = load_dataset(ROOT / "commerce-assistant-platform/evals/lab/commerce-v1.json")
    scope = EvaluationScope.model_validate_json(
        (ROOT / "commerce-assistant-platform/evals/lab/m02-english-scope.json").read_bytes()
    )
    old = asyncio.run(run(dataset, scope=scope, grounded_intent=True))
    new = asyncio.run(
        run(dataset, scope=scope, grounded_intent=True, commerce_core=True)
    )
    assert old.status == new.status == "passed"
    assert len(old.results) == len(new.results) == 88
    assert old.excluded_cases == new.excluded_cases
    for before, after in zip(old.results, new.results, strict=True):
        assert before.provider_calls == after.provider_calls
        assert before.tool_calls == after.tool_calls
        for a, b in zip(before.trace, after.trace, strict=True):
            assert {k: v for k, v in a.items() if k != "core"} == {
                k: v for k, v in b.items() if k != "core"
            }
            assert b["core"]["path"] in {"core", "deterministic"}


@pytest.mark.parametrize("enabled", [False, True])
@pytest.mark.parametrize("fail", [False, True])
@pytest.mark.parametrize("preparation_failure", [False, True])
def test_actual_sse_uses_facade_persists_trace_and_never_retries_execution(
    enabled, fail, preparation_failure, identity, monkeypatch, caplog
):
    from app.commerce_action_engine.execution.language import gate as language_gate
    from app.commerce_contracts.language_proposal import LanguageProposal

    config, request_id, headers = identity
    config = replace(
        config,
        store_password_file="fixture-store",
        feature_flags=frozenset({"commerce_core", "grounded_intent", "typed_errors"})
        if enabled
        else frozenset({"grounded_intent", "typed_errors"}),
    )
    calls = []

    class Provider:
        async def generate(self, request):
            calls.append("provider")
            if fail:
                raise ModelError("unavailable")
            return ModelResponse(
                "private provider text",
                (),
                LanguageProposal(
                    status="INTERPRETED",
                    intent="PRODUCT_SEARCH",
                    canonical_text="show shoes",
                ),
                Usage(10, 5, 15),
                "fixture",
                "stop",
            )

        async def aclose(self):
            pass

    module = importlib.import_module("app.commerce_action_engine.application.bootstrap")
    monkeypatch.setattr(module, "build_provider", lambda _: Provider())

    async def resolve(url, message):
        if message == "Find shoes":
            return language_gate.Resolution(status="UNKNOWN", message="", confidence=0)
        assert message == "show shoes"
        return language_gate.Resolution(
            status="RESOLVED",
            intent="PRODUCT_SEARCH",
            message="",
            confidence=1,
            entities={"productText": "shoes"},
        )

    monkeypatch.setattr(language_gate, "resolve", resolve)

    class RecordingStore:
        def __init__(self):
            self.metrics = []

        async def admit_customer_request(self, tenant, customer, request):
            assert tenant is not None and customer is not None and request is not None

        async def open(self):
            pass

        async def close(self):
            pass

        async def purge(self, *_):
            pass

        async def model_budget_available(self, *_):
            return True

        async def metric(self, *args):
            self.metrics.append(args)

    recorded = RecordingStore()
    monkeypatch.setattr(module, "Store", lambda _: recorded)
    if preparation_failure:

        def unavailable(*_):
            raise RegistryError("definition_expired")

        monkeypatch.setattr(module, "bind_runtime", unavailable)
    traces = []
    monkeypatch.setattr(
        importlib.import_module(
            "app.commerce_action_engine.application.handle_turn"
        ).TurnTrace,
        "emit",
        lambda self, request, outcome: traces.append((self.core, outcome)),
    )

    def commerce(request):
        name = json.loads(request.content)["name"]
        calls.append(name)
        return httpx.Response(
            200,
            json={
                "products": [] if name == "get_catalog_schema" else [product()],
                "category": None,
                "catalog_schema": catalog_schema()
                if name == "get_catalog_schema"
                else None,
            },
        )

    with TestClient(
        create_app(config, transport=httpx.MockTransport(commerce))
    ) as client:
        response = client.post(
            "/v1/chat",
            json={"request_id": str(request_id), "message": "Find shoes"},
            headers={**headers(), "x-commerce-catalog-token": "catalog-only"},
        )
    assert response.status_code == 200
    assert calls.count("provider") == 1
    assert ("event: error" in response.text) == fail
    assert "private provider text" not in response.text
    assert traces[0][0]["path"] == (
        "deterministic"
        if not fail
        else "core"
        if enabled and not preparation_failure
        else "legacy"
    )
    if enabled and preparation_failure and fail:
        assert traces[0][0]["reason"] == "core_unavailable"
    assert traces[0][0]["versions"]
    assert "catalog-only" not in json.dumps(traces)
    assert len(recorded.metrics) == 1
    assert recorded.metrics[0][4]["core"] == traces[0][0]
    assert recorded.metrics[0][2] == ("unavailable" if fail else "completed")
    if not fail:
        assert recorded.metrics[0][4]["language_fallback"]["outcome"] == "search"
        assert recorded.metrics[0][4]["model_calls"] == 1
        assert recorded.metrics[0][4]["input_tokens"] == 10


@pytest.mark.parametrize("mode", ["shop", "optimize", "buy_again"])
def test_existing_basket_modes_are_identical_through_provider_adapter(mode):
    from test_baskets import Provider

    plan = BasketPlan(goal=BasketGoal(purpose="Basket"))
    plain = asyncio.run(scenario(plan, mode=mode))
    provider = Provider(plan)
    wrapped = asyncio.run(
        scenario(
            plan,
            mode=mode,
            provider_override=reasoning_adapter(provider, provider_capabilities()),
        )
    )
    assert plain[:3] == wrapped[:3]
    assert len(plain[3].requests) == len(provider.requests)


@pytest.mark.parametrize("mode", ["shop", "optimize"])
@pytest.mark.parametrize("count", [90, 110])
def test_large_valid_baskets_do_not_gain_a_byte_based_token_limit(mode, count):
    from test_baskets import Provider

    plan = BasketPlan(goal=BasketGoal(purpose="Basket"))
    items = [
        {
            "product_id": str(UUID(int=1000 + i)),
            "name": "Roasted coffee " + "x" * 66,
            "unit": "kg",
            "quantity": 1,
            "price": "6.00",
            "currency": "USD",
        }
        for i in range(count)
    ]
    plain = asyncio.run(scenario(plan, mode=mode, cart_items=items))
    provider = Provider(plan)
    wrapped = asyncio.run(
        scenario(
            plan,
            mode=mode,
            cart_items=items,
            provider_override=reasoning_adapter(provider, provider_capabilities()),
        )
    )
    assert plain[:3] == wrapped[:3]
    assert len(provider.requests) == len(plain[3].requests) == 1
    assert sum(len(message.text) for message in provider.requests[0].messages) > 20000


def test_persistence_adapter_preserves_existing_metadata_and_rejects_cross_tenant():
    class Store:
        def __init__(self):
            self.calls = []

        async def metric(self, *args):
            self.calls.append(args)

    store = Store()
    trace = CompatibilityFacade(build_registry(), SystemClock(), enabled=True).select(
        context(), "discovery"
    )
    adapter = StoreTraceAdapter(
        store,
        context(),
        outcome="unavailable",
        latency_ms=42,
        metadata={"model_calls": 1},
    )
    asyncio.run(adapter.record(trace))
    args = store.calls[0]
    assert args[0:4] == (UUID(UID), UUID(UID), "unavailable", 42)
    assert args[4]["core"]["path"] == "core" and args[4]["model_calls"] == 1
    with pytest.raises(RegistryError):
        asyncio.run(
            adapter.record(trace.model_copy(update={"tenant_id": str(UUID(int=2))}))
        )
    assert len(store.calls) == 1


@pytest.mark.skipif(
    not os.getenv("M09_TEST_DATABASE_URL"),
    reason="M03 isolated database not configured",
)
def test_trace_metadata_survives_real_postgres_restart_and_legacy_rows():
    import psycopg
    from psycopg.conninfo import conninfo_to_dict, make_conninfo
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    from app.commerce_action_engine.platform.store import Store

    async def check():
        dsn = os.environ["M09_TEST_DATABASE_URL"]
        database = "m03_" + uuid4().hex
        async with await psycopg.AsyncConnection.connect(dsn, autocommit=True) as admin:
            await admin.execute(
                psycopg.sql.SQL("CREATE DATABASE {}").format(
                    psycopg.sql.Identifier(database)
                )
            )
            await admin.execute(
                "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_runtime') THEN CREATE ROLE ai_runtime LOGIN PASSWORD 'runtime-test-only'; END IF; END $$"
            )
        settings = {**conninfo_to_dict(dsn), "dbname": database}
        store = object.__new__(Store)
        try:
            async with await psycopg.AsyncConnection.connect(
                make_conninfo(**settings), autocommit=True
            ) as admin:
                migrations = ROOT / "commerce-assistant-platform/migrations"
                for name in (
                    "001_ai_store.sql",
                    "002_deployment_boundary.sql",
                    "004_conversations.sql",
                ):
                    await admin.execute(
                        (migrations / name)
                        .read_text()
                        .replace(":'tenant_id'::uuid", f"'{UID}'::uuid")
                    )
            store.pool = AsyncConnectionPool(
                make_conninfo(
                    **{
                        **settings,
                        "user": "ai_runtime",
                        "password": "runtime-test-only",
                    }
                ),
                open=False,
                min_size=0,
                max_size=2,
                kwargs={"row_factory": dict_row},
            )
            await store.open()
            who = context(principal_id=str(UUID(int=3)), actor_id=str(UUID(int=3)))
            trace = CompatibilityFacade(
                build_registry(), SystemClock(), enabled=True
            ).select(who, "shop")
            await StoreTraceAdapter(
                store,
                who,
                outcome="completed",
                latency_ms=4,
                metadata={"model_calls": 1},
            ).record(trace)
            await store.metric(UUID(UID), UUID(int=2), "completed", 3, {"legacy": True})
            await store.close()
            # New process/connection reads the same JSON with no DDL migration.
            async with await psycopg.AsyncConnection.connect(
                make_conninfo(**settings), autocommit=True
            ) as admin:
                cursor = await admin.execute(
                    "SELECT metadata FROM assistant.metrics ORDER BY request_id"
                )
                rows = await cursor.fetchall()
                assert rows[0][0]["core"] == trace.model_dump(mode="json")
                assert rows[1][0] == {"legacy": True}
        finally:
            if hasattr(store, "pool"):
                await store.close()
            async with await psycopg.AsyncConnection.connect(
                dsn, autocommit=True
            ) as admin:
                await admin.execute(
                    psycopg.sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                        psycopg.sql.Identifier(database)
                    )
                )

    asyncio.run(check())
