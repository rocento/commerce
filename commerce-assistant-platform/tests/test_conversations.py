"""M09 real database ownership, typed-message persistence, feedback and context limits."""

import asyncio
import os
from pathlib import Path
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from app.commerce_action_engine.contracts import AssistantUsage
from app.commerce_action_engine.platform.store import Store, scrub


def test_scrub_preserves_typed_routes_but_redacts_contact_text():
    value = scrub(
        {
            "route": "/products/00000000-0000-0000-0000-000000000009",
            "text": "Email user@example.test password=secret",
        }
    )
    assert value["route"].endswith("000000000009")
    assert "user@example.test" not in value["text"] and "secret" not in value["text"]


@pytest.mark.skipif(
    not os.getenv("M09_TEST_DATABASE_URL"),
    reason="M09 isolated database not configured",
)
def test_persistence_owner_tenant_feedback_usage_and_bounds():
    async def run():
        dsn = os.environ["M09_TEST_DATABASE_URL"]
        database = "m09_" + uuid4().hex
        async with await psycopg.AsyncConnection.connect(dsn, autocommit=True) as admin:
            await admin.execute(
                psycopg.sql.SQL("CREATE DATABASE {}").format(
                    psycopg.sql.Identifier(database)
                )
            )
            await admin.execute(
                "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_runtime') THEN CREATE ROLE ai_runtime LOGIN PASSWORD 'runtime-test-only'; END IF; END $$"
            )
        settings = {**conninfo_to_dict(dsn), "dbname": database}
        async with await psycopg.AsyncConnection.connect(
            make_conninfo(**settings), autocommit=True
        ) as admin:
            root = Path(__file__).resolve().parents[1] / "migrations"
            await admin.execute((root / "001_ai_store.sql").read_text())
            await admin.execute(
                (root / "002_deployment_boundary.sql")
                .read_text()
                .replace(":'tenant_id'::uuid", f"'{UUID(int=1)}'::uuid")
            )
            await admin.execute((root / "004_conversations.sql").read_text())
            await admin.execute((root / "004_conversations.sql").read_text())
            await admin.execute((root / "005_performance_indexes.sql").read_text())
            await admin.execute((root / "005_performance_indexes.sql").read_text())
            indexes = await (
                await admin.execute(
                    "SELECT count(*) FROM pg_indexes WHERE schemaname='assistant' AND indexname IN ('assistant_turns_conversation_time','assistant_conversations_retention','assistant_metrics_window','assistant_metrics_export_pending')"
                )
            ).fetchone()
            assert indexes[0] == 4

        store = object.__new__(Store)
        store.pool = AsyncConnectionPool(
            make_conninfo(
                **{**settings, "user": "ai_runtime", "password": "runtime-test-only"}
            ),
            open=False,
            min_size=0,
            max_size=2,
            kwargs={"row_factory": dict_row},
        )
        await store.open()
        tenant, customer, conversation, request = UUID(int=1), uuid4(), uuid4(), uuid4()
        blocks = [{"kind": "text", "text": "Contact user@example.test"}]
        meta = {
            "provider": "fixture",
            "model": "neutral-model",
            "input_tokens": 11,
            "output_tokens": 7,
            "tool_calls": 2,
            "retrieval_count": 1,
            "model_calls": 1,
            "route_reason": "catalog_model",
            "estimated_cost_micros": 3,
        }
        try:
            await store.save(
                tenant,
                customer,
                conversation,
                request,
                "Question",
                "Answer",
                blocks,
                meta,
            )
            await store.metric(tenant, request, "completed", 120, meta, conversation)
            await store.close()
            store.pool = AsyncConnectionPool(
                make_conninfo(
                    **{
                        **settings,
                        "user": "ai_runtime",
                        "password": "runtime-test-only",
                    }
                ),
                open=False,
                min_size=0,
                max_size=2,
                kwargs={"row_factory": dict_row},
            )
            await store.open()
            rows = await store.history(tenant, customer, conversation)
            assert (
                len(rows) == 1
                and rows[0]["blocks"][0]["text"] == "Contact [contact redacted]"
            )
            assert await store.history(tenant, uuid4()) == []
            assert await store.history(UUID(int=999), customer) == []
            assert not await store.feedback(tenant, uuid4(), request, True)
            assert await store.feedback(tenant, customer, request, True)
            assert await store.feedback(tenant, customer, request, False)
            assert (await store.history(tenant, customer, conversation))[0][
                "helpful"
            ] is False
            metrics = await store.insights(tenant)
            AssistantUsage.model_validate(metrics)
            assert (
                metrics["estimated_cost_micros"] == 3 and metrics["cost_recorded"] == 1
            )
            assert metrics["model_calls"] == 1
            assert metrics["routes"] == [{"route": "catalog_model", "turns": 1}]
            assert (
                metrics["turns"] == 1
                and metrics["not_helpful"] == 1
                and metrics["helpful"] == 0
            )
            assert (
                metrics["input_tokens"] == 11
                and metrics["models"][0]["provider"] == "fixture"
            )
            await store.save(
                tenant,
                customer,
                conversation,
                request,
                "duplicate",
                "not inserted",
                [],
                {},
            )
            assert len(await store.history(tenant, customer)) == 1
            with pytest.raises(ValueError):
                await store.save(tenant, customer, uuid4(), request, "bad", "bad")
            for _ in range(29):
                await store.save(
                    tenant, customer, conversation, uuid4(), "q" * 4000, "a" * 8000
                )
            context = await store.context(tenant, customer, conversation)
            assert len(context) == 6 and sum(len(m["text"]) for m in context) == 6000
            with pytest.raises(ValueError):
                await store.save(
                    tenant, customer, conversation, uuid4(), "too many", "no"
                )
            async with store.pool.connection() as c, c.transaction():
                await c.execute(
                    "SELECT set_config('assistant.tenant',%s,true),set_config('assistant.customer',%s,true)",
                    (str(tenant), str(customer)),
                )
                count = await (
                    await c.execute("SELECT count(*) AS n FROM assistant.messages")
                ).fetchone()
                assert count["n"] == 60
        finally:
            await store.close()
            async with await psycopg.AsyncConnection.connect(
                dsn, autocommit=True
            ) as admin:
                await admin.execute(
                    psycopg.sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                        psycopg.sql.Identifier(database)
                    )
                )

    asyncio.run(run())


def test_usage_accounts_for_extraction_and_response_without_provider_objects():
    from app.commerce_resolution_engine.contracts import (
        Message,
        ModelEvent,
        ModelRequest,
        ModelResponse,
        Usage,
    )
    from app.commerce_resolution_engine.providers.usage import UsageProvider

    class Provider:
        async def generate(self, request):
            return ModelResponse("intent", (), None, Usage(2, 3, 5), "fixture", "stop")

        async def stream(self, request):
            yield ModelEvent("text_delta", text="answer")
            yield ModelEvent(
                "completed",
                response=ModelResponse(
                    "answer", (), None, Usage(5, 7, 12), "fixture", "stop"
                ),
            )

        async def aclose(self):
            pass

    async def run():
        p = UsageProvider(Provider())
        r = ModelRequest((Message("user", "question"),))
        await p.generate(r)
        assert len([e async for e in p.stream(r)]) == 2
        assert (p.input_tokens, p.output_tokens, p.calls) == (7, 10, 2)
        assert not hasattr(p, "messages")

    asyncio.run(run())
