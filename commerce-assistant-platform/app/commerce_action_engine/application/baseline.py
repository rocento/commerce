"""Installation-scoped, read-only acceptance of the existing commerce boundary."""

import asyncio
import hashlib
import json
import os
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

import httpx
from pydantic import BaseModel, ConfigDict

from app.commerce_action_engine.actions.catalog import (
    DEFINITIONS,
    CatalogResult,
    SchemaArgs,
    SearchToolArgs,
)
from app.commerce_action_engine.actions.policy import PolicyAnswers
from app.commerce_action_engine.application.catalog import registry
from app.commerce_action_engine.application.responses import (
    card,
    catalog_block,
    validate_blocks,
)
from app.commerce_action_engine.contracts import (
    AssistantAcceptance,
    AssistantReadiness,
    AssistantReadinessCheck,
)
from app.commerce_action_engine.platform import Settings
from app.commerce_action_engine.platform.failures import classify
from app.commerce_contracts.agents import Principal
from app.commerce_resolution_engine.acceptance import verify_selection
from app.commerce_resolution_engine.contracts import ModelError
from app.commerce_resolution_engine.providers import (
    ProviderConfig,
    ProviderSettings,
    strict_schema,
)
from app.commerce_resolution_engine.providers.smoke import configured_provider


class Receipt(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tenant: UUID
    result: AssistantAcceptance


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def tool_revision() -> str:
    return digest({d.name: strict_schema(d.arguments) for d in DEFINITIONS})


def not_run() -> AssistantAcceptance:
    return AssistantAcceptance(
        status="not_run",
        checked_at=None,
        configuration_revision=None,
        request_reference=None,
        duration_ms=None,
        input_tokens=None,
        output_tokens=None,
        message="Store acceptance has not been run for this configuration.",
    )


class Baseline:
    def __init__(self, settings: Settings, policies: PolicyAnswers):
        self.settings = settings
        self.policies = policies
        self.managed = ProviderSettings(ProviderConfig.from_settings(settings))
        self.path = Path(settings.acceptance_file) if settings.acceptance_file else None
        # Include the installed resolution/execution implementation and this
        # application-owned acceptance workflow, not just Git HEAD.
        app_root = Path(__file__).resolve().parents[2]
        execution = app_root / "commerce_action_engine" / "execution"
        self.artifact = digest(
            {
                str(path.relative_to(app_root)): hashlib.sha256(
                    path.read_bytes()
                ).hexdigest()
                for path in sorted(
                    [
                        *(app_root / "commerce_resolution_engine").rglob("*.py"),
                        *execution.rglob("*.py"),
                        execution / "planning" / "planning_library.json",
                        Path(__file__).resolve(),
                    ]
                )
            }
        )

    def revision(self) -> str:
        status = self.managed.status()
        stamps = []
        # Credential rotation invalidates acceptance without hashing/exporting the secret.
        for name in (
            self.settings.provider_settings_file,
            self.settings.model_key_file,
        ):
            try:
                stat = Path(name).stat() if name else None
                stamps.append(
                    (stat.st_mtime_ns, stat.st_size, stat.st_ino) if stat else None
                )
            except OSError:
                stamps.append(None)
        policies = self.policies.model_dump(mode="json")
        for entry in policies["answers"]:
            entry["phrases"] = sorted(entry["phrases"])
        return digest(
            {
                "tenant": self.settings.tenant_id,
                "provider": status.model_dump(),
                "credential_revisions": stamps,
                "flags": sorted(self.settings.feature_flags),
                "core_journeys": sorted(self.settings.core_journeys),
                "tools": tool_revision(),
                "artifact": self.artifact,
                "policies": policies,
                "collections": self.settings.knowledge_collections,
                "embedding_model": self.settings.embedding_model,
                "max_calls": self.settings.model_max_calls_per_turn,
                "planning_prices": [
                    self.settings.model_name,
                    self.settings.model_input_micros_per_1k,
                    self.settings.model_output_micros_per_1k,
                    self.settings.small_model_name,
                    self.settings.small_model_input_micros_per_1k,
                    self.settings.small_model_output_micros_per_1k,
                ],
            }
        )

    def previous(self, revision: str) -> AssistantAcceptance:
        if not self.path or not self.path.exists():
            return not_run()
        try:
            receipt = Receipt.model_validate_json(self.path.read_text())
            if str(receipt.tenant) != self.settings.tenant_id:
                return not_run()
            result = receipt.result
            if result.configuration_revision != revision:
                return result.model_copy(
                    update={
                        "status": "stale",
                        "message": "Configuration changed. Run store acceptance again.",
                    }
                )
            return result
        except (OSError, ValueError):
            return not_run()

    def save(self, result: AssistantAcceptance) -> None:
        if self.path is None:
            raise OSError("Acceptance storage not configured")
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", dir=self.path.parent, delete=False
            ) as file:
                temporary = file.name
                os.chmod(temporary, 0o600)
                file.write(
                    Receipt(
                        tenant=UUID(self.settings.tenant_id), result=result
                    ).model_dump_json()
                )
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)

    def tools(self, client: httpx.AsyncClient, token: str):  # type: ignore[no-untyped-def]
        principal = Principal(
            tenant=UUID(self.settings.tenant_id), persona="shopper", subject=None
        )
        return principal, {
            tool.definition.name: tool
            for tool in registry(client, token, principal, {})
        }

    async def readiness(
        self, client: httpx.AsyncClient, token: str, storage_ready: bool
    ) -> AssistantReadiness:
        checks = []

        def check(name: str, ok: bool, message: str, missing: bool = False) -> None:
            checks.append(
                AssistantReadinessCheck.model_validate(
                    {
                        "name": name,
                        "status": "pass"
                        if ok
                        else "not_configured"
                        if missing
                        else "fail",
                        "message": message,
                    }
                )
            )

        try:
            status = self.managed.status()
            configured = status.key_configured
            enabled = self.settings.enabled and status.enabled
            model = status.model
            revision = self.revision()
            check(
                "provider",
                configured,
                "Provider key configured; connectivity is a separate test."
                if configured
                else "Configure this store's provider key.",
                not configured,
            )
        except ModelError:
            configured, enabled, model = False, False, ""
            revision = digest(
                {"tenant": self.settings.tenant_id, "invalid_configuration": True}
            )
            check(
                "provider", False, "Provider configuration is invalid for this store."
            )
        check(
            "assistant",
            enabled,
            "Assistant enabled."
            if enabled
            else "Assistant is disabled for this store.",
            not enabled,
        )
        try:
            schema_revision = tool_revision()
            check(
                "tool_schemas",
                True,
                "All registered model tool schemas are strict closed objects.",
            )
        except ModelError:
            schema_revision = "incompatible"
            check(
                "tool_schemas",
                False,
                "Tool schemas are incompatible with the model adapter.",
            )
        try:
            principal, tools = self.tools(client, token)
            async with asyncio.timeout(5):
                result = await tools["get_catalog_schema"].handler(
                    SchemaArgs(), principal
                )
            if not isinstance(result, CatalogResult) or result.catalog_schema is None:
                raise ValueError("Missing schema")
            check(
                "catalog_tools",
                True,
                "Live catalog schema validated through the tool proxy.",
            )
        except (httpx.HTTPError, TimeoutError, ValueError):
            check(
                "catalog_tools",
                False,
                "Catalog tool route or response is unavailable/incompatible.",
            )
        knowledge = self.policies.current_count() > 0
        check(
            "knowledge",
            knowledge,
            "Current tenant-scoped guides with dated source citations are loaded."
            if knowledge
            else "No exact approved policy answers loaded. Retrieval acceptance is not established.",
            not knowledge,
        )
        check(
            "storage",
            storage_ready and self.path is not None,
            "Assistant storage and acceptance path configured."
            if storage_ready and self.path
            else "Configure assistant and durable acceptance storage.",
            not self.path,
        )
        return AssistantReadiness(
            version="1",
            tenant_id=UUID(self.settings.tenant_id),
            enabled=enabled,
            provider_configured=configured,
            model=model,
            configuration_revision=revision,
            tool_schema_revision=schema_revision,
            feature_flags=sorted(self.settings.feature_flags),
            checks=checks,
            currency_modes=["USD"],
            quantity_modes=["whole_selling_units"],
            payment_modes=["cash_on_delivery"],
            delivery_modes=["runtime_fulfillment_capabilities"],
            knowledge_configured=knowledge,
            last_acceptance=self.previous(revision),
        )

    async def accept(
        self, client: httpx.AsyncClient, token: str, query: str, reference: UUID
    ) -> AssistantAcceptance:
        started = time.monotonic()
        result = not_run().model_copy(
            update={"checked_at": datetime.now(UTC), "request_reference": reference}
        )
        try:
            result.configuration_revision = self.revision()
            provider = configured_provider(self.settings)
            if provider is None:
                result.status = "not_configured"
                result.message = (
                    "Enable and configure this store's provider before acceptance."
                )
            else:
                try:
                    async with asyncio.timeout(22):
                        principal, tools = self.tools(client, token)
                        schema = await tools["get_catalog_schema"].handler(
                            SchemaArgs(), principal
                        )
                        if (
                            not isinstance(schema, CatalogResult)
                            or schema.catalog_schema is None
                        ):
                            raise ValueError("Catalog schema unavailable")
                        products = await tools["search_products"].handler(
                            SearchToolArgs(query=query), principal
                        )
                        if (
                            not isinstance(products, CatalogResult)
                            or not products.products
                        ):
                            result.status = "fail"
                            result.message = "No product matched the acceptance query. Choose a known public catalog product."
                        else:
                            product = products.products[0]
                            response = await verify_selection(
                                provider,
                                product.model_dump_json(),
                                str(product.id),
                                DEFINITIONS,
                            )
                            block = catalog_block(
                                "product_card",
                                [card(product, [], [])],
                                "Acceptance sample",
                            )
                            validate_blocks([block])
                            result.status = "pass"
                            result.message = "Live catalog tools, provider schemas and a catalog-grounded rich card passed. Full shopping journeys require separate acceptance."
                            result.input_tokens = response.usage.input_tokens
                            result.output_tokens = response.usage.output_tokens
                finally:
                    await provider.aclose()
            if result.configuration_revision != self.revision():
                result.status = "stale"
                result.message = "Configuration changed during acceptance. Run again."
        except Exception as error:  # noqa: BLE001 -- never expose external payloads
            result.status = "fail"
            result.message = classify(error, reference).message
        result.duration_ms = int((time.monotonic() - started) * 1000)
        # A successful response must not claim durability if its receipt could not be saved.
        self.save(result)
        return result
