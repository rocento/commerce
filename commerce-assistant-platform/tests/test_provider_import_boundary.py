"""Provider protocols and HTTP transport do not initialize the commerce application."""

import importlib
import subprocess
import sys

import pytest


@pytest.mark.parametrize(
    "statement",
    [
        "import app.commerce_resolution_engine.providers",
        "import app.commerce_resolution_engine.acceptance",
        "import app.commerce_resolution_engine.shopping",
        "import app.commerce_resolution_engine.basket",
        "import app.commerce_resolution_engine.adapter",
        "import app.commerce_resolution_engine.language",
        "import app.commerce_contracts.language_proposal",
        "import app.commerce_resolution_engine.providers.chat",
        "import app.commerce_resolution_engine.providers.openai",
        "import app.commerce_resolution_engine.providers.config",
        "import app.commerce_resolution_engine.providers.factory",
        "import app.commerce_resolution_engine.providers.settings",
        "import app.commerce_resolution_engine.providers.usage",
        "import app.commerce_resolution_engine.providers.embeddings",
        "import app.commerce_resolution_engine.providers.smoke",
        "from app.commerce_resolution_engine.providers import ProviderConfig, ProviderSettings, StoredSettings, UsageProvider, CallBudget, build_provider, build_embedder",
        "import app.commerce_contracts.embeddings",
        "from app.commerce_resolution_engine.providers import EmbeddingModel, UnconfiguredModel, OpenAIProvider, strict_schema",
    ],
)
def test_provider_imports_do_not_load_commerce_or_persistence(statement):
    subprocess.run(
        [
            sys.executable,
            "-c",
            statement
            + "\nimport sys\n"
            + "for name in sys.modules:\n"
            + "    assert not name.startswith(('app.commerce_action_engine', "
            + "'app.commerce_resolution_engine.runtime', 'psycopg', 'pypdf')), name\n",
        ],
        check=True,
    )


def test_runtime_chat_compatibility_exports_are_retired():
    for name in (
        "app.commerce_resolution_engine.providers",
        "app.commerce_resolution_engine.providers.chat",
    ):
        module = importlib.import_module(name)
        assert not hasattr(module, "RuntimeChatModel")
        assert "RuntimeChatModel" not in module.__all__
        assert not hasattr(module, "ChatModel")
        assert "ChatModel" not in module.__all__
