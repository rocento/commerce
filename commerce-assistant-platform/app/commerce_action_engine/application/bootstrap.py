import asyncio
import logging
from collections.abc import AsyncIterator, Mapping
from contextlib import AsyncExitStack, asynccontextmanager
from contextvars import Token
from dataclasses import replace
from functools import partial
from typing import Any
from uuid import UUID

import httpx
from fastapi import FastAPI, HTTPException

from app.commerce_action_engine.actions.catalog import (
    CatalogCache,
    CatalogResult,
)
from app.commerce_action_engine.actions.policy import PolicyAnswers
from app.commerce_action_engine.actions.policy import load as load_policy_answers
from app.commerce_action_engine.adapters.commerce import CommerceTools
from app.commerce_action_engine.adapters.core import (
    StoreTraceAdapter,
    SystemClock,
    bind_runtime,
)
from app.commerce_action_engine.adapters.intent_examples import LanguageExampleValidator
from app.commerce_action_engine.adapters.memory import MemoryTransport
from app.commerce_action_engine.adapters.read_budget import CommerceReadBudget
from app.commerce_action_engine.adapters.runtime_knowledge import RuntimeKnowledge
from app.commerce_action_engine.application.api.chat import register_chat
from app.commerce_action_engine.application.api.history import register_history
from app.commerce_action_engine.application.api.system import register_system
from app.commerce_action_engine.application.api.tracking import register_tracking
from app.commerce_action_engine.application.baseline import Baseline, tool_revision
from app.commerce_action_engine.application.catalog import registry
from app.commerce_action_engine.application.context import TurnContext
from app.commerce_action_engine.application.handle_turn import HandleTurn
from app.commerce_action_engine.application.persistence_binding import bind_persistence
from app.commerce_action_engine.application.resources import TurnLease
from app.commerce_action_engine.application.shopping import shopping_answer
from app.commerce_action_engine.application.turn_dependencies import PreparedTurn
from app.commerce_action_engine.contracts import (
    AssistantChatInput,
)
from app.commerce_action_engine.contracts.action import ActorContext, DecisionTrace
from app.commerce_action_engine.execution.agents import Principal, default_agents
from app.commerce_action_engine.execution.core import (
    CompatibilityFacade,
    build_registry,
)
from app.commerce_action_engine.execution.language import saved_addresses_requested
from app.commerce_action_engine.execution.language.readiness import LanguageReadiness
from app.commerce_action_engine.platform import (
    Settings,
    SingleFlight,
    Store,
    mark_provider_token,
    phase,
    planning_summary,
)
from app.commerce_action_engine.platform.domain_evidence import PostgresDomainEvidence
from app.commerce_action_engine.platform.security import Context
from app.commerce_knowledge_rag import PostgresKnowledgeIndex, Retriever
from app.commerce_knowledge_rag.intent_examples import IntentExampleRetriever
from app.commerce_resolution_engine.admission import (
    ReasoningGateway,
)
from app.commerce_resolution_engine.contracts import ModelError, ModelProvider
from app.commerce_resolution_engine.providers import (
    CallBudget,
    OpenAIProvider,
    ProviderConfig,
    ProviderSettings,
    StoredSettings,
    UnconfiguredModel,
    UsageProvider,
    build_embedder,
    build_provider,
)
from app.commerce_resolution_engine.providers.embeddings import OpenAIEmbeddings
from app.commerce_resolution_engine.runtime import AgentRuntime


def create_app(
    settings: Settings | None = None,
    model: ModelProvider | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    config = settings or Settings.environment()
    policy_answers: PolicyAnswers = load_policy_answers(
        config.exact_policy_file, config.tenant_id
    )
    catalog_singleflight: SingleFlight[CatalogResult] = SingleFlight()
    catalog_cache = CatalogCache()
    provider: ModelProvider = model or UnconfiguredModel()
    runtime: AgentRuntime | None = None
    provider_config = ProviderConfig.from_settings(config)
    managed = ProviderSettings(provider_config)
    baseline = Baseline(config, policy_answers)
    core_facade = CompatibilityFacade(
        build_registry(),
        SystemClock(),
        enabled="commerce_core" in config.feature_flags,
        journeys=config.core_journeys,
    )
    tool_revision()  # Fail startup on non-strict model tool schemas.
    language_readiness = LanguageReadiness(
        config.language_engine_url, config.language_generation_fingerprint
    )
    settings_lock = asyncio.Lock()
    semaphore = asyncio.Semaphore(config.concurrency)
    store = None
    if config.store_password_file:
        if (config.store_host, config.store_user) == ("ai-postgres", "ai_runtime"):
            store = Store(config.store_password_file)
        else:
            store = Store(
                config.store_password_file,
                host=config.store_host,
                user=config.store_user,
            )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if "domain_evidence" in config.feature_flags and store is None:
            raise RuntimeError("domain_evidence requires the assistant database")
        async with AsyncExitStack() as cleanup:
            nonlocal provider, runtime
            owned_provider = None
            if model is None and config.enabled and managed.path is None:
                try:
                    owned_provider = build_provider(provider_config)
                    if owned_provider is None:
                        logging.getLogger("assistant").warning(
                            "assistant_model_configuration_unavailable: AI_MODEL_PROVIDER is disabled; "
                            "model fallback requires AI_MODEL_PROVIDER, AI_MODEL_NAME and AI_MODEL_KEY_FILE"
                        )
                    if owned_provider:
                        cleanup.push_async_callback(owned_provider.aclose)
                        runtime = AgentRuntime(
                            default_agents(
                                UUID(config.tenant_id),
                                frozenset(config.knowledge_collections),
                            ),
                            {"default": owned_provider},
                            trace_phase=phase,
                        )
                        if store and config.embedding_model:
                            embedder = build_embedder(provider_config)
                            if embedder:
                                cleanup.push_async_callback(embedder.aclose)
                                runtime.retriever = RuntimeKnowledge(
                                    Retriever(
                                        embedder, PostgresKnowledgeIndex(store.pool)
                                    ),
                                    record_planning=planning_summary,
                                )
                        app.state.agent_runtime = runtime
                except ModelError:
                    logging.getLogger("assistant").warning(
                        "assistant_model_configuration_unavailable"
                    )
                    provider = UnconfiguredModel()
            async with httpx.AsyncClient(
                base_url=config.commerce_url,
                timeout=httpx.Timeout(5, connect=1),
                limits=httpx.Limits(max_connections=config.concurrency),
                follow_redirects=False,
                trust_env=False,
                transport=transport,
            ) as client:
                app.state.commerce = client
                app.state.language_health_client = await cleanup.enter_async_context(
                    httpx.AsyncClient(
                        timeout=1.5, follow_redirects=False, trust_env=False
                    )
                )
                if store:
                    await store.open()

                async def maintenance() -> None:
                    while True:
                        if store:
                            try:
                                await store.purge(UUID(config.tenant_id))
                            except Exception:  # noqa: BLE001 -- isolated maintenance boundary
                                logging.getLogger("assistant").warning(
                                    "assistant_retention_unavailable"
                                )
                        await asyncio.sleep(3600)

                task = asyncio.create_task(maintenance()) if store else None
                try:
                    yield
                finally:
                    if task:
                        task.cancel()
                        try:
                            await task
                        except asyncio.CancelledError:
                            pass
                    if store:
                        await store.close()

    app = FastAPI(
        title="Commerce AI",
        version="0.2.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
    )

    register_system(
        app,
        config,
        managed,
        settings_lock,
        baseline,
        store,
        lambda: runtime is not None,
        lambda: language_readiness.check(app.state.language_health_client),
    )
    register_history(app, config, store)
    register_tracking(app, config, store)

    async def prepare_turn(
        body: AssistantChatInput,
        context: Context,
        headers: Mapping[str, str],
        saved: StoredSettings | None,
        lease: TurnLease,
    ) -> HandleTurn:
        turn_resources = lease.resources
        from app.commerce_action_engine.execution.core.intents import default_registry
        from app.commerce_action_engine.execution.language.shopping import english_query

        meaning_enabled = "commerce_meaning" in config.feature_flags and english_query(
            body.message
        )
        intent_frame = (
            default_registry().resolve(body.message) if meaning_enabled else None
        )
        address_request = not body.ticket and saved_addresses_requested(body.message)
        active_runtime = None if address_request else runtime
        active_config = config
        try:
            if saved is not None and not address_request:
                effective = managed.effective(saved)
                active_config = replace(
                    config,
                    model_provider=effective.model_provider,
                    model_name=effective.model_name,
                )
                active_runtime = None
                fresh = managed.provider(saved)
                if fresh is not None:
                    turn_resources.push_async_callback(fresh.aclose)
                    active_runtime = AgentRuntime(
                        default_agents(
                            UUID(config.tenant_id),
                            frozenset(config.knowledge_collections),
                        ),
                        {"default": fresh},
                        trace_phase=phase,
                    )
                    if store and config.embedding_model:
                        turn_embedder = OpenAIEmbeddings(
                            model=config.embedding_model,
                            api_key=managed.key(saved),
                            timeout=config.model_timeout,
                            url=config.model_url,
                        )
                        turn_resources.push_async_callback(turn_embedder.aclose)
                        active_runtime.retriever = RuntimeKnowledge(
                            Retriever(
                                turn_embedder, PostgresKnowledgeIndex(store.pool)
                            ),
                            record_planning=planning_summary,
                        )
        except ModelError:
            raise HTTPException(503, "Provider configuration unavailable") from None

        caller = Principal(
            tenant=context.tenant, persona="shopper", subject=context.sub
        )
        actor_context = ActorContext(
            tenant_id=str(context.tenant),
            store_id=str(context.tenant),
            actor_id=str(context.sub) if context.sub else None,
            principal_id=str(context.sub) if context.sub else None,
            session_id=str(context.sid or body.conversation_id or body.request_id),
            request_id=str(body.request_id),
            channel="storefront",
            scopes=(context.scope,),
        )
        catalog_token = headers.get("x-commerce-catalog-token", "")
        cart_token = headers.get("x-commerce-cart-token", "")
        wishlist_token = headers.get("x-commerce-wishlist-token", "")
        locations_token = headers.get("x-commerce-locations-token", "")
        support_token = headers.get("x-commerce-support-token", "")
        delivery_headers = {
            key: headers[key]
            for key in ("x-delivery-latitude", "x-delivery-longitude")
            if key in headers
        }

        read_budget = CommerceReadBudget()

        def commerce_tools() -> CommerceTools:
            base = CommerceTools(
                app.state.commerce,
                headers.get("x-commerce-tool-token", ""),
                cart_token,
                catalog_token,
                delivery_headers,
                wishlist_token,
                locations_token,
                support_token,
                headers.get("x-commerce-cart-write-token", ""),
                headers.get("x-commerce-wishlist-write-token", ""),
                headers.get("x-commerce-wishlist-cart-transfer-token", ""),
                headers.get("x-commerce-compound-read-token", ""),
                headers.get("x-commerce-compound-write-token", ""),
                read_budget=read_budget,
            )
            if "commerce_planning" in config.feature_flags and english_query(
                body.message
            ):
                from app.commerce_action_engine.adapters.planned_commerce import (
                    PlannedCommerceTools,
                )

                return PlannedCommerceTools(
                    base, caller, record_planning=planning_summary
                )
            return base

        tracked = (
            {
                key: ReasoningGateway(
                    UsageProvider(
                        value,
                        config.model_max_calls_per_turn,
                        trace_phase=phase,
                        on_token=mark_provider_token,
                    ),
                    body.request_id,
                )
                for key, value in active_runtime.providers.items()
            }
            if active_runtime
            else {}
        )
        if active_runtime and catalog_token and "small_model" in config.feature_flags:
            try:
                extraction = OpenAIProvider(
                    model=config.small_model_name,
                    api_key=managed.key(saved),
                    timeout=config.model_timeout,
                    url=config.model_url,
                )
                turn_resources.push_async_callback(extraction.aclose)
                # One structured extraction plus, only for non-shopping questions,
                # one general response. No automatic paid retry/escalation.
                budget = CallBudget(min(2, config.model_max_calls_per_turn))
                for tracked_provider in tracked.values():
                    tracked_provider.budget = budget
                    tracked_provider.max_calls = 1
                tracked["extraction"] = ReasoningGateway(
                    UsageProvider(
                        extraction,
                        1,
                        budget,
                        trace_phase=phase,
                        on_token=mark_provider_token,
                    ),
                    body.request_id,
                )
            except ModelError:
                raise HTTPException(
                    503, "Small model configuration unavailable"
                ) from None
        plan_prices = None
        if "commerce_planning" in config.feature_flags and tracked:
            from app.commerce_action_engine.execution.planning import pinned_prices

            small = "extraction" in tracked
            priced_provider = tracked.get("extraction") or tracked["default"]
            plan_prices = pinned_prices(
                priced_provider.configured_model,
                config.small_model_name if small else config.model_name,
                config.small_model_input_micros_per_1k
                if small
                else config.model_input_micros_per_1k,
                config.small_model_output_micros_per_1k
                if small
                else config.model_output_micros_per_1k,
            )
        turn_runtime = active_runtime
        # Verified catalog reads do not require a configured generation provider.
        # Keep this runtime request-scoped so readiness/UNKNOWN admission still
        # see the absence of a provider, and never synthesize delegated access.
        deterministic_catalog = (
            active_runtime is None
            and isinstance(provider, UnconfiguredModel)
            and not address_request
        )
        if catalog_token and (active_runtime or deterministic_catalog):
            turn_runtime = AgentRuntime(
                active_runtime.catalog
                if active_runtime
                else default_agents(
                    UUID(config.tenant_id), frozenset(config.knowledge_collections)
                ),
                tracked
                or {
                    "default": ReasoningGateway(
                        UsageProvider(UnconfiguredModel()), body.request_id
                    )
                },
                trace_phase=phase,
                retriever=active_runtime.retriever if active_runtime else None,
                shopping=True,
                shopping_handler=(
                    partial(
                        shopping_answer,
                        domain_evidence=PostgresDomainEvidence(store.pool),
                    )
                    if "domain_evidence" in config.feature_flags and store is not None
                    else shopping_answer
                ),
                grounded_intent="grounded_intent" in config.feature_flags,
                commerce_meaning="commerce_meaning" in config.feature_flags,
                commerce_planning="commerce_planning" in config.feature_flags,
                planning_prices=plan_prices,
                tools=registry(
                    app.state.commerce,
                    catalog_token,
                    caller,
                    delivery_headers,
                    catalog_singleflight
                    if "catalog_singleflight" in config.feature_flags
                    else None,
                    catalog_cache if "catalog_cache" in config.feature_flags else None,
                ),
            )

        if active_runtime and not catalog_token:
            turn_runtime = AgentRuntime(
                active_runtime.catalog,
                tracked,
                trace_phase=phase,
                retriever=active_runtime.retriever,
                tools=tuple(active_runtime.tools.values()),
            )

        async def begin_memory() -> Token[Any]:
            from app.commerce_action_engine.actions.shopping import personalization

            memory_token = headers.get("x-commerce-memory-token", "")
            return await personalization.begin(
                MemoryTransport(app.state.commerce, memory_token)
                if memory_token
                else None,
                body.conversation_id,
                body.message,
                headers.get("x-commerce-personalize") == "0",
            )

        async def record_trace(
            decision: DecisionTrace,
            outcome: str,
            latency_ms: int,
            metadata: dict[str, object],
        ) -> None:
            if store:
                await StoreTraceAdapter(
                    store,
                    actor_context,
                    outcome=outcome,
                    latency_ms=latency_ms,
                    metadata=metadata,
                    conversation_id=body.conversation_id,
                ).record(decision)

        retrieve_intent_examples = None
        if (
            config.intent_example_collection
            and active_runtime
            and isinstance(active_runtime.retriever, RuntimeKnowledge)
        ):
            example_agent = active_runtime.catalog.load(caller.tenant, "shopper")
            if example_agent is not None:
                retrieve_intent_examples = IntentExampleRetriever(
                    active_runtime.retriever.reader,
                    example_agent,
                    caller,
                    config.intent_example_collection,
                    LanguageExampleValidator(config.language_engine_url, actor_context),
                ).retrieve

        # An explicitly budgeted embedding-only path does not require a generation
        # provider. Managed customer settings are never bypassed with a base key.
        if (
            retrieve_intent_examples is None
            and "semantic_read_recovery" in config.feature_flags
            and config.semantic_recovery_embedding_budget == 1
            and config.intent_example_collection
            and config.embedding_model
            and store
            and saved is None
            and not address_request
        ):
            try:
                recovery_embedder = build_embedder(provider_config)
            except ModelError:
                recovery_embedder = None
            if recovery_embedder is not None:
                turn_resources.push_async_callback(recovery_embedder.aclose)
                example_agent = default_agents(
                    caller.tenant, frozenset(config.knowledge_collections)
                ).load(caller.tenant, "shopper")
                if example_agent is not None:
                    retrieve_intent_examples = IntentExampleRetriever(
                        Retriever(
                            recovery_embedder, PostgresKnowledgeIndex(store.pool)
                        ),
                        example_agent,
                        caller,
                        config.intent_example_collection,
                        LanguageExampleValidator(
                            config.language_engine_url, actor_context
                        ),
                    ).retrieve

        prepared = PreparedTurn(
            gateway_trace=headers.get("x-commerce-trace-gateway"),
            context=TurnContext(
                actor=actor_context,
                conversation_id=str(body.conversation_id)
                if body.conversation_id
                else None,
            ),
            config=config,
            active_config=active_config,
            caller=caller,
            runtime=turn_runtime,
            has_catalog=bool(turn_runtime and catalog_token),
            provider=ReasoningGateway(UsageProvider(provider), body.request_id),
            fallback_model_configured=model is not None,
            tracked=tracked,
            store=store,
            persistence=bind_persistence(store),
            core_facade=core_facade,
            policy_answers=policy_answers,
            intent_frame=intent_frame,
            address_request=address_request,
            commerce_tools=commerce_tools,
            begin_memory=begin_memory,
            bind_runtime=lambda current: bind_runtime(
                current, actor_context, caller, core_facade.registry
            ),
            record_trace=record_trace,
            lease=lease,
            retrieve_intent_examples=retrieve_intent_examples,
        )
        return HandleTurn(prepared, body)

    register_chat(app, config, managed, semaphore, prepare_turn)

    return app
