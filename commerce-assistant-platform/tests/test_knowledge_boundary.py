"""Knowledge loads independently and consumes caller-owned validation/storage."""

import asyncio
import importlib
import subprocess
import sys
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import pytest
from test_intent_examples import COLLECTION, EXAMPLE, INTENT_SOURCE, record
from test_knowledge import AGENT, WHO, WRITER, Embeddings, Index, hit

from app.commerce_knowledge_rag import KnowledgeError, PostgresKnowledgeIndex, Retriever
from app.commerce_knowledge_rag.intent_examples import (
    IntentExampleRetriever,
    ingest_intent_examples,
)


def test_all_knowledge_modules_import_without_loading_commerce_engines():
    subprocess.run(
        [
            sys.executable,
            "-c",
            """
import importlib, pkgutil, sys
import app.commerce_knowledge_rag as knowledge
for module in pkgutil.walk_packages(knowledge.__path__, knowledge.__name__ + '.'):
    importlib.import_module(module.name)
for name in sys.modules:
    assert not name.startswith((
        'app.commerce_action_engine', 'app.commerce_resolution_engine',
        'app.commerce_orchestration_engine', 'httpx', 'fastapi'
    )), name
""",
        ],
        check=True,
    )


def test_write_examples_are_rejected_before_calling_injected_validator():
    validator = AsyncMock(return_value="a" * 64)
    index, embedder = Index(), Embeddings()
    with pytest.raises(KnowledgeError, match="incompatible_intent_example"):
        asyncio.run(
            ingest_intent_examples(
                INTENT_SOURCE,
                [EXAMPLE.model_copy(update={"intent": "CLEAR_CART"})],
                WRITER,
                embedder,
                index,
                validator,
                COLLECTION,
            )
        )
    validator.assert_not_awaited()
    assert not index.writes and embedder.calls == 0


def test_injected_validation_supports_publication_and_rejects_stale_evidence():
    async def scenario():
        validator = AsyncMock(return_value="a" * 64)
        index = Index()
        assert await ingest_intent_examples(
            INTENT_SOURCE, [EXAMPLE], WRITER, Embeddings(), index, validator, COLLECTION
        )
        source, _, chunks, _, _ = index.writes[0]
        index.hits = [hit(chunks[0].text, source=source)]
        retriever = IntentExampleRetriever(
            Retriever(Embeddings(), index), AGENT, WHO, COLLECTION, validator
        )
        evidence = await retriever.retrieve(EXAMPLE.utterance)
        assert len(evidence) == 1 and evidence[0].example == EXAMPLE
        validator.return_value = "b" * 64
        assert await retriever.retrieve(EXAMPLE.utterance) == ()
        validator.return_value = None
        assert await retriever.retrieve(EXAMPLE.utterance) == ()

    asyncio.run(scenario())


def test_cancelled_retrieval_closes_injected_validation():
    async def scenario():
        started, stopped = asyncio.Event(), asyncio.Event()

        async def validator(example):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()

        retriever = IntentExampleRetriever(
            Retriever(Embeddings(), Index([hit(record(), source=INTENT_SOURCE)])),
            AGENT,
            WHO,
            COLLECTION,
            validator,
        )
        task = asyncio.create_task(retriever.retrieve(EXAMPLE.utterance))
        await asyncio.wait_for(started.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert stopped.is_set()

    asyncio.run(scenario())


def test_index_uses_injected_pool_and_releases_it_when_database_fails():
    events = []

    class Connection:
        @asynccontextmanager
        async def transaction(self):
            events.append("begin")
            try:
                yield
            finally:
                events.append("end")

        async def execute(self, sql, params):
            if "set_config" in sql:
                assert params == (str(WHO.tenant),)
                events.append("tenant")
                return
            raise RuntimeError("database unavailable")

    class Pool:
        @asynccontextmanager
        async def connection(self):
            events.append("acquire")
            try:
                yield Connection()
            finally:
                events.append("release")

    index = PostgresKnowledgeIndex(Pool())
    with pytest.raises(RuntimeError, match="database unavailable"):
        asyncio.run(index.delete(WHO.tenant, INTENT_SOURCE.id))
    assert events == ["acquire", "begin", "tenant", "end", "release"]


def test_operator_entrypoint_uses_application_composition():
    entrypoint = importlib.import_module("app.knowledge_cli")
    application = importlib.import_module(
        "app.commerce_action_engine.application.knowledge_cli"
    )
    assert entrypoint.main is application.main
