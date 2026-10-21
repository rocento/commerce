from pathlib import Path

import pytest
from psycopg.conninfo import conninfo_to_dict

from app.commerce_action_engine.platform.settings import Settings
from app.commerce_action_engine.platform.store import Store


@pytest.mark.parametrize("store", ["grocery", "jewelry", "electronics", "pharmacy"])
def test_shared_store_configuration_is_ai_only(monkeypatch, tmp_path: Path, store):
    monkeypatch.setenv("AI_STORE_HOST", "shared-ai-postgres")
    monkeypatch.setenv("AI_STORE_USER", f"ai_runtime_{store}")
    config = Settings.environment()
    password = tmp_path / "password"
    password.write_text("test-only")
    adapter = Store(str(password), host=config.store_host, user=config.store_user)
    actual = conninfo_to_dict(adapter.pool.conninfo)
    assert actual["host"] == "shared-ai-postgres"
    assert actual["user"] == f"ai_runtime_{store}"
    assert actual["dbname"] == "assistant"
    assert actual["password"] == "test-only"


@pytest.mark.parametrize(
    "key,value",
    [
        ("AI_STORE_HOST", "postgres"),
        ("AI_STORE_HOST", "external.example"),
        ("AI_STORE_USER", "ai_owner"),
        ("AI_STORE_USER", "commerce"),
    ],
)
def test_shared_store_rejects_commerce_or_owner_credentials(monkeypatch, key, value):
    monkeypatch.setenv(key, value)
    with pytest.raises(ValueError):
        Settings.environment()
