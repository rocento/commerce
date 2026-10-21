"""Operator composition preserves writer credentials, injection and cleanup."""

import asyncio
import json
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from test_intent_examples import COLLECTION, EXAMPLE, INTENT_SOURCE
from test_knowledge import WRITER, Embeddings, Index

from app.commerce_action_engine.application import knowledge_cli as cli
from app.commerce_knowledge_rag import KnowledgeError


@pytest.mark.parametrize("mode", ["document", "examples", "delete", "rejected"])
@pytest.mark.parametrize("shared", [False, True])
def test_operator_command_injects_dependencies_and_closes_resources(
    monkeypatch, tmp_path, capsys, mode, shared
):
    metadata = tmp_path / "source.json"
    metadata.write_text(INTENT_SOURCE.model_dump_json())
    document = tmp_path / (
        "examples.json" if mode in {"examples", "rejected"} else "guide.txt"
    )
    document.write_text(
        json.dumps([EXAMPLE.model_dump()])
        if mode in {"examples", "rejected"}
        else "Approved buying guidance."
    )
    args = ["app.knowledge_cli", str(metadata), "--actor", str(WRITER.subject)]
    if mode == "delete":
        args.append("--delete")
    else:
        args.extend(["--file", str(document)])
        if mode in {"examples", "rejected"}:
            args.append("--intent-examples")
    monkeypatch.setattr(sys, "argv", args)
    monkeypatch.setenv("AI_KNOWLEDGE_WRITER_KEY_FILE", str(tmp_path / "writer-key"))
    settings = SimpleNamespace(
        tenant_id=str(INTENT_SOURCE.tenant),
        language_engine_url="http://language",
        intent_example_collection=COLLECTION,
        store_host="shared-ai-postgres" if shared else "ai-postgres",
        store_user="ai_runtime_grocery" if shared else "ai_runtime",
    )
    monkeypatch.setattr(cli, "Settings", SimpleNamespace(environment=lambda: settings))
    pool = object()
    store = SimpleNamespace(pool=pool, open=AsyncMock(), close=AsyncMock())
    store_factory = Mock(return_value=store)
    monkeypatch.setattr(cli, "Store", store_factory)
    index = Index()
    index.delete = AsyncMock()
    index_factory = Mock(return_value=index)
    monkeypatch.setattr(cli, "PostgresKnowledgeIndex", index_factory)
    embedder = Embeddings()
    embedder.aclose = AsyncMock()
    build_embedder = Mock(return_value=embedder)
    monkeypatch.setattr(cli, "build_embedder", build_embedder)
    monkeypatch.setattr(
        cli, "ProviderConfig", SimpleNamespace(from_settings=lambda s: s)
    )
    validator = AsyncMock(return_value=None if mode == "rejected" else "a" * 64)
    validator_factory = Mock(return_value=validator)
    monkeypatch.setattr(cli, "LanguageExampleValidator", validator_factory)

    if mode == "rejected":
        with pytest.raises(KnowledgeError, match="incompatible_intent_example"):
            asyncio.run(cli.main())
        assert not index.writes and embedder.calls == 0
        assert not capsys.readouterr().out
    else:
        asyncio.run(cli.main())
        assert capsys.readouterr().out.strip() == (
            "Source withdrawn" if mode == "delete" else "Knowledge published"
        )
    store_factory.assert_called_once_with(
        str(tmp_path / "writer-key"),
        knowledge_writer=True,
        **(
            {"host": "shared-ai-postgres", "user": "ai_runtime_grocery"}
            if shared
            else {}
        ),
    )
    index_factory.assert_called_once_with(pool)
    store.open.assert_awaited_once()
    store.close.assert_awaited_once()
    if mode == "delete":
        index.delete.assert_awaited_once_with(INTENT_SOURCE.tenant, INTENT_SOURCE.id)
        build_embedder.assert_not_called()
        validator_factory.assert_not_called()
    else:
        build_embedder.assert_called_once_with(settings)
        embedder.aclose.assert_awaited_once()
        if mode != "rejected":
            assert index.writes[0][0].approved_by == WRITER.subject
        if mode in {"examples", "rejected"}:
            validator_factory.assert_called_once()
            engine_url, actor = validator_factory.call_args.args
            assert engine_url == "http://language"
            assert actor.tenant_id == actor.store_id == str(INTENT_SOURCE.tenant)
            assert actor.actor_id == actor.principal_id == str(WRITER.subject)
            assert actor.session_id == str(INTENT_SOURCE.id)
            assert actor.channel == "admin"
            assert actor.request_id
            validator.assert_awaited_once_with(EXAMPLE)
        else:
            validator_factory.assert_not_called()
