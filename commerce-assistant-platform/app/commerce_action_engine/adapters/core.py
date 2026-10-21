"""Thin adapters over the verified model, scoped commerce proxy and history store."""

import time
from dataclasses import replace
from uuid import UUID, uuid4, uuid5

from pydantic import BaseModel

from app.commerce_action_engine.actions.catalog import (
    CatalogResult,
    Product,
    ProductArgs,
    SearchToolArgs,
)
from app.commerce_action_engine.adapters.reasoning import (
    reasoning_adapter,
)
from app.commerce_action_engine.contracts.action import (
    ActorContext,
    DecisionTrace,
    EvidenceRef,
    Freshness,
    ProviderCapabilities,
)
from app.commerce_action_engine.contracts.ports import (
    ProductFact,
    SearchQuery,
    SearchResult,
)
from app.commerce_action_engine.execution.agents import Principal
from app.commerce_action_engine.execution.core.registry import (
    Registry,
    RegistryError,
)
from app.commerce_action_engine.platform import Store
from app.commerce_resolution_engine.runtime import AgentRuntime, RuntimeTool


class SystemClock:
    def now(self) -> int:
        return int(time.time())


class SystemIds:
    def new_id(self) -> str:
        return str(uuid4())

    def idempotency_key(self, context: ActorContext, operation: str) -> str:
        return str(
            uuid5(
                UUID(context.request_id),
                f"{context.tenant_id}/{context.store_id}/{context.session_id}/{operation}",
            )
        )


class CommerceCatalogAdapter:
    """Rust owns Meilisearch and fact revalidation; Python only wraps its fixed tools."""

    def __init__(
        self, tools: dict[str, RuntimeTool], principal: Principal, context: ActorContext
    ):
        self.tools, self.principal, self.context = tools, principal, context
        if (
            str(principal.tenant) != context.tenant_id
            or (str(principal.subject) if principal.subject else None)
            != context.principal_id
        ):
            raise RegistryError("principal_context_mismatch")

    def _scope(self, context: ActorContext) -> None:
        if context != self.context:
            raise RegistryError("request_context_mismatch")

    async def execute(
        self, name: str, arguments: BaseModel, principal: Principal
    ) -> BaseModel:
        if principal != self.principal or name not in self.tools:
            raise RegistryError("tool_context_mismatch")
        tool = self.tools[name]
        if tool.classification != "read":
            raise RegistryError("write_tool_not_available")
        return await tool.handler(arguments, principal)

    def runtime_tools(self) -> dict[str, RuntimeTool]:
        def wrap(name: str, tool: RuntimeTool) -> RuntimeTool:
            async def handler(arguments: BaseModel, principal: Principal) -> BaseModel:
                return await self.execute(name, arguments, principal)

            return replace(tool, handler=handler)

        return {name: wrap(name, tool) for name, tool in self.tools.items()}

    def _fact(self, product: Product) -> ProductFact:
        now = SystemClock().now()
        return ProductFact(
            product_id=str(product.id),
            name=product.name,
            price=product.price,
            currency=product.currency,
            in_stock=product.in_stock,
            evidence=EvidenceRef(
                source_kind="catalog",
                source_id=f"product/{product.id}",
                source_version="live-read",
                freshness=Freshness(observed_at=now, expires_at=now + 60),
                display="cite",
            ),
        )

    async def search(self, context: ActorContext, query: SearchQuery) -> SearchResult:
        self._scope(context)
        # Later search/constraint milestones own richer translation. Never drop a
        # constraint just because this compatibility port cannot express it.
        if query.constraints.constraints or query.constraints.conflict != "none":
            raise RegistryError("unsupported_search_constraints")
        raw = await self.execute(
            "search_products", SearchToolArgs(query=query.text), self.principal
        )
        result = CatalogResult.model_validate_json(raw.model_dump_json())
        return SearchResult(
            products=tuple(self._fact(p) for p in result.products[: query.limit])
        )

    async def _product(
        self, name: str, context: ActorContext, product_id: str
    ) -> ProductFact:
        self._scope(context)
        raw = await self.execute(
            name, ProductArgs(product_id=product_id), self.principal
        )
        result = CatalogResult.model_validate_json(raw.model_dump_json())
        if len(result.products) != 1 or str(result.products[0].id) != product_id:
            raise RegistryError("product_not_available")
        return self._fact(result.products[0])

    async def product(self, context: ActorContext, product_id: str) -> ProductFact:
        return await self._product("get_product", context, product_id)

    async def price(self, context: ActorContext, product_id: str) -> ProductFact:
        return await self._product("get_product_price", context, product_id)

    async def availability(self, context: ActorContext, product_id: str) -> ProductFact:
        return await self._product("get_product_inventory", context, product_id)


class StoreTraceAdapter:
    """Existing tenant-scoped metrics storage; no new database or goal table."""

    def __init__(
        self,
        store: Store,
        context: ActorContext,
        *,
        outcome: str,
        latency_ms: int,
        metadata: dict[str, object],
        conversation_id: UUID | None = None,
    ):
        self.store = store
        self.context, self.outcome, self.latency_ms = context, outcome, latency_ms
        self.metadata, self.conversation_id = metadata, conversation_id

    async def record(self, trace: DecisionTrace) -> None:
        if (trace.tenant_id, trace.store_id, trace.request_id) != (
            self.context.tenant_id,
            self.context.store_id,
            self.context.request_id,
        ):
            raise RegistryError("trace_context_mismatch")
        await self.store.metric(
            UUID(trace.tenant_id),
            UUID(trace.request_id),
            self.outcome,
            self.latency_ms,
            {**self.metadata, "core": trace.model_dump(mode="json")},
            self.conversation_id,
            UUID(self.context.principal_id) if self.context.principal_id else None,
        )


def bind_runtime(
    runtime: AgentRuntime,
    context: ActorContext,
    principal: Principal,
    registry: Registry,
) -> AgentRuntime:
    from app.commerce_action_engine.contracts.action import DefinitionRef

    def capabilities(name: str) -> ProviderCapabilities:
        records = registry.resolve(
            DefinitionRef(id=f"provider://reasoning/{name}", version="1.0.0"),
            context,
            now=SystemClock().now(),
        )
        result = records[-1]
        if not isinstance(result, ProviderCapabilities):
            raise RegistryError("invalid_provider_definition")
        return result

    tools = CommerceCatalogAdapter(runtime.tools, principal, context).runtime_tools()
    return AgentRuntime(
        runtime.catalog,
        {
            name: reasoning_adapter(provider, capabilities(name))
            for name, provider in runtime.providers.items()
        },
        tools=tuple(tools.values()),
        knowledge=runtime.knowledge,
        retriever=runtime.retriever,
        trace_phase=runtime.trace_phase,
        shopping=runtime.shopping,
        shopping_handler=runtime.shopping_handler,
        grounded_intent=runtime.grounded_intent,
        commerce_meaning=runtime.commerce_meaning,
        commerce_planning=runtime.commerce_planning,
        planning_prices=runtime.planning_prices,
    )
