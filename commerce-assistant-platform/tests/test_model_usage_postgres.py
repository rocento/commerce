"""Real aggregation checks against a disposable database; no live telemetry is changed."""

import asyncio
import json
import os
from contextlib import asynccontextmanager
from types import SimpleNamespace
from uuid import uuid4

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from app.commerce_action_engine.contracts import AssistantUsage
from app.commerce_action_engine.platform.store import INTERNAL_MODEL_NAMES, Store

DSN = os.environ.get("M09_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not DSN, reason="isolated PostgreSQL admin DSN required"
)


async def aggregate(rows):
    """Own a new database and run the production Store queries, then remove it."""
    database = "model_usage_" + uuid4().hex
    async with await psycopg.AsyncConnection.connect(DSN, autocommit=True) as admin:
        await admin.execute(
            psycopg.sql.SQL("CREATE DATABASE {}").format(
                psycopg.sql.Identifier(database)
            )
        )
    tenant, conversation = uuid4(), uuid4()
    settings = {**conninfo_to_dict(DSN), "dbname": database}
    try:
        async with await psycopg.AsyncConnection.connect(
            make_conninfo(**settings), row_factory=dict_row
        ) as connection:
            await connection.execute("CREATE SCHEMA assistant")
            # Minimal production metrics shape; unrelated vector projections are unnecessary.
            await connection.execute(
                """CREATE TABLE assistant.metrics (
                    tenant_id uuid NOT NULL, request_id uuid NOT NULL,
                    outcome text NOT NULL, latency_ms integer NOT NULL,
                    metadata jsonb NOT NULL, conversation_id uuid, helpful boolean,
                    created_at timestamptz NOT NULL DEFAULT now(),
                    PRIMARY KEY(tenant_id,request_id))"""
            )
            for index, row in enumerate(rows):
                await connection.execute(
                    """INSERT INTO assistant.metrics
                       (tenant_id,request_id,outcome,latency_ms,metadata,conversation_id,helpful)
                       VALUES(%s,%s,%s,%s,%s,%s,%s)""",
                    (
                        tenant,
                        uuid4(),
                        row.get("outcome", "completed"),
                        row.get("latency_ms", 100),
                        Jsonb(row["metadata"]),
                        conversation if index < 2 else uuid4(),
                        row.get("helpful"),
                    ),
                )
            # Deliberately loud out-of-scope rows catch lost tenant/time predicates.
            noise = Jsonb(
                {"provider": "other", "model": "noise", "input_tokens": 99999}
            )
            await connection.execute(
                """INSERT INTO assistant.metrics
                   (tenant_id,request_id,outcome,latency_ms,metadata,created_at)
                   VALUES(%s,%s,'completed',1,%s,now()),
                         (%s,%s,'completed',1,%s,now()-interval '25 hours')""",
                (uuid4(), uuid4(), noise, tenant, uuid4(), noise),
            )

            @asynccontextmanager
            async def connected():
                yield connection

            store = object.__new__(Store)
            store.pool = SimpleNamespace(connection=connected)
            result = await store.insights(tenant)
            AssistantUsage.model_validate(result)
            persisted = await (
                await connection.execute(
                    "SELECT metadata FROM assistant.metrics WHERE tenant_id=%s AND created_at>now()-interval '24 hours'",
                    (tenant,),
                )
            ).fetchall()
            assert len(persisted) == len(rows)
            assert sorted(
                json.dumps(row["metadata"], sort_keys=True) for row in persisted
            ) == sorted(json.dumps(row["metadata"], sort_keys=True) for row in rows)
            return result
    finally:
        async with await psycopg.AsyncConnection.connect(DSN, autocommit=True) as admin:
            await admin.execute(
                psycopg.sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                    psycopg.sql.Identifier(database)
                )
            )


def test_internal_engine_is_excluded_from_model_totals_but_operational_activity_remains():
    result = asyncio.run(
        aggregate(
            [
                {
                    "outcome": "unavailable",
                    "latency_ms": 40,
                    "helpful": False,
                    "metadata": {
                        "provider": "openai",
                        "model": "commerce-language-engine",
                        "input_tokens": 200,
                        "output_tokens": 100,
                        "model_calls": 9,
                        "estimated_cost_micros": 999,
                        "tool_calls": 3,
                        "retrieval_count": 2,
                        "route_reason": "deterministic",
                    },
                },
                {
                    "latency_ms": 160,
                    "helpful": True,
                    "metadata": {
                        "provider": "openai",
                        "model": "actual-model",
                        "input_tokens": 11,
                        "output_tokens": 7,
                        "model_calls": 1,
                        "estimated_cost_micros": 3,
                        "tool_calls": 2,
                        "retrieval_count": 1,
                        "route_reason": "model_assisted",
                    },
                },
            ]
        )
    )
    assert {
        key: result[key]
        for key in (
            "turns",
            "conversations",
            "errors",
            "helpful",
            "not_helpful",
            "latency_ms",
            "tool_calls",
            "retrieval_count",
        )
    } == {
        "turns": 2,
        "conversations": 1,
        "errors": 1,
        "helpful": 1,
        "not_helpful": 1,
        "latency_ms": 100.0,
        "tool_calls": 5,
        "retrieval_count": 3,
    }
    assert {
        key: result[key]
        for key in (
            "input_tokens",
            "output_tokens",
            "model_calls",
            "estimated_cost_micros",
            "usage_recorded",
            "cost_recorded",
        )
    } == {
        "input_tokens": 11,
        "output_tokens": 7,
        "model_calls": 1,
        "estimated_cost_micros": 3,
        "usage_recorded": 1,
        "cost_recorded": 1,
    }
    assert result["models"] == [
        {
            "provider": "openai",
            "model": "actual-model",
            "input_tokens": 11,
            "output_tokens": 7,
            "turns": 1,
        }
    ]
    assert {route["route"] for route in result["routes"]} == {
        "deterministic",
        "model_assisted",
    }


@pytest.mark.parametrize("internal_model", INTERNAL_MODEL_NAMES)
def test_internal_only_legacy_and_current_rows_are_not_model_or_pricing_coverage(
    internal_model,
):
    legacy = {
        "provider": "openai",
        "model": internal_model,
        "input_tokens": 0,
        "output_tokens": 0,
        "estimated_cost_micros": 0,
        "tool_calls": 2,
        "route_reason": "deterministic",
    }
    result = asyncio.run(
        aggregate(
            [
                {"metadata": legacy},
                {"metadata": {**legacy, "model_calls": 0}},
            ]
        )
    )
    assert result["turns"] == 2 and result["conversations"] == 1
    assert result["tool_calls"] == 4
    assert result["models"] == []
    assert result["routes"] == [{"route": "deterministic", "turns": 2}]
    for key in (
        "input_tokens",
        "output_tokens",
        "model_calls",
        "estimated_cost_micros",
        "usage_recorded",
        "cost_recorded",
    ):
        assert result[key] == 0, key


def test_unknown_unpriced_multiple_and_zero_token_real_model_usage_remain_visible():
    result = asyncio.run(
        aggregate(
            [
                {"metadata": {"input_tokens": 5, "output_tokens": 2, "model_calls": 1}},
                {
                    "metadata": {
                        "provider": "openai",
                        "model": "unpriced-model",
                        "input_tokens": 3,
                        "output_tokens": 1,
                        "model_calls": 1,
                    }
                },
                {
                    "metadata": {
                        "provider": "openai",
                        "model": "multiple",
                        "input_tokens": 8,
                        "output_tokens": 4,
                        "model_calls": 2,
                        "estimated_cost_micros": 9,
                    }
                },
                {
                    "metadata": {
                        "provider": "openai",
                        "model": "zero-token-model",
                        "input_tokens": 0,
                        "output_tokens": 0,
                        "model_calls": 1,
                        "estimated_cost_micros": 0,
                    }
                },
                {
                    "metadata": {
                        "provider": " ",
                        "model": "",
                        "input_tokens": 1,
                        "output_tokens": 0,
                    }
                },
                {"metadata": {"model_calls": 0, "route_reason": "deterministic"}},
            ]
        )
    )
    assert result["turns"] == 6 and result["conversations"] == 5
    assert (result["input_tokens"], result["output_tokens"], result["model_calls"]) == (
        17,
        7,
        5,
    )
    assert (
        result["usage_recorded"],
        result["cost_recorded"],
        result["estimated_cost_micros"],
    ) == (5, 2, 9)
    models = {row["model"]: row for row in result["models"]}
    assert set(models) == {"unknown", "unpriced-model", "multiple", "zero-token-model"}
    assert models["unknown"] == {
        "provider": "unknown",
        "model": "unknown",
        "input_tokens": 6,
        "output_tokens": 2,
        "turns": 2,
    }
    assert models["zero-token-model"]["turns"] == 1
