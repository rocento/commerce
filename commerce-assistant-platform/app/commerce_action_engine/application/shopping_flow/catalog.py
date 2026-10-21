"""Validated catalog calls, per-request budgets and schema discovery."""

import asyncio
from collections.abc import Callable, Mapping

from app.commerce_action_engine.actions.catalog import (
    DTO,
    CatalogResult,
    CatalogSchema,
    SchemaArgs,
)
from app.commerce_action_engine.execution.agents import Agent, Principal
from app.commerce_action_engine.execution.planning import PlanningSession
from app.commerce_action_engine.platform import phase
from app.commerce_action_engine.shared.errors import RuntimeErrorCode, ToolDenied
from app.commerce_resolution_engine.diagnostics import (
    function_details_enabled,
    record_function_details,
    traced,
)
from app.commerce_resolution_engine.runtime import RuntimeTool


class ShoppingCatalog:
    """Request-scoped catalog invocation; failed attempts also consume the budget."""

    def __init__(
        self,
        tools: Mapping[str, RuntimeTool],
        agent: Agent,
        principal: Principal,
        planning: PlanningSession | None,
        on_tool: Callable[[str], None] | None = None,
    ):
        self.tools = tools
        self.agent = agent
        self.principal = principal
        self.planning = planning
        self.on_tool = on_tool
        self.calls = 0

    @property
    def limit(self) -> int:
        return self.agent.safety.max_tool_calls

    @traced
    async def call(self, name: str, args: DTO) -> CatalogResult:
        if function_details_enabled():
            # Catalog-only allowlist: never capture credentials, shopper identity,
            # arbitrary tool arguments, returned product bodies or exception text.
            selected = args.model_dump(
                mode="json",
                include={
                    "query",
                    "category_id",
                    "currency",
                    "min_price",
                    "max_price",
                    "exclusive_min",
                    "exclusive_max",
                    "in_stock",
                    "attributes",
                    "predicates",
                },
                exclude_none=True,
            )
            record_function_details({"operation": name[:80], "criteria": selected})
        if name not in self.tools or self.calls >= self.agent.safety.max_tool_calls:
            raise RuntimeErrorCode("tool_not_allowed")
        self.calls += 1
        if self.on_tool:
            self.on_tool(name)
        tool = self.tools[name]
        arguments = tool.definition.arguments.model_validate(
            args.model_dump(), strict=True
        )
        try:
            async with asyncio.timeout(tool.timeout_seconds):
                with phase("tool"):
                    if self.planning:
                        result = await self.planning.perform(
                            "catalog." + name,
                            arguments,
                            lambda: tool.handler(arguments, self.principal),
                            lambda value: value,
                        )
                    else:
                        result = await tool.handler(arguments, self.principal)
        except (RuntimeErrorCode, ToolDenied):
            raise
        except Exception:  # noqa: BLE001 -- tool boundary must not leak upstream errors
            raise RuntimeErrorCode("tool_unavailable") from None
        # Catalog metadata describes the whole store, unlike a bounded product
        # result. Admit it within the existing context budget; shopping_request
        # still checks the complete prompt, including instructions and history.
        result_limit = (
            self.agent.safety.max_context_characters
            if name == "get_catalog_schema"
            # Search evidence is consumed by deterministic filtering/ranking,
            # never added to model context. Match the catalog transport's 128 KiB
            # ceiling for up to eight products with attributes and provenance.
            else 131072
            if name == "search_products"
            else self.agent.safety.max_tool_result_characters
        )
        if len(result.model_dump_json()) > result_limit:
            raise RuntimeErrorCode("tool_result_limit")
        validated = CatalogResult.model_validate_json(result.model_dump_json())
        record_function_details(
            {
                "products_returned": len(validated.products),
                "schema_returned": validated.catalog_schema is not None,
            }
        )
        return validated

    @traced
    async def discover(self) -> tuple[CatalogSchema, str | None]:
        default_currency = None
        if "get_catalog_schema" in self.tools:
            discovered = await self.call("get_catalog_schema", SchemaArgs())
            if discovered.catalog_schema is None:
                raise RuntimeErrorCode("tool_unavailable")
            schema = discovered.catalog_schema
            default_currency = discovered.default_currency
            if self.planning:
                self.planning.discover_industry(
                    schema.industry, tuple(a.code for a in schema.attributes)
                )
        else:
            # Support-only agents can classify unrelated requests with no catalog capabilities.
            schema = CatalogSchema(industry=None, version="unavailable", attributes=[])
        return schema, default_currency
