import json
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from app.commerce_resolution_engine.providers.openai import OpenAIProvider
from app.commerce_resolution_engine.providers.settings import (
    ProviderInput,
    ProviderSettings,
)
from app.main import create_app

pytest_plugins = ["test_assistant"]

KEY = "sk-private-settings-canary"
BODY = {"enabled": True, "model": "test-model", "api_key": KEY}


def configured(identity, tmp_path):
    config, request_id, headers = identity
    return (
        replace(config, provider_settings_file=str(tmp_path / "provider.json")),
        request_id,
        headers,
    )


def test_permissions_and_validation_never_echo_key(identity, tmp_path):
    config, _, headers = configured(identity, tmp_path)
    with TestClient(create_app(config)) as client:
        for path, method in [
            ("/v1/provider-settings", "get"),
            ("/v1/provider-settings", "post"),
            ("/v1/provider-settings/test", "post"),
        ]:
            response = client.request(
                method,
                path,
                headers=headers(),
                **({"json": BODY} if method == "post" else {}),
            )
            assert response.status_code == 401
            assert KEY not in response.text
        for invalid in [
            {**BODY, "model": "bad model"},
            {**BODY, "api_key": {"secret": KEY}},
            {**BODY, "extra": KEY},
        ]:
            response = client.post(
                "/v1/provider-settings",
                headers=headers(scope="provider_settings_write"),
                json=invalid,
            )
            assert response.status_code == 422
            assert KEY not in response.text
        assert not Path(config.provider_settings_file).exists()


def test_save_keep_rotate_remove_and_persist(identity, tmp_path):
    config, _, headers = configured(identity, tmp_path)
    with TestClient(create_app(config)) as client:

        def save(body):
            response = client.post(
                "/v1/provider-settings",
                headers=headers(scope="provider_settings_write"),
                json=body,
            )
            assert KEY not in response.text
            return response

        assert save(BODY).status_code == 200
        path = Path(config.provider_settings_file)
        assert path.stat().st_mode & 0o777 == 0o600
        assert save({"enabled": True, "model": "new-model"}).status_code == 200
        assert json.loads(path.read_text())["api_key"] == KEY
        assert save({**BODY, "api_key": "replacement-canary"}).status_code == 200
        assert json.loads(path.read_text())["api_key"] == "replacement-canary"
        assert (
            save(
                {"enabled": True, "model": "test-model", "clear_key": True}
            ).status_code
            == 400
        )
        assert (
            save(
                {"enabled": False, "model": "test-model", "clear_key": True}
            ).status_code
            == 200
        )
    with TestClient(create_app(config)) as client:
        status = client.get(
            "/v1/provider-settings", headers=headers(scope="provider_settings_read")
        ).json()
        assert status == {
            "enabled": False,
            "provider": "openai",
            "model": "test-model",
            "key_configured": False,
            "source": "admin",
            "editable": True,
        }


def test_deployment_key_is_retained_without_copy_then_explicitly_removed(
    identity, tmp_path
):
    config, _, _ = configured(identity, tmp_path)
    path = tmp_path / "deployment-key"
    path.write_text(KEY)
    managed = ProviderSettings(
        replace(
            config,
            model_key_file=str(path),
            model_provider="openai",
            model_name="original-model",
        )
    )
    assert managed.status().key_configured
    managed.save(ProviderInput(enabled=True, model="next-model"))
    assert managed.key(managed.read()) == KEY
    assert (
        json.loads(Path(config.provider_settings_file).read_text())["api_key"] is None
    )
    managed.save(ProviderInput(enabled=False, model="next-model", clear_key=True))
    assert not managed.status().key_configured
    assert path.read_text() == KEY


def test_test_connection_is_private_and_does_not_save(identity, tmp_path, monkeypatch):
    config, _, headers = configured(identity, tmp_path)
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "model": "test-model",
                "output": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "OK"}],
                    }
                ],
                "usage": {"input_tokens": 2, "output_tokens": 1, "total_tokens": 3},
            },
        )

    monkeypatch.setattr(
        "app.commerce_resolution_engine.providers.settings.OpenAIProvider",
        lambda **kwargs: OpenAIProvider(
            **kwargs, transport=httpx.MockTransport(handle)
        ),
    )
    with TestClient(create_app(config)) as client:
        response = client.post(
            "/v1/provider-settings/test",
            headers=headers(scope="provider_settings_write"),
            json=BODY,
        )
        assert response.json()["ok"] is True
        assert KEY not in response.text
    assert len(requests) == 1
    assert requests[0].headers["authorization"] == f"Bearer {KEY}"
    assert json.loads(requests[0].content)["model"] == "test-model"
    assert b"Reply with OK." in requests[0].content
    assert not Path(config.provider_settings_file).exists()


def test_provider_errors_do_not_escape(identity, tmp_path, monkeypatch):
    config, _, headers = configured(identity, tmp_path)
    monkeypatch.setattr(
        "app.commerce_resolution_engine.providers.settings.OpenAIProvider",
        lambda **kwargs: OpenAIProvider(
            **kwargs,
            transport=httpx.MockTransport(
                lambda request: httpx.Response(401, json={"error": KEY})
            ),
        ),
    )
    with TestClient(create_app(config)) as client:
        response = client.post(
            "/v1/provider-settings/test",
            headers=headers(scope="provider_settings_write"),
            json=BODY,
        )
        assert response.json() == {
            "ok": False,
            "message": "OpenAI rejected the API key.",
        }
        assert KEY not in response.text


def test_new_chats_use_saved_model_and_key_without_restart(
    identity, tmp_path, monkeypatch
):
    config, request_id, headers = configured(identity, tmp_path)
    calls = []

    def handle(request):
        calls.append(
            (json.loads(request.content)["model"], request.headers["authorization"])
        )
        return httpx.Response(401, json={"error": "test boundary"})

    monkeypatch.setattr(
        "app.commerce_resolution_engine.providers.settings.OpenAIProvider",
        lambda **kwargs: OpenAIProvider(
            **kwargs, transport=httpx.MockTransport(handle)
        ),
    )
    with TestClient(create_app(config)) as client:
        for model, key in [("first-model", KEY), ("second-model", "rotated-key")]:
            assert (
                client.post(
                    "/v1/provider-settings",
                    headers=headers(scope="provider_settings_write"),
                    json={"enabled": True, "model": model, "api_key": key},
                ).status_code
                == 200
            )
            response = client.post(
                "/v1/chat",
                headers=headers(),
                json={"request_id": request_id, "message": "Hello"},
            )
            assert response.status_code == 200
            assert KEY not in response.text
        client.post(
            "/v1/provider-settings",
            headers=headers(scope="provider_settings_write"),
            json={"enabled": False, "model": "second-model"},
        )
        response = client.post(
            "/v1/chat",
            headers=headers(),
            json={"request_id": request_id, "message": "Hello"},
        )
        assert response.status_code == 503
        # No language URL is configured by this provider-only fixture.
        assert client.get("/ready").status_code == 503
        assert client.get("/ready").json()["components"]["language"] == "not_configured"
        assert (
            client.get(
                "/v1/provider-settings", headers=headers(scope="provider_settings_read")
            ).status_code
            == 200
        )
    assert calls == [
        ("first-model", f"Bearer {KEY}"),
        ("second-model", "Bearer rotated-key"),
    ]


def test_managed_assistant_defaults_off_and_remains_configurable(identity, tmp_path):
    config, request_id, headers = configured(identity, tmp_path)
    with TestClient(create_app(config)) as client:
        status = client.get(
            "/v1/provider-settings", headers=headers(scope="provider_settings_read")
        )
        assert status.status_code == 200
        assert status.json()["enabled"] is False
        assert status.json()["editable"] is True
        # No language URL is configured by this provider-only fixture.
        assert client.get("/ready").status_code == 503
        assert client.get("/ready").json()["components"]["language"] == "not_configured"
        assert (
            client.post(
                "/v1/chat",
                headers=headers(),
                json={"request_id": request_id, "message": "Hello"},
            ).status_code
            == 503
        )


def test_service_configuration_does_not_depend_on_enabled_env(
    identity, tmp_path, monkeypatch
):
    config, _, _ = identity
    public = tmp_path / "public.pem"
    public.write_text(config.verification_key)
    monkeypatch.setenv("ASSISTANT_TENANT_ID", config.tenant_id)
    monkeypatch.setenv("ASSISTANT_PUBLIC_KEY_FILE", str(public))
    monkeypatch.delenv("ASSISTANT_ENABLED", raising=False)
    assert type(config).environment().enabled
    monkeypatch.setenv("ASSISTANT_ENABLED", "false")
    assert type(config).environment().enabled


def test_wrong_tenant_cannot_read_or_write(identity, tmp_path):
    config, _, headers = configured(identity, tmp_path)
    with TestClient(create_app(config)) as client:
        assert (
            client.get(
                "/v1/provider-settings",
                headers=headers(scope="provider_settings_read", tenant=str(uuid4())),
            ).status_code
            == 401
        )
        assert (
            client.post(
                "/v1/provider-settings",
                headers=headers(scope="provider_settings_write", tenant=str(uuid4())),
                json=BODY,
            ).status_code
            == 401
        )


def test_provider_smoke_uses_managed_key_and_model_without_stale_fallback(
    identity, tmp_path, monkeypatch
):
    from app.provider_smoke import configured_provider

    config, _, _ = configured(identity, tmp_path)
    stale = tmp_path / "obsolete-key"
    stale.write_text("obsolete-canary")
    config = replace(
        config,
        model_provider="openai",
        model_key_file=str(stale),
        model_name="obsolete-model",
    )
    managed = ProviderSettings(config)
    managed.save(ProviderInput(**BODY))
    captured = {}

    def provider(**kwargs):
        captured.update(kwargs)
        return object()

    monkeypatch.setattr(
        "app.commerce_resolution_engine.providers.settings.OpenAIProvider", provider
    )
    assert configured_provider(config) is not None
    assert captured["api_key"] == KEY and captured["model"] == BODY["model"]
    managed.save(ProviderInput(enabled=False, model=BODY["model"]))
    assert configured_provider(config) is None
    Path(config.provider_settings_file).unlink()
    assert configured_provider(config) is None


def test_provider_configuration_retains_only_provider_inputs(identity):
    from dataclasses import FrozenInstanceError

    from app.commerce_resolution_engine.providers import ProviderConfig

    config, _, _ = identity
    config = replace(config, store_password_file="private-store-credential-canary")
    managed = ProviderSettings(config)  # Legacy callers remain accepted.
    assert isinstance(managed.settings, ProviderConfig)
    assert managed.settings.tenant_id == config.tenant_id
    assert not hasattr(managed.settings, "verification_key")
    assert "private-store-credential-canary" not in repr(managed.settings)
    with pytest.raises(FrozenInstanceError):
        managed.settings.model_name = "changed"


@pytest.mark.parametrize("saved", [False, True])
def test_bootstrap_injects_provider_tracing_and_owns_cleanup(
    identity, tmp_path, monkeypatch, saved
):
    from test_runtime import final

    from app.commerce_action_engine.platform.telemetry import TurnTrace
    from app.commerce_contracts.language_proposal import LanguageProposal

    config, request_id, headers = configured(identity, tmp_path)
    if not saved:
        config = replace(config, provider_settings_file="")
    else:
        ProviderSettings(config).save(ProviderInput(**BODY))

    class Provider:
        model = "test-model"
        closed = False
        calls = 0

        async def generate(self, request):
            self.calls += 1
            return replace(
                final(),
                structured=LanguageProposal(
                    status="CONVERSATION",
                    intent="CONVERSATION_GREETING",
                    canonical_text=None,
                ),
            )

        async def aclose(self):
            self.closed = True

    provider = Provider()
    traces = []
    monkeypatch.setattr(
        "app.commerce_action_engine.application.bootstrap.build_provider",
        lambda config: provider,
    )
    monkeypatch.setattr(
        "app.commerce_resolution_engine.providers.settings.OpenAIProvider",
        lambda **kw: provider,
    )
    monkeypatch.setattr(TurnTrace, "emit", lambda self, *args: traces.append(self))
    with TestClient(create_app(config)) as client:
        response = client.post(
            "/v1/chat",
            headers=headers(),
            json={"request_id": request_id, "message": "Hello"},
        )
        assert response.status_code == 200
        assert "event: message.delta" in response.text
        assert "event: error" not in response.text
        assert provider.closed is saved
    assert provider.closed and provider.calls == 1
    assert traces[-1].totals["provider_count"] == 1
    assert (
        traces[-1].provider_first_token_ms is None
    )  # Structured generation has no text delta.
