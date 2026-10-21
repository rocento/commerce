"""Disposable PostgreSQL lifecycle for reviewed intent examples; no production DSN."""

import asyncio
import hashlib
import os
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from test_intent_example_reviews import reviewed
from test_intent_examples import COLLECTION, INTENT_SOURCE
from test_knowledge import VECTOR, WHO, WRITER, Embeddings

from app.commerce_knowledge_rag import KnowledgeError
from app.commerce_knowledge_rag.intent_examples import ingest_intent_examples
from app.commerce_knowledge_rag.store import PostgresKnowledgeIndex

DSN = os.getenv("M04_TEST_DATABASE_URL", "")
pytestmark = pytest.mark.skipif(not DSN, reason="Disposable pgvector database required")


@pytest.mark.parametrize("mode", ["legacy", "recovery"])
def test_reviewed_publication_conflicts_filters_rollback_and_model_guard(mode):
    if mode == "recovery" and not os.getenv("M05_TEST_LANGUAGE_URL"):
        pytest.skip("Local Node HTTP server required")

    async def run():
        name = "english_examples_" + uuid4().hex
        async with await psycopg.AsyncConnection.connect(DSN, autocommit=True) as admin:
            await admin.execute(
                psycopg.sql.SQL("CREATE DATABASE {}").format(
                    psycopg.sql.Identifier(name)
                )
            )
        settings = {**conninfo_to_dict(DSN), "dbname": name}
        pool = None
        try:
            async with await psycopg.AsyncConnection.connect(
                make_conninfo(**settings), autocommit=True
            ) as admin:
                await admin.execute(
                    "DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='ai_runtime') THEN CREATE ROLE ai_runtime; END IF; END $$"
                )
                await admin.execute(
                    "ALTER ROLE ai_runtime LOGIN PASSWORD 'runtime-test-only'"
                )
                migrations = Path(__file__).resolve().parents[1] / "migrations"
                for filename in [
                    "001_ai_store.sql",
                    "002_deployment_boundary.sql",
                    "003_knowledge.sql",
                ]:
                    await admin.execute(
                        (migrations / filename)
                        .read_text()
                        .replace(":'tenant_id'::uuid", f"'{WHO.tenant}'::uuid")
                    )
                await admin.execute(
                    "ALTER ROLE ai_knowledge_writer LOGIN PASSWORD 'english-test-only'"
                )
            pool = AsyncConnectionPool(
                make_conninfo(
                    **{
                        **settings,
                        "user": "ai_knowledge_writer",
                        "password": "english-test-only",
                    }
                ),
                open=False,
                min_size=0,
                max_size=2,
                kwargs={"row_factory": dict_row},
            )
            await pool.open()
            index = PostgresKnowledgeIndex(pool)
            embedder = Embeddings()
            if mode == "recovery":
                await recovery_roundtrip(index, settings)
                return

            async def validate(example):
                return hashlib.sha256(example.canonical_text.encode()).hexdigest()

            async def publish(source, examples, emb=embedder):
                return await ingest_intent_examples(
                    source, examples, WRITER, emb, index, validate, COLLECTION
                )

            async def hits(model=embedder.model):
                return await index.search(
                    WHO,
                    frozenset({COLLECTION}),
                    VECTOR,
                    model,
                    "en",
                    frozenset({"imported"}),
                )

            first = reviewed()
            assert await publish(INTENT_SOURCE, [first])
            count = embedder.calls
            assert not await publish(INTENT_SOURCE, [first])
            assert embedder.calls == count
            other = INTENT_SOURCE.model_copy(update={"id": uuid4()})
            with pytest.raises(KnowledgeError, match="duplicate_source"):
                await publish(other, [first.model_copy(update={"id": "duplicate"})])
            assert embedder.calls == count
            with pytest.raises(KnowledgeError, match="label_conflict"):
                await publish(
                    other,
                    [
                        first.model_copy(
                            update={"id": "conflict", "intent": "CART_TOTAL"}
                        )
                    ],
                )
            assert embedder.calls == count
            negative = first.model_copy(
                update={
                    "id": "negative",
                    "utterance": "do not add milk",
                    "canonical_text": "do not add milk",
                    "intent": "ADD_TO_CART",
                    "review": first.review.model_copy(
                        update={
                            "label": "negative",
                            "expected_status": "UNKNOWN",
                            "family": "negated-add",
                        }
                    ),
                }
            )
            contextual = first.model_copy(
                update={
                    "id": "contextual",
                    "utterance": "same basket please",
                    "review": first.review.model_copy(
                        update={
                            "context_requirements": ["CART_VISIBLE"],
                            "family": "cart-context",
                        }
                    ),
                }
            )
            reserved = first.model_copy(
                update={
                    "id": "reserved",
                    "utterance": "let me inspect the basket",
                    "review": first.review.model_copy(
                        update={"split": "test", "family": "cart-heldout"}
                    ),
                }
            )
            revision = INTENT_SOURCE.model_copy(update={"revision": 2})
            assert await publish(revision, [first, negative, contextual, reserved])
            assert (
                len(await hits()) == 1
            )  # Nonrecovery records are filtered before ranking.
            assert (await hits())[0].source.revision == 2
            changed = first.model_copy(
                update={"canonical_text": "show my wishlist", "intent": "VIEW_WISHLIST"}
            )
            assert await publish(
                INTENT_SOURCE.model_copy(update={"revision": 3}), [changed]
            )
            assert await publish(
                INTENT_SOURCE.model_copy(update={"revision": 4}), [first]
            )  # Forward revision rollback.
            assert (await hits())[0].source.revision == 4

            class OtherModel(Embeddings):
                model = "different-model"

            with pytest.raises(KnowledgeError, match="migration_required"):
                await publish(
                    INTENT_SOURCE.model_copy(update={"revision": 5}),
                    [first],
                    OtherModel(),
                )
            assert (await hits())[0].source.revision == 4
            assert not await hits("different-model")
            assert not await index.search(
                WHO.model_copy(update={"tenant": uuid4()}),
                frozenset({COLLECTION}),
                VECTOR,
                embedder.model,
                "en",
                frozenset({"imported"}),
            )
            # Concurrent publications of a new normalized utterance cannot both win.
            race = first.model_copy(
                update={"id": "race", "utterance": "please inspect my basket"}
            )
            results = await asyncio.gather(
                publish(other, [race]),
                publish(
                    other.model_copy(update={"id": uuid4()}),
                    [race.model_copy(update={"id": "race-other"})],
                ),
                return_exceptions=True,
            )
            assert sum(result is True for result in results) == 1
            assert sum(isinstance(result, KnowledgeError) for result in results) == 1
        finally:
            if pool:
                await pool.close()
            async with await psycopg.AsyncConnection.connect(
                DSN, autocommit=True
            ) as admin:
                await admin.execute(
                    psycopg.sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                        psycopg.sql.Identifier(name)
                    )
                )

    asyncio.run(run())


async def recovery_roundtrip(writer_index, settings):
    """Real publication, runtime-role pgvector retrieval and Node HTTP acceptance."""
    import json

    from test_enterprise_contracts import context as test_context
    from test_knowledge import AGENT

    from app.commerce_action_engine.adapters.intent_examples import (
        LanguageExampleValidator,
    )
    from app.commerce_action_engine.application.interpretation import (
        interpret_resolution,
    )
    from app.commerce_action_engine.application.semantic_recovery import (
        recover_read,
        retrieve_examples,
    )
    from app.commerce_action_engine.execution.language import gate
    from app.commerce_contracts.intent_example import IntentExample
    from app.commerce_knowledge_rag import Retriever
    from app.commerce_knowledge_rag.intent_examples import IntentExampleRetriever

    url = os.environ["M05_TEST_LANGUAGE_URL"]
    context = test_context.__wrapped__()
    validator = LanguageExampleValidator(url, context.actor)
    path = (
        Path(__file__).resolve().parents[1]
        / "knowledge/intent-examples.recovery-v1.en.json"
    )
    examples = [IntentExample.model_validate(e) for e in json.loads(path.read_text())]
    embedder = Embeddings()
    assert await ingest_intent_examples(
        INTENT_SOURCE, examples, WRITER, embedder, writer_index, validator, COLLECTION
    )
    assert not await ingest_intent_examples(
        INTENT_SOURCE, examples, WRITER, embedder, writer_index, validator, COLLECTION
    )
    runtime = AsyncConnectionPool(
        make_conninfo(
            **{**settings, "user": "ai_runtime", "password": "runtime-test-only"}
        ),
        open=False,
        min_size=0,
        max_size=2,
        kwargs={"row_factory": dict_row},
    )
    await runtime.open()
    try:
        reader = IntentExampleRetriever(
            Retriever(embedder, PostgresKnowledgeIndex(runtime)),
            AGENT,
            WHO,
            COLLECTION,
            validator,
        )
        for message, quantity, product in [
            ("could ya rustle up four oranges under 75 EGP", 4, "oranges"),
            ("i am hunting for three apples up to 240 EGP", 3, "apples"),
        ]:
            original = interpret_resolution(await gate.resolve(url, message), context)
            assert original.allows_fallback
            before = embedder.calls
            retrieved = await retrieve_examples(reader.retrieve, message, 3)
            assert len(retrieved.evidence) == 2
            assert embedder.calls == before + 1
            decision = await recover_read(
                url, original, message, retrieved.evidence, context=context, timeout=3
            )
            assert decision.route == "search"
            assert decision.result.entities["quantity"] == quantity
            assert decision.result.entities["productText"] == product
            assert all(e.source_id == INTENT_SOURCE.id for e in retrieved.evidence)
        foreign_tenant = uuid4()
        foreign = IntentExampleRetriever(
            Retriever(embedder, PostgresKnowledgeIndex(runtime)),
            AGENT.model_copy(update={"tenant": foreign_tenant}),
            WHO.model_copy(update={"tenant": foreign_tenant}),
            COLLECTION,
            validator,
        )
        assert not await foreign.retrieve("could ya rustle up milk")
    finally:
        await runtime.close()
