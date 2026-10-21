"""Atomic, owner-scoped clarification claims. Only hashes of linguistic text persist."""

from hashlib import sha256
from typing import Any
from uuid import UUID, uuid4

from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool


def digest(text: str) -> str:
    return sha256(text.encode("utf-8")).hexdigest()


class RequestRevisionStore:
    pool: AsyncConnectionPool[AsyncConnection[dict[str, Any]]]

    async def begin_request(
        self,
        tenant: UUID,
        customer: UUID,
        conversation: UUID,
        *,
        expected_revision: UUID | None = None,
        original: str = "",
        question: str = "",
    ) -> UUID | None:
        """Claim a reply once or supersede pending work at the start of a fresh turn.

        A conversation lock serializes concurrent starts. Publishing uses a CAS
        so a slow older turn cannot resurrect its question after a newer turn.
        Invalid claims leave the current revision intact.
        """
        revision = uuid4()
        scope = (tenant, customer, conversation)
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true),set_config('assistant.customer',%s,true)",
                (str(tenant), str(customer)),
            )
            await connection.execute(
                "INSERT INTO assistant.conversations(tenant_id,customer_id,id) VALUES(%s,%s,%s) ON CONFLICT DO NOTHING",
                scope,
            )
            await connection.execute(
                "SELECT id FROM assistant.conversations WHERE tenant_id=%s AND customer_id=%s AND id=%s FOR UPDATE",
                scope,
            )
            if expected_revision is not None:
                row = await (
                    await connection.execute(
                        "SELECT revision FROM assistant.request_revisions WHERE tenant_id=%s AND customer_id=%s "
                        "AND conversation_id=%s AND revision=%s AND pending AND expires_at>now() "
                        "AND original_hash=%s AND question_hash=%s AND shopping_state IS NULL",
                        (*scope, expected_revision, digest(original), digest(question)),
                    )
                ).fetchone()
                if row is None:
                    return None
            await connection.execute(
                "INSERT INTO assistant.request_revisions(tenant_id,customer_id,conversation_id,revision) "
                "VALUES(%s,%s,%s,%s) ON CONFLICT(tenant_id,customer_id,conversation_id) DO UPDATE "
                "SET revision=EXCLUDED.revision,pending=false,original_hash=NULL,question_hash=NULL,expires_at=NULL,"
                "shopping_state=NULL,shopping_store_id=NULL,shopping_session_id=NULL,"
                "shopping_active_state=NULL,shopping_active_store_id=NULL,shopping_active_session_id=NULL,shopping_active_expires_at=NULL",
                (*scope, revision),
            )
        return revision

    async def publish_question(
        self,
        tenant: UUID,
        customer: UUID,
        conversation: UUID,
        revision: UUID,
        original: str,
        question: str,
    ) -> bool:
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute(
                "SELECT set_config('assistant.tenant',%s,true),set_config('assistant.customer',%s,true)",
                (str(tenant), str(customer)),
            )
            row = await (
                await connection.execute(
                    "UPDATE assistant.request_revisions SET pending=true,original_hash=%s,question_hash=%s,"
                    "expires_at=now()+interval '15 minutes' WHERE tenant_id=%s AND customer_id=%s "
                    "AND conversation_id=%s AND revision=%s AND NOT pending RETURNING revision",
                    (
                        digest(original),
                        digest(question),
                        tenant,
                        customer,
                        conversation,
                        revision,
                    ),
                )
            ).fetchone()
            return row is not None
