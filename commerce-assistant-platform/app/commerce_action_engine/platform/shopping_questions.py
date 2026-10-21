"""Owner-scoped typed discovery continuations; client text never supplies a frame."""

import json
from typing import Any
from uuid import UUID, uuid4

from psycopg import AsyncConnection
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from app.commerce_action_engine.actions.shopping.continuation import ActiveShopping
from app.commerce_action_engine.actions.shopping.contracts import ShoppingClarification

from .request_revisions import digest


class ShoppingQuestionStore:
    pool: AsyncConnectionPool[AsyncConnection[dict[str, Any]]]

    async def shopping_active(
        self,
        tenant: UUID,
        customer: UUID,
        conversation: UUID,
        *,
        store_id: UUID,
        session_id: UUID,
    ) -> dict[str, Any] | None:
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true),set_config('assistant.customer',%s,true)",
                (str(tenant), str(customer)),
            )
            row = await (
                await connection.execute(
                    "SELECT revision,shopping_active_state FROM assistant.request_revisions WHERE tenant_id=%s AND customer_id=%s "
                    "AND conversation_id=%s AND NOT pending AND shopping_active_expires_at>now() "
                    "AND shopping_active_store_id=%s AND shopping_active_session_id=%s AND shopping_active_state IS NOT NULL",
                    (tenant, customer, conversation, store_id, session_id),
                )
            ).fetchone()
            if row is None:
                return None
            state = row.get("shopping_active_state")
            if not isinstance(state, dict) or set(state) != {
                "original_message",
                "active",
            }:
                return None
            original = state["original_message"]
            if not isinstance(original, str) or not 0 < len(original) <= 4000:
                return None
            try:
                active = ActiveShopping.model_validate(state["active"])
            except (ValueError, TypeError):
                return None
            return {
                "revision": row["revision"],
                "original_message": original,
                "active": active,
            }

    async def claim_active_shopping(
        self,
        tenant: UUID,
        customer: UUID,
        conversation: UUID,
        *,
        store_id: UUID,
        session_id: UUID,
        revision: UUID,
    ) -> UUID | None:
        next_revision = uuid4()
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true),set_config('assistant.customer',%s,true)",
                (str(tenant), str(customer)),
            )
            await connection.execute(
                "SELECT id FROM assistant.conversations WHERE tenant_id=%s AND customer_id=%s AND id=%s FOR UPDATE",
                (tenant, customer, conversation),
            )
            row = await (
                await connection.execute(
                    "UPDATE assistant.request_revisions SET revision=%s,shopping_active_state=NULL,shopping_active_store_id=NULL,"
                    "shopping_active_session_id=NULL,shopping_active_expires_at=NULL WHERE tenant_id=%s AND customer_id=%s "
                    "AND conversation_id=%s AND revision=%s AND NOT pending AND shopping_active_expires_at>now() "
                    "AND shopping_active_store_id=%s AND shopping_active_session_id=%s AND shopping_active_state IS NOT NULL RETURNING revision",
                    (
                        next_revision,
                        tenant,
                        customer,
                        conversation,
                        revision,
                        store_id,
                        session_id,
                    ),
                )
            ).fetchone()
            return next_revision if row else None

    async def save_active_shopping(
        self,
        tenant: UUID,
        customer: UUID,
        conversation: UUID,
        revision: UUID,
        original: str,
        active: ActiveShopping,
        *,
        store_id: UUID,
        session_id: UUID,
    ) -> bool:
        active = ActiveShopping.model_validate(active.model_dump())
        state = {"original_message": original, "active": active.model_dump(mode="json")}
        if (
            not 0 < len(original) <= 4000
            or len(json.dumps(state).encode("utf-8")) > 30000
        ):
            return False
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true),set_config('assistant.customer',%s,true)",
                (str(tenant), str(customer)),
            )
            row = await (
                await connection.execute(
                    "UPDATE assistant.request_revisions SET shopping_active_state=%s,shopping_active_store_id=%s,"
                    "shopping_active_session_id=%s,shopping_active_expires_at=now()+interval '15 minutes' "
                    "WHERE tenant_id=%s AND customer_id=%s AND conversation_id=%s AND revision=%s AND NOT pending RETURNING revision",
                    (
                        Jsonb(state),
                        store_id,
                        session_id,
                        tenant,
                        customer,
                        conversation,
                        revision,
                    ),
                )
            ).fetchone()
            return row is not None

    async def shopping_question(
        self,
        tenant: UUID,
        customer: UUID,
        conversation: UUID,
        *,
        store_id: UUID,
        session_id: UUID,
        revision: UUID | None = None,
        original: str | None = None,
        question: str | None = None,
    ) -> dict[str, Any] | None:
        """Read a live state without consuming it; invalid replies leave it intact."""
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true),set_config('assistant.customer',%s,true)",
                (str(tenant), str(customer)),
            )
            row = await (
                await connection.execute(
                    "SELECT revision,shopping_state FROM assistant.request_revisions WHERE tenant_id=%s "
                    "AND customer_id=%s AND conversation_id=%s AND pending AND expires_at>now() "
                    "AND shopping_store_id=%s AND shopping_session_id=%s AND shopping_state IS NOT NULL "
                    "AND (%s::uuid IS NULL OR revision=%s) "
                    "AND (%s::text IS NULL OR original_hash=%s) "
                    "AND (%s::text IS NULL OR question_hash=%s)",
                    (
                        tenant,
                        customer,
                        conversation,
                        store_id,
                        session_id,
                        revision,
                        revision,
                        original,
                        digest(original) if original is not None else None,
                        question,
                        digest(question) if question is not None else None,
                    ),
                )
            ).fetchone()
            if row is None:
                return None
            state = row.get("shopping_state")
            if not isinstance(state, dict) or set(state) != {
                "original_message",
                "plan",
            }:
                return None
            original_message = state["original_message"]
            if (
                not isinstance(original_message, str)
                or not 0 < len(original_message) <= 4000
            ):
                return None
            try:
                plan = ShoppingClarification.model_validate(state["plan"])
            except (ValueError, TypeError):
                return None
            return {
                "revision": row["revision"],
                "original_message": original_message,
                "plan": plan,
            }

    async def claim_shopping_question(
        self,
        tenant: UUID,
        customer: UUID,
        conversation: UUID,
        *,
        store_id: UUID,
        session_id: UUID,
        revision: UUID,
        original: str,
        question: str,
    ) -> UUID | None:
        """Consume a validated reply once, rotating before any discovery tools run."""
        next_revision = uuid4()
        scope = (tenant, customer, conversation)
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true),set_config('assistant.customer',%s,true)",
                (str(tenant), str(customer)),
            )
            await connection.execute(
                "SELECT id FROM assistant.conversations WHERE tenant_id=%s AND customer_id=%s AND id=%s FOR UPDATE",
                scope,
            )
            row = await (
                await connection.execute(
                    "UPDATE assistant.request_revisions SET revision=%s,pending=false,original_hash=NULL,"
                    "question_hash=NULL,expires_at=NULL,shopping_state=NULL,shopping_store_id=NULL,"
                    "shopping_session_id=NULL WHERE tenant_id=%s AND customer_id=%s AND conversation_id=%s "
                    "AND revision=%s AND pending AND expires_at>now() AND shopping_store_id=%s "
                    "AND shopping_session_id=%s AND shopping_state IS NOT NULL AND original_hash=%s "
                    "AND question_hash=%s RETURNING revision",
                    (
                        next_revision,
                        *scope,
                        revision,
                        store_id,
                        session_id,
                        digest(original),
                        digest(question),
                    ),
                )
            ).fetchone()
            return next_revision if row else None

    async def publish_shopping_question(
        self,
        tenant: UUID,
        customer: UUID,
        conversation: UUID,
        revision: UUID,
        original: str,
        plan: ShoppingClarification,
        *,
        store_id: UUID,
        session_id: UUID,
    ) -> bool:
        # Revalidate copies made by application planners before persistence.
        plan = ShoppingClarification.model_validate(plan.model_dump())
        state = {"original_message": original, "plan": plan.model_dump(mode="json")}
        if (
            not 0 < len(original) <= 4000
            or len(json.dumps(state).encode("utf-8")) > 30000
        ):
            return False
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true),set_config('assistant.customer',%s,true)",
                (str(tenant), str(customer)),
            )
            row = await (
                await connection.execute(
                    "UPDATE assistant.request_revisions SET pending=true,original_hash=%s,question_hash=%s,"
                    "expires_at=now()+interval '15 minutes',shopping_active_state=NULL,shopping_active_store_id=NULL,"
                    "shopping_active_session_id=NULL,shopping_active_expires_at=NULL,shopping_state=%s,shopping_store_id=%s,"
                    "shopping_session_id=%s WHERE tenant_id=%s AND customer_id=%s AND conversation_id=%s "
                    "AND revision=%s AND NOT pending RETURNING revision",
                    (
                        digest(original),
                        digest(plan.question),
                        Jsonb(state),
                        store_id,
                        session_id,
                        tenant,
                        customer,
                        conversation,
                        revision,
                    ),
                )
            ).fetchone()
            return row is not None
