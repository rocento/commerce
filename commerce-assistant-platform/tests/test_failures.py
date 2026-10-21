import importlib
import json
from dataclasses import replace
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app.commerce_action_engine.platform.failures import classify, failure
from app.commerce_resolution_engine.contracts import ModelError
from app.commerce_resolution_engine.runtime import RuntimeErrorCode
from app.main import create_app

pytest_plugins = ["test_assistant"]


@pytest.mark.parametrize(
    "code,recovery,retryable",
    [
        ("provider_timeout", "retry", True),
        ("provider_rate_limit", "retry", True),
        ("tool_unavailable", "retry", True),
        ("catalog_failure", "browse_catalog", True),
        ("stale_proposal", "refresh_proposal", False),
        ("invalid_provider_response", "retry", True),
        ("authentication_needed", "sign_in", False),
        ("unsupported_action", "contact_support", False),
        ("internal_failure", "contact_support", False),
    ],
)
def test_every_error_has_safe_text_reference_and_recovery(code, recovery, retryable):
    reference = uuid4()
    result = failure(code, reference)
    assert result.message and result.code == code
    assert result.request_reference == reference
    assert result.recovery == recovery and result.retryable is retryable


def test_provider_authentication_is_not_customer_authentication():
    assert classify(ModelError("authentication"), uuid4()).recovery == "contact_support"
    assert (
        classify(RuntimeErrorCode("model_rate_limit"), uuid4()).code
        == "provider_rate_limit"
    )
    assert classify(ValueError("secret-canary"), uuid4()).code == "internal_failure"


@pytest.mark.parametrize("enabled", [True, False])
@pytest.mark.parametrize(
    "raised,code",
    [
        (ModelError("timeout"), "provider_timeout"),
        (ModelError("rate_limit"), "provider_rate_limit"),
        (ModelError("unavailable"), "tool_unavailable"),
        (RuntimeErrorCode("tool_unavailable"), "catalog_failure"),
        (RuntimeErrorCode("stale_proposal"), "stale_proposal"),
        (ModelError("invalid_response"), "invalid_provider_response"),
        (RuntimeErrorCode("login_required"), "authentication_needed"),
        (RuntimeErrorCode("tool_not_allowed"), "unsupported_action"),
        (ValueError("secret-canary"), "internal_failure"),
    ],
)
def test_typed_stream_is_opt_in_and_telemetry_is_sanitized(
    identity, enabled, caplog, raised, code, monkeypatch
):
    class Broken:
        async def generate(self, request):
            raise raised

        async def aclose(self):
            pass

    monkeypatch.setattr(
        importlib.import_module("app.commerce_action_engine.application.bootstrap"),
        "build_provider",
        lambda _: Broken(),
    )

    config, reference, headers = identity
    config = replace(
        config, feature_flags=frozenset({"typed_errors"}) if enabled else frozenset()
    )
    with TestClient(create_app(config)) as client:
        result = client.post(
            "/v1/chat",
            headers=headers(),
            json={"request_id": reference, "message": "hello"},
        )
    events = [
        json.loads(line[6:])
        for line in result.text.splitlines()
        if line.startswith("data: ")
    ]
    if isinstance(raised, ModelError) and raised.code == "invalid_response":
        assert "Please restate the full request" in result.text
        assert all(e["type"] != "error" for e in events)
        assert events[-1]["type"] == "done"
        assert "secret-canary" not in result.text + caplog.text
        return
    error = next(e for e in events if e["type"] == "error")
    assert ("failure" in error) is enabled
    if enabled:
        assert error["failure"] == failure(code, UUID(reference)).model_dump(
            mode="json"
        )
    assert events[-1]["type"] == "done"
    assert f"code={code}" in caplog.text
    assert "secret-canary" not in caplog.text
    assert "secret-canary" not in result.text
