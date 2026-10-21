"""Read-only catalog access supplied to runtime-tool composition."""

from typing import Protocol

from pydantic import BaseModel

from app.commerce_action_engine.actions.catalog.contracts import CatalogResult
from app.commerce_contracts.agents import Principal


class CatalogReader(Protocol):
    async def read(
        self, name: str, arguments: BaseModel, caller: Principal
    ) -> CatalogResult: ...
