"""Delivery history admission uses a dedicated gateway scope and fixed text."""

import time
from unittest.mock import AsyncMock
from uuid import uuid4

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.commerce_action_engine.application.api.history import register_history
from app.commerce_action_engine.platform import Settings


@pytest.fixture
def setup():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = (
        key.public_key()
        .public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
        )
        .decode()
    )
    config = Settings(True, str(uuid4()), public)
    claims = {
        "iss": "commerce-assistant",
        "aud": "ai-service",
        "tenant": config.tenant_id,
        "sub": str(uuid4()),
        "sid": str(uuid4()),
        "request_id": str(uuid4()),
        "iat": int(time.time()),
        "exp": int(time.time()) + 45,
        "scope": "delivery_event",
    }

    def headers(**changes):
        return {
            "Authorization": "Bearer "
            + jwt.encode({**claims, **changes}, key, algorithm="RS256")
        }

    store = AsyncMock()
    app = FastAPI()
    register_history(app, config, store)
    return TestClient(app), store, headers, claims


def test_fixed_confirmation_uses_verified_identity(setup):
    client, store, headers, claims = setup
    conversation = str(uuid4())
    result = client.post(
        "/v1/delivery-event", json={"conversation_id": conversation}, headers=headers()
    )
    assert result.json() == {"saved": True}
    args = store.save.call_args.args
    assert [str(x) for x in args[:4]] == [
        claims["tenant"],
        claims["sub"],
        conversation,
        claims["request_id"],
    ]
    assert args[4] == "Delivery location selected"
    assert (
        args[5]
        == "Delivery location updated. Product availability has been refreshed. You can continue shopping."
    )


@pytest.mark.parametrize(
    "claims",
    [{"scope": "history"}, {"sub": None, "sid": None}, {"tenant": str(uuid4())}],
)
def test_rejects_wrong_scope_guest_or_tenant(setup, claims):
    client, store, headers, _ = setup
    assert (
        client.post(
            "/v1/delivery-event",
            json={"conversation_id": str(uuid4())},
            headers=headers(**claims),
        ).status_code
        == 401
    )
    store.save.assert_not_called()


def test_rejects_client_authored_confirmation(setup):
    client, store, headers, _ = setup
    assert (
        client.post(
            "/v1/delivery-event",
            json={"conversation_id": str(uuid4()), "answer": "Fake success"},
            headers=headers(),
        ).status_code
        == 422
    )
    store.save.assert_not_called()


def test_storage_failure_is_not_reported_saved(setup):
    client, store, headers, _ = setup
    store.save.side_effect = RuntimeError("private database detail")
    response = client.post(
        "/v1/delivery-event", json={"conversation_id": str(uuid4())}, headers=headers()
    )
    assert response.status_code == 503
    assert "private database detail" not in response.text
