import json
from dataclasses import replace
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from app.commerce_action_engine.actions.policy import PolicyAnswers
from app.commerce_action_engine.application.baseline import Baseline
from app.commerce_resolution_engine.acceptance import Selection
from app.commerce_resolution_engine.contracts import ModelError, ModelResponse, Usage
from app.commerce_resolution_engine.providers.settings import (
    ProviderInput,
    ProviderSettings,
)
from app.main import create_app

pytest_plugins = ["test_assistant"]
PRODUCT = str(UUID(int=7))
CATALOG = {
    "products": [
        {
            "id": PRODUCT,
            "name": "Milk",
            "price": "2.00",
            "currency": "USD",
            "category_id": str(UUID(int=8)),
            "product_type": "simple",
            "attributes": [],
            "in_stock": None,
            "route": f"/products/{PRODUCT}",
        }
    ],
    "category": None,
}


def settings(identity, tmp_path):
    config, _, _ = identity
    config = replace(
        config,
        provider_settings_file=str(tmp_path / "provider.json"),
        acceptance_file=str(tmp_path / "acceptance.json"),
    )
    ProviderSettings(config).save(
        ProviderInput(enabled=True, model="test-model", api_key="private-canary")
    )
    return config


def transport(calls, broken=False):
    def handle(request):
        assert request.url.path == "/v1/assistant-tools/shopper"
        assert request.headers["authorization"] == "Bearer read-only-catalog"
        body = json.loads(request.content)
        calls.append(body)
        if broken:
            return httpx.Response(404, json={"error": "secret-internal-canary"})
        if body["name"] == "get_catalog_schema":
            return httpx.Response(
                200,
                json={
                    "products": [],
                    "category": None,
                    "catalog_schema": {
                        "industry": "grocery",
                        "version": "1",
                        "attributes": [],
                    },
                },
            )
        assert body["name"] == "search_products"
        return httpx.Response(200, json=CATALOG)

    return httpx.MockTransport(handle)


class Provider:
    def __init__(self, wrong=False):
        self.wrong = wrong
        self.calls = []
        self.closed = False

    async def generate(self, request):
        self.calls.append(request)
        return ModelResponse(
            "",
            (),
            Selection(product_id=str(uuid4()) if self.wrong else PRODUCT),
            Usage(20, 5, 25),
            "test-model",
            "stop",
        )

    async def aclose(self):
        self.closed = True


def test_acceptance_is_scoped_read_only_durable_and_invalidated(
    identity, tmp_path, monkeypatch
):
    config = settings(identity, tmp_path)
    _, reference, headers = identity
    calls = []
    provider = Provider()
    monkeypatch.setattr(
        "app.commerce_action_engine.application.baseline.configured_provider",
        lambda _: provider,
    )
    with TestClient(create_app(config, transport=transport(calls))) as client:
        auth = {
            **headers(scope="provider_settings_write"),
            "x-commerce-catalog-token": "read-only-catalog",
        }
        result = client.post(
            "/v1/provider-settings/acceptance", headers=auth, json={"query": "milk"}
        )
        assert result.status_code == 200
        assert result.json()["status"] == "pass"
        assert result.json()["request_reference"] == reference
        assert result.json()["input_tokens"] == 20
        assert "private-canary" not in result.text
        assert len(provider.calls) == 1 and provider.closed
        assert len(provider.calls[0].tools) == 8
        assert [v["name"] for v in calls] == ["get_catalog_schema", "search_products"]
        assert Path(config.acceptance_file).stat().st_mode & 0o777 == 0o600
        read = {
            **headers(scope="provider_settings_read"),
            "x-commerce-catalog-token": "read-only-catalog",
        }
        assert (
            client.get("/v1/provider-settings/readiness", headers=read).json()[
                "last_acceptance"
            ]["status"]
            == "pass"
        )
        ProviderSettings(config).save(
            ProviderInput(enabled=True, model="changed-model")
        )
        assert (
            client.get("/v1/provider-settings/readiness", headers=read).json()[
                "last_acceptance"
            ]["status"]
            == "stale"
        )
    # Restart retains this store's receipt; another installation never inherits it.
    baseline = Baseline(config, PolicyAnswers())
    assert baseline.previous(baseline.revision()).status == "stale"
    other = Baseline(replace(config, tenant_id=str(uuid4())), PolicyAnswers())
    assert other.previous("anything").status == "not_run"


@pytest.mark.parametrize("path,method", [("readiness", "get"), ("acceptance", "post")])
def test_diagnostics_require_scope_and_tenant(identity, tmp_path, path, method):
    config = settings(identity, tmp_path)
    _, _, headers = identity
    with TestClient(create_app(config)) as client:
        for auth in (
            headers(),
            headers(
                scope="provider_settings_write"
                if method == "post"
                else "provider_settings_read",
                tenant=str(uuid4()),
            ),
        ):
            response = client.request(
                method,
                f"/v1/provider-settings/{path}",
                headers=auth,
                **({"json": {"query": "milk"}} if method == "post" else {}),
            )
            assert response.status_code == 401


@pytest.mark.parametrize("broken,wrong", [(True, False), (False, True)])
def test_failed_catalog_or_unverified_model_selection_never_passes(
    identity, tmp_path, monkeypatch, broken, wrong
):
    config = settings(identity, tmp_path)
    _, _, headers = identity
    provider = Provider(wrong)
    monkeypatch.setattr(
        "app.commerce_action_engine.application.baseline.configured_provider",
        lambda _: provider,
    )
    with TestClient(create_app(config, transport=transport([], broken))) as client:
        response = client.post(
            "/v1/provider-settings/acceptance",
            headers={
                **headers(scope="provider_settings_write"),
                "x-commerce-catalog-token": "read-only-catalog",
            },
            json={"query": "milk"},
        )
        assert response.json()["status"] == "fail"
        assert "canary" not in response.text
        assert provider.closed
        assert len(provider.calls) == (0 if broken else 1)


def test_invalid_provider_has_useful_isolated_readiness(identity, tmp_path):
    config = settings(identity, tmp_path)
    _, _, headers = identity
    Path(config.provider_settings_file).write_text('{"secret":"canary"}')
    with TestClient(create_app(config, transport=transport([]))) as client:
        response = client.get(
            "/v1/provider-settings/readiness",
            headers={
                **headers(scope="provider_settings_read"),
                "x-commerce-catalog-token": "read-only-catalog",
            },
        )
        assert response.status_code == 200
        assert response.json()["checks"][0]["status"] == "fail"
        assert "canary" not in response.text
        assert client.get("/health").status_code == 200


def test_missing_acceptance_storage_cannot_report_success(
    identity, tmp_path, monkeypatch
):
    config = replace(settings(identity, tmp_path), acceptance_file="")
    _, _, headers = identity
    monkeypatch.setattr(
        "app.commerce_action_engine.application.baseline.configured_provider",
        lambda _: Provider(),
    )
    with TestClient(create_app(config, transport=transport([]))) as client:
        result = client.post(
            "/v1/provider-settings/acceptance",
            headers={
                **headers(scope="provider_settings_write"),
                "x-commerce-catalog-token": "read-only-catalog",
            },
            json={"query": "milk"},
        )
        assert result.status_code == 503


def test_provider_secret_never_appears_in_failed_receipt(
    identity, tmp_path, monkeypatch
):
    config = settings(identity, tmp_path)
    _, _, headers = identity

    def failed(_):
        raise ModelError("authentication")

    monkeypatch.setattr(
        "app.commerce_action_engine.application.baseline.configured_provider", failed
    )
    with TestClient(create_app(config, transport=transport([]))) as client:
        result = client.post(
            "/v1/provider-settings/acceptance",
            headers=headers(scope="provider_settings_write"),
            json={"query": "milk"},
        )
        assert result.json()["status"] == "fail"
        assert "sign in" not in result.json()["message"].lower()
        assert "private-canary" not in Path(config.acceptance_file).read_text()


def test_acceptance_revision_tracks_moved_workflow_and_resolution_sources(
    identity, tmp_path, monkeypatch
):
    from app.commerce_action_engine.application import baseline

    config = settings(identity, tmp_path)
    app_root = tmp_path / "installed" / "app"
    workflow = app_root / "commerce_action_engine/application/baseline.py"
    execution = (
        app_root / "commerce_action_engine/execution/planning/planning_library.json"
    )
    probe = app_root / "commerce_resolution_engine/acceptance.py"
    for path in (workflow, execution, probe):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("initial")
    monkeypatch.setattr(baseline, "__file__", str(workflow))
    first = Baseline(config, PolicyAnswers()).artifact
    workflow.write_text("changed acceptance implementation")
    second = Baseline(config, PolicyAnswers()).artifact
    probe.write_text("changed provider probe")
    third = Baseline(config, PolicyAnswers()).artifact
    assert len({first, second, third}) == 3
