"""Fixed catalog HTTP reads with scoped caching and coalescing; never writes."""

import hashlib
import json
from collections.abc import Awaitable, Callable, Mapping
from typing import Literal, Protocol

import httpx
from pydantic import BaseModel

from app.commerce_action_engine.actions.catalog.cache import CatalogCache
from app.commerce_action_engine.actions.catalog.contracts import (
    CatalogResult,
    SearchArgs,
    SearchToolArgs,
)
from app.commerce_action_engine.actions.catalog.discovery import DiscoveryReport
from app.commerce_action_engine.actions.catalog.tools import SHOPPER_TOOLS
from app.commerce_action_engine.shared.errors import ToolDenied
from app.commerce_contracts.agents import Principal
from app.commerce_resolution_engine.boundaries import boundary

CatalogCounter = Literal[
    "catalog_cache_hits", "catalog_network_calls", "catalog_coalesced"
]


class CatalogCoalescer(Protocol):
    @property
    def tasks(self) -> Mapping[str, object]: ...

    async def run(
        self, key: str, operation: Callable[[], Awaitable[CatalogResult]]
    ) -> CatalogResult: ...


class CatalogTransport:
    def __init__(
        self,
        client: httpx.AsyncClient,
        capability: str,
        principal: Principal,
        delivery_headers: dict[str, str],
        singleflight: CatalogCoalescer | None = None,
        cache: CatalogCache | None = None,
        *,
        record_counter: Callable[[CatalogCounter], None],
        record_discovery: Callable[[DiscoveryReport | None], None],
    ):
        self.client = client
        self.capability = capability
        self.principal = principal
        self.delivery_headers = delivery_headers
        self.singleflight = singleflight
        self.cache = cache
        self.record_counter = record_counter
        self.record_discovery = record_discovery

    async def read(
        self, name: str, arguments: BaseModel, caller: Principal
    ) -> CatalogResult:
        if (
            caller != self.principal
            or caller.persona != "shopper"
            or not self.capability
        ):
            raise ValueError("Invalid execution context")
        if name not in SHOPPER_TOOLS:
            raise ValueError("Unregistered catalog read")
        headers = {
            "Authorization": f"Bearer {self.capability}",
            "X-Commerce-Request": "1",
        }
        headers.update(
            {
                key: value
                for key, value in self.delivery_headers.items()
                if key in ("x-delivery-latitude", "x-delivery-longitude")
            }
        )
        payload = arguments.model_dump(mode="json")
        if name == "search_products":
            search = SearchToolArgs.model_validate(payload, strict=True)
            filters = {item.name: item.value for item in search.attributes}
            if len(filters) != len(search.attributes):
                raise ValueError("Duplicate attribute filter")
            payload["attributes"] = filters
            payload = SearchArgs.model_validate(payload, strict=True).model_dump(
                mode="json"
            )
        request = {"name": name, "arguments": payload}
        key = hashlib.sha256(
            json.dumps(
                {
                    "principal": self.principal.model_dump(mode="json"),
                    "delivery": self.delivery_headers,
                    "request": request,
                },
                sort_keys=True,
                default=sorted,
            ).encode()
        ).hexdigest()

        async def fetch() -> CatalogResult:
            self.record_counter("catalog_network_calls")
            cached = self.cache.get(key) if self.cache else None
            if cached:
                headers["If-None-Match"] = cached.revision
            with boundary("api-gateway", "catalog." + name) as call:
                async with self.client.stream(
                    "POST",
                    "/v1/assistant-tools/shopper",
                    headers={**headers, **call.headers} if call else headers,
                    json=request,
                ) as response:
                    if call:
                        call.received(response.headers, response.status_code)
                    if response.status_code == 304:
                        if (
                            cached is None
                            or response.headers.get("etag") != cached.revision
                        ):
                            raise ValueError("Invalid catalog revision")
                        self.record_counter("catalog_cache_hits")
                        return CatalogResult.model_validate_json(cached.body)
                    if response.status_code == 403:
                        raise ToolDenied()
                    response.raise_for_status()
                    data = bytearray()
                    async for chunk in response.aiter_bytes():
                        data.extend(chunk)
                        if len(data) > (
                            131072
                            if name in {"get_catalog_schema", "search_products"}
                            else 32768
                        ):
                            raise ValueError("Tool response too large")
                    result = CatalogResult.model_validate_json(data)
                    if self.cache:
                        self.cache.put(
                            key, response.headers.get("etag", ""), bytes(data)
                        )
                    return result

        if self.singleflight is None:
            result = await fetch()
            self.record_discovery(result.discovery)
            return result
        # Only equivalent signed capabilities may share authorization work.
        flight_key = key + hashlib.sha256(self.capability.encode()).hexdigest()
        if flight_key in self.singleflight.tasks:
            self.record_counter("catalog_coalesced")
        result = await self.singleflight.run(flight_key, fetch)
        self.record_discovery(result.discovery)
        return result.model_copy(deep=True)
