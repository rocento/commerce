"""Compose fixed catalog runtime tools with scoped transport and telemetry."""

from collections.abc import Awaitable, Callable

import httpx
from pydantic import BaseModel

from app.commerce_action_engine.actions.catalog.cache import CatalogCache
from app.commerce_action_engine.actions.catalog.contracts import CatalogResult
from app.commerce_action_engine.actions.catalog.ports import CatalogReader
from app.commerce_action_engine.actions.catalog.tools import DEFINITIONS
from app.commerce_action_engine.adapters.catalog import CatalogTransport
from app.commerce_action_engine.platform import (
    SingleFlight,
    catalog_counter,
    discovery_summary,
)
from app.commerce_contracts.agents import Principal
from app.commerce_resolution_engine.contracts import ToolDefinition
from app.commerce_resolution_engine.runtime import RuntimeTool


def catalog_tools(reader: CatalogReader) -> tuple[RuntimeTool, ...]:
    def handler(
        definition: ToolDefinition,
    ) -> Callable[[BaseModel, Principal], Awaitable[BaseModel]]:
        async def execute(arguments: BaseModel, caller: Principal) -> BaseModel:
            return await reader.read(definition.name, arguments, caller)

        return execute

    return tuple(
        RuntimeTool(
            definition=definition,
            output=CatalogResult,
            handler=handler(definition),
            personas=frozenset({"shopper"}),
            permissions=frozenset(),
            classification="read",
            authenticated=False,
            timeout_seconds=5,
        )
        for definition in DEFINITIONS
    )


def registry(
    client: httpx.AsyncClient,
    capability: str,
    principal: Principal,
    delivery_headers: dict[str, str],
    singleflight: SingleFlight[CatalogResult] | None = None,
    cache: CatalogCache | None = None,
) -> tuple[RuntimeTool, ...]:
    return catalog_tools(
        CatalogTransport(
            client,
            capability,
            principal,
            delivery_headers,
            singleflight,
            cache,
            record_counter=catalog_counter,
            record_discovery=discovery_summary,
        )
    )
