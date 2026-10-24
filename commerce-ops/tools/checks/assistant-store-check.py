"""Run inside ai-service: proves AI store ownership, RLS, redaction and bounded history."""

import asyncio
import os
from uuid import UUID, uuid4

from app.commerce_action_engine.platform.store import Store
from psycopg import errors


async def main():
    store=Store(os.environ['AI_STORE_PASSWORD_FILE']);await store.open()
    tenant=UUID(os.environ['ASSISTANT_TENANT_ID']);owner=uuid4();other=uuid4();conversation=uuid4();request=uuid4()
    try:
        assert await store.ready()
        await store.save(tenant,owner,conversation,request,'Contact test@example.test password=do-not-store','Grounded reply')
        await store.save(tenant,owner,conversation,request,'retry','Grounded reply')
        rows=await store.history(tenant,owner);assert len(rows)==1
        assert 'test@example.test' not in rows[0]['question'] and 'do-not-store' not in rows[0]['question']
        assert await store.history(tenant,other)==[]
        assert await store.history(uuid4(),owner)==[]
        try: await store.save(uuid4(),owner,conversation,uuid4(),'forged tenant','no')
        except errors.InsufficientPrivilege: pass
        else: raise AssertionError('Foreign tenant write accepted')
        async with store.pool.connection() as conn,conn.transaction():
            await conn.execute("SELECT set_config('assistant.tenant',%s,true),set_config('assistant.customer',%s,true)",(str(tenant),str(other)))
            # Deliberately omit owner WHERE: database RLS must still hide the other account.
            rows=await (await conn.execute('SELECT * FROM assistant.turns')).fetchall();assert rows==[]
        async with store.pool.connection() as conn:
            try: await conn.execute('CREATE TABLE public.escape(id integer)')
            except errors.InsufficientPrivilege: await conn.rollback()
            else: raise AssertionError('Runtime role can create arbitrary tables')
        await store.metric(tenant,request,'completed',10)
        metrics=await store.metrics(tenant);assert any(m['request_id']==request for m in metrics)
        await store.acknowledge_metrics(tenant,[request]);assert not any(m['request_id']==request for m in await store.metrics(tenant))
        print('PASS AI-owned PostgreSQL: role restrictions, deployment/customer RLS, replay, redaction and telemetry acknowledgement')
    finally:
        async with store.pool.connection() as conn,conn.transaction():
            await conn.execute("SELECT set_config('assistant.tenant',%s,true),set_config('assistant.customer',%s,true)",(str(tenant),str(owner)))
            await conn.execute('DELETE FROM assistant.conversations WHERE id=%s',(conversation,))
            await conn.execute('DELETE FROM assistant.metrics WHERE request_id=%s',(request,))
        await store.close()
asyncio.run(main())
