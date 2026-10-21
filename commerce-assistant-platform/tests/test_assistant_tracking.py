"""Tracking admission, bounded paging, missing reports and durable redacted capture."""

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_assistant import identity as identity  # noqa: PLC0414

from app.commerce_action_engine.application.api.tracking import register_tracking
from app.commerce_action_engine.platform.tracking import TrackingStore


def client_for(config, store):
    app = FastAPI()
    register_tracking(app, config, store)
    return TestClient(app)


def test_shopper_wrong_tenant_and_missing_tokens_cannot_read_tracking(identity):
    config, _, headers = identity
    store = SimpleNamespace(tracking_list=AsyncMock())
    with client_for(config, store) as client:
        for token in [
            {},
            headers(),
            headers(scope="history"),
            headers(scope="tracking_read", tenant=str(uuid4()), sub=None, sid=None),
        ]:
            assert client.get("/v1/tracking", headers=token).status_code == 401
        assert (
            client.get(
                "/v1/tracking", headers=headers(scope="tracking_read")
            ).status_code
            == 403
        )
    store.tracking_list.assert_not_awaited()


def test_operator_list_uses_keyset_cursor_and_validated_filters(identity):
    config, _, headers = identity
    timestamp = datetime.now(UTC)
    ids = [uuid4(), uuid4()]
    store = SimpleNamespace(
        tracking_list=AsyncMock(
            return_value=[
                {"request_id": ident, "created_at": timestamp} for ident in ids
            ]
        )
    )
    auth = headers(scope="tracking_read", sub=None, sid=None)
    with client_for(config, store) as client:
        response = client.get(
            "/v1/tracking?limit=1&hours=72&outcome=completed", headers=auth
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data["items"]) == 1 and data["retention_days"] == 7
        cursor = data["next_cursor"]
        client.get("/v1/tracking", params={"cursor": cursor}, headers=auth)
        assert store.tracking_list.await_args.kwargs["before"] == timestamp
        assert store.tracking_list.await_args.kwargs["before_id"] == ids[0]
        assert store.tracking_list.await_args.args == (UUID(config.tenant_id),)
        assert (
            client.get("/v1/tracking?outcome=denied", headers=auth).status_code == 200
        )
        assert store.tracking_list.await_args.kwargs["outcome"] == "denied"
        for params in [
            {"limit": 51},
            {"hours": 169},
            {"outcome": "invalid"},
            {"request_id": "invalid"},
            {"cursor": "2026-10-03|" + str(ids[0])},
        ]:
            assert (
                client.get("/v1/tracking", params=params, headers=auth).status_code
                == 422
            )


def test_reports_missing_or_storage_unavailable_have_clear_errors(identity):
    config, request_id, headers = identity
    auth = headers(scope="tracking_read", sub=None, sid=None)
    store = SimpleNamespace(tracking_report=AsyncMock(return_value=None))
    with client_for(config, store) as client:
        assert client.get("/v1/tracking/" + request_id, headers=auth).status_code == 404
        store.tracking_report.side_effect = RuntimeError("private DB details")
        response = client.get("/v1/tracking/" + request_id, headers=auth)
        assert response.status_code == 503 and "private DB" not in response.text


class Scope:
    def __init__(self, value):
        self.value = value

    async def __aenter__(self):
        return self.value

    async def __aexit__(self, *args):
        pass


def test_storage_redacts_capture_and_parameterizes_tenant():
    tenant, request = uuid4(), uuid4()
    connection = SimpleNamespace(execute=AsyncMock(), transaction=lambda: Scope(None))
    store = TrackingStore()
    store.pool = SimpleNamespace(connection=lambda: Scope(connection))
    document = {
        "version": 1,
        "request_id": str(request),
        "truncated": False,
        "events": [
            {
                "stage": "customer_request",
                "data": {"message": "email me test@example.com password=secret-token"},
            },
            {
                "stage": "provider_wire_payload",
                "data": {"input": [{"content": "Bearer secret-token"}]},
            },
        ],
    }
    asyncio.run(store.save_tracking(tenant, request, document))
    calls = connection.execute.await_args_list
    assert calls[0].args[1] == (str(tenant),)
    values = calls[1].args[1]
    assert values[:2] == (tenant, request)
    assert "secret-token" not in str(values[2]) and "test@example.com" not in str(
        values[2]
    )
    report = values[3].obj
    assert report["redacted"] and report["request_id"] == str(request)
    assert "secret-token" not in str(report)
    assert "DELETE FROM assistant.tracking_reports" in calls[2].args[0]

    with pytest.raises(ValueError, match="mismatch"):
        asyncio.run(store.save_tracking(tenant, uuid4(), document))


def test_explicit_secret_keys_and_uuid_references():
    from app.commerce_action_engine.platform.tracking import redact_tracking

    ident = str(uuid4())
    result = redact_tracking(
        {
            "api_key": "plain-secret",
            "password": "plain-password",
            "request_id": ident,
            "content": "test@example.com Bearer credential",
        }
    )
    assert result["api_key"] == "[redacted]" and result["password"] == "[redacted]"
    assert result["request_id"] == ident
    assert (
        "credential" not in result["content"]
        and "test@example.com" not in result["content"]
    )


def test_capture_switch_requires_write_scope_and_persists(identity, tmp_path):
    from dataclasses import replace

    from app.commerce_action_engine.platform import tracking_control

    config, _, headers = identity
    config = replace(config, provider_settings_file=str(tmp_path / "provider.json"))
    read = headers(scope="tracking_read", sub=None, sid=None)
    write = headers(scope="provider_settings_write", sub=None, sid=None)
    path = "/v1/provider-settings/tracking"
    with client_for(config, SimpleNamespace()) as client:
        assert client.get(path, headers=read).json()["enabled"] is True
        assert (
            client.post(path, headers=read, json={"enabled": False}).status_code == 401
        )
        assert (
            client.post(
                path,
                headers=headers(scope="provider_settings_write"),
                json={"enabled": False},
            ).status_code
            == 403
        )
        assert (
            client.post(path, headers=write, json={"enabled": "false"}).status_code
            == 422
        )
        assert (
            client.post(
                path, headers=write, json={"enabled": False, "path": "/tmp/other"}
            ).status_code
            == 422
        )
        assert (
            client.post(path, headers=write, json={"enabled": False}).json()["enabled"]
            is False
        )
    tracking_control._read.cache_clear()
    with client_for(config, SimpleNamespace()) as client:
        assert client.get(path, headers=read).json()["enabled"] is False
        assert (
            client.post(path, headers=write, json={"enabled": True}).json()["enabled"]
            is True
        )
    assert (tmp_path / "tracking.json").stat().st_mode & 0o777 == 0o600
    other = replace(config, tenant_id=str(uuid4()))
    assert tracking_control.status(other)["enabled"] is False
    assert tracking_control.status(other)["source"] == "unavailable"
    locked = replace(config, intent_tracking_enabled=False)
    assert tracking_control.status(locked)["enabled"] is False
    assert tracking_control.status(locked)["editable"] is False
    with client_for(locked, SimpleNamespace()) as client:
        assert (
            client.post(path, headers=write, json={"enabled": True}).status_code == 409
        )


def test_live_tracking_is_operator_only_and_tenant_scoped(identity):
    from app.commerce_action_engine.platform.live_tracking import feed

    config, request_id, headers = identity
    with client_for(config, SimpleNamespace()) as client:
        for auth in [
            {},
            headers(),
            headers(scope="tracking_read"),
            headers(scope="tracking_read", tenant=str(uuid4()), sub=None, sid=None),
        ]:
            assert client.get("/v1/tracking/live", headers=auth).status_code in [
                401,
                403,
            ]
        auth = headers(scope="tracking_read", sub=None, sid=None)
        first = client.get("/v1/tracking/live", headers=auth).json()
        feed.publish(config.tenant_id, request_id, "finished", {"truncated": False})
        result = client.get(
            "/v1/tracking/live", params={"cursor": first["cursor"]}, headers=auth
        ).json()
        assert result["events"][0]["request_id"] == request_id
        assert result["capture_enabled"] is True
        assert (
            client.get("/v1/tracking/live?cursor=bad", headers=auth).status_code == 422
        )
