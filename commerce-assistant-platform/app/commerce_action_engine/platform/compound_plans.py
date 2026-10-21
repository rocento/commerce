"""Scoped immutable plan identity and serialized per-action outcome persistence."""

import json
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from app.commerce_action_engine.execution.planning.outcomes import (
    claim,
    record,
    stop,
    supersede,
    uncertain,
)
from app.commerce_contracts.compound_plan import (
    CompoundPlan,
    CompoundReceipt,
    CompoundScope,
)


class CompoundPlanStore:
    pool: AsyncConnectionPool[AsyncConnection[dict[str, Any]]]

    async def _compound_history_matches(
        self,
        connection: AsyncConnection[dict[str, Any]],
        scope: CompoundScope,
        request: UUID,
        metadata: dict[str, Any],
    ) -> bool:
        """Allow a final receipted snapshot to replace an earlier duplicate reply.

        Called under Store.save's conversation lock. Re-read the authoritative
        plan so an older worker cannot overwrite newer outcomes or another scope.
        Ordinary turn history remains immutable.
        """
        if metadata.get("route_reason") not in {
            "compound_plan_review",
            "compound_execution_completed",
            "compound_plan_recovery",
        } or not metadata.get("compound_plan_id"):
            return False
        row = await self._compound_row(connection, scope, request)
        if row is None:
            return False
        plan = self._compound_decode(row, scope, request)
        if row["active_revision"] != plan.revision:
            plan = supersede(plan)
        return (
            plan.execution_enabled
            and str(plan.id) == metadata["compound_plan_id"]
            and [a.state for a in plan.actions]
            == metadata.get("compound_action_states")
            and any(a.receipt is not None for a in plan.actions)
            and all(
                a.state in {"succeeded", "failed", "not_started", "superseded"}
                for a in plan.actions
            )
        )

    @asynccontextmanager
    async def _compound_connection(
        self, scope: CompoundScope
    ) -> AsyncIterator[AsyncConnection[dict[str, Any]]]:
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true),set_config('assistant.customer',%s,true)",
                (str(scope.tenant_id), str(scope.customer_id)),
            )
            # Same lock as begin_request: cancellation and claims have a defined order.
            await connection.execute(
                "SELECT id FROM assistant.conversations WHERE tenant_id=%s AND customer_id=%s AND id=%s FOR UPDATE",
                (scope.tenant_id, scope.customer_id, scope.conversation_id),
            )
            yield connection

    async def _compound_row(
        self,
        connection: AsyncConnection[dict[str, Any]],
        scope: CompoundScope,
        request: UUID,
    ) -> dict[str, Any] | None:
        return await (
            await connection.execute(
                "SELECT p.payload,r.revision AS active_revision FROM assistant.compound_plans p "
                "LEFT JOIN assistant.request_revisions r ON r.tenant_id=p.tenant_id AND r.customer_id=p.customer_id "
                "AND r.conversation_id=p.conversation_id WHERE p.tenant_id=%s AND p.customer_id=%s "
                "AND p.conversation_id=%s AND p.request_id=%s FOR UPDATE OF p",
                (scope.tenant_id, scope.customer_id, scope.conversation_id, request),
            )
        ).fetchone()

    @staticmethod
    def _compound_decode(
        row: dict[str, Any], scope: CompoundScope, request: UUID
    ) -> CompoundPlan:
        plan = CompoundPlan.model_validate_json(json.dumps(row["payload"]))
        if plan.scope != scope or plan.request_id != request:
            raise ValueError("compound_scope_mismatch")
        return plan

    async def get_compound_plan(
        self, scope: CompoundScope, request: UUID, input_hash: str
    ) -> CompoundPlan | None:
        async with self._compound_connection(scope) as connection:
            row = await self._compound_row(connection, scope, request)
            if row is None:
                return None
            plan = self._compound_decode(row, scope, request)
            if plan.input_hash != input_hash:
                raise ValueError("compound_request_reused_with_different_input")
            return plan if row["active_revision"] == plan.revision else supersede(plan)

    async def save_compound_plan(self, plan: CompoundPlan) -> CompoundPlan | None:
        # Revalidate immutable nested state even for internal callers.
        plan = CompoundPlan.model_validate_json(plan.model_dump_json())
        if any(action.state not in {"ready", "needs_input"} for action in plan.actions):
            raise ValueError("initial_compound_outcome_forbidden")
        scope = plan.scope
        async with self._compound_connection(scope) as connection:
            existing = await self._compound_row(connection, scope, plan.request_id)
            if existing:
                previous = self._compound_decode(existing, scope, plan.request_id)
                if previous.input_hash != plan.input_hash:
                    raise ValueError("compound_request_reused_with_different_input")
                return (
                    previous
                    if existing["active_revision"] == previous.revision
                    else supersede(previous)
                )
            current = await (
                await connection.execute(
                    "SELECT revision FROM assistant.request_revisions WHERE tenant_id=%s AND customer_id=%s AND conversation_id=%s",
                    (scope.tenant_id, scope.customer_id, scope.conversation_id),
                )
            ).fetchone()
            if not current or current["revision"] != plan.revision:
                return None
            await connection.execute(
                "INSERT INTO assistant.compound_plans(tenant_id,customer_id,conversation_id,request_id,plan_id,revision,input_hash,payload) "
                "VALUES(%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    scope.tenant_id,
                    scope.customer_id,
                    scope.conversation_id,
                    plan.request_id,
                    plan.id,
                    plan.revision,
                    plan.input_hash,
                    Jsonb(plan.model_dump(mode="json")),
                ),
            )
            return plan

    async def transition_compound(
        self,
        scope: CompoundScope,
        request: UUID,
        action_id: UUID,
        *,
        transition: str,
        receipt: CompoundReceipt | None = None,
    ) -> CompoundPlan:
        """Internal outcome port; not exposed to chat, the model, or HTTP clients.

        This records state only. It neither sends a mutation nor authorizes one.
        M4 must invoke it around independently authorized, receipted operations.
        """
        async with self._compound_connection(scope) as connection:
            row = await self._compound_row(connection, scope, request)
            if row is None:
                raise ValueError("compound_plan_missing")
            plan = self._compound_decode(row, scope, request)
            if transition in {"claim", "dispatch"}:
                if row["active_revision"] != plan.revision or receipt is not None:
                    raise ValueError("compound_plan_superseded")
                if transition == "dispatch" and not plan.execution_enabled:
                    raise ValueError("compound_review_not_executable")
                updated = claim(plan, action_id, now=int(time.time()))
            elif transition == "stop" and receipt is None:
                updated = stop(plan)
            elif transition == "uncertain" and receipt is None:
                updated = uncertain(plan, action_id)
            elif (
                transition == "receipt"
                and receipt is not None
                and receipt.action_id == action_id
            ):
                if receipt.observed_at > int(time.time()):
                    raise ValueError("receipt_time_invalid")
                updated = record(plan, receipt)
            else:
                raise ValueError("invalid_compound_transition")
            await connection.execute(
                "UPDATE assistant.compound_plans SET payload=%s WHERE tenant_id=%s AND customer_id=%s AND conversation_id=%s AND request_id=%s",
                (
                    Jsonb(updated.model_dump(mode="json")),
                    scope.tenant_id,
                    scope.customer_id,
                    scope.conversation_id,
                    request,
                ),
            )
            return (
                updated
                if row["active_revision"] == updated.revision
                else supersede(updated)
            )
