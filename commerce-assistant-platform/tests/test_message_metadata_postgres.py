"""Real database regression for the production retrieval/history size failure."""

import asyncio
import json
import os
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from app.commerce_action_engine.platform.completion import completion_metadata
from app.commerce_action_engine.platform.store import Store

DSN = os.environ.get("COMPLETION_TEST_DSN")
ADMIN_DSN = os.environ.get("COMPLETION_TEST_ADMIN_DSN")
pytestmark = pytest.mark.skipif(
    not DSN or not ADMIN_DSN, reason="isolated PostgreSQL test DSNs required"
)


def test_model_reply_with_retrieval_diagnostics_saves_history_and_full_metrics():
    async def run():
        tenant, customer, conversation, request = UUID(int=1), uuid4(), uuid4(), uuid4()
        metadata = {
            "response_source": "L",
            "model_calls": 1,
            "language_gate": {"status": "RESOLVED", "intent": "CONVERSATION_HELP"},
            "route_reason": "agent_conversation",
            "completion_evidence": "conversation_reply",
            "intent_retrieval": {
                "status": "retrieved",
                "count": 3,
                "sources": [
                    {
                        "source_id": str(uuid4()),
                        "chunk_id": "a" * 64,
                        "example_id": name,
                        "revision": 1,
                    }
                    for name in ("cart-peek", "wishlist-peek", "cart-total")
                ],
            },
            "core": {
                "versions": [
                    {
                        "id": "policy://commerce/authority",
                        "version": "1.0.0",
                        "schema_major": 1,
                        "schema_version": "1.0",
                    }
                ]
                * 12
            },
            "input_tokens": 1971,
            "output_tokens": 20,
        }
        metadata.update(completion_metadata(metadata, outcome="completed"))
        assert len(json.dumps(metadata).encode()) > 2048
        store = object.__new__(Store)
        store.pool = AsyncConnectionPool(
            DSN, open=False, kwargs={"row_factory": dict_row}
        )
        await store.open()
        try:
            question = "Added 1 banana to your cart and saved it to your wishlist"
            answer = "I can help you find products and manage your cart."
            await store.save(
                tenant, customer, conversation, request, question, answer, [], metadata
            )
            await store.metric(
                tenant, request, "completed", 10, metadata, conversation, customer
            )
            history = await store.history(tenant, customer, conversation)
            assert len(history) == 1 and history[0]["answer"] == answer
            assert history[0]["response_source"] == "L"
            context = await store.completion_context(
                tenant, customer, conversation, expected_question=question
            )
            assert context["completion"]["status"] == "completed"
            async with await psycopg.AsyncConnection.connect(ADMIN_DSN) as admin:
                rows = await (
                    await admin.execute(
                        "SELECT metadata,octet_length(metadata::text) FROM assistant.messages WHERE request_id=%s",
                        (request,),
                    )
                ).fetchall()
                assert len(rows) == 2
                for saved, size in rows:
                    assert (
                        size <= 2048 and saved["completion"] == metadata["completion"]
                    )
                    assert "intent_retrieval" not in saved and "core" not in saved
                metric = await (
                    await admin.execute(
                        "SELECT metadata FROM assistant.metrics WHERE request_id=%s",
                        (request,),
                    )
                ).fetchone()
                assert metric[0] == metadata
        finally:
            await store.close()
            async with await psycopg.AsyncConnection.connect(ADMIN_DSN) as admin:
                await admin.execute(
                    "DELETE FROM assistant.conversations WHERE customer_id=%s",
                    (customer,),
                )
                await admin.execute(
                    "DELETE FROM assistant.metrics WHERE request_id=%s", (request,)
                )

    asyncio.run(run())
