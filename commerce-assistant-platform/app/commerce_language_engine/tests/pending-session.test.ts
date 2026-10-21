import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {MissingSession,PendingSessionRepository,StaleSessionRevision,validSessionKey} from '../src/pending-session.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';
import {compile} from '../src/compiler.ts';

const tenant='123e4567-e89b-42d3-a456-426614174000',session='123e4567-e89b-42d3-a456-426614174001';
function client(query:(sql:string,values?:unknown[])=>Promise<any>){return {query} as any;}

test('session identifiers require opaque UUID values and never accept tenant labels',()=>{
 assert.equal(validSessionKey(tenant,session),true);assert.equal(validSessionKey('tenant-a',session),false);assert.equal(validSessionKey(tenant,'other-session'),false);
});

test('repository creates, reloads, advances revisions, isolates tenants and rejects stale writes',async()=>{
 const d=buildExpandedDictionary(),compiled=compile(d),saved=new Map<string,any>();let statements=0;
 const db=client(async(sql,values=[])=>{
  statements++;
  if(sql.startsWith('INSERT')){const [t,s,context,pending]=[values[0],values[1],values[2],values[3]];const key=`${t}/${s}`;assert.equal(saved.has(key),false);const row={tenant_id:t,session_id:s,revision:1,context,pending_request:pending,expires_at:new Date(Date.now()+3600000)};saved.set(key,row);return {rows:[{revision:1,expires_at:row.expires_at}],rowCount:1};}
  if(sql.startsWith('SELECT tenant_id')){const row=saved.get(`${values[0]}/${values[1]}`);return {rows:row?[{...row,context:{...row.context,...(row.pending_request?{pendingRequest:row.pending_request}:{})}}]:[],rowCount:row?1:0};}
  if(sql.startsWith('SELECT 1')){const row=saved.get(`${values[0]}/${values[1]}`);return {rows:row?[{one:1}]:[],rowCount:row?1:0};}
  if(sql.startsWith('UPDATE context.sessions')&&sql.includes('revision=revision+1')){const row=saved.get(`${values[0]}/${values[1]}`);if(!row||row.revision!==values[2])return {rows:[],rowCount:0};row.revision++;row.context=values[3];row.pending_request=values[4];return {rows:[{revision:row.revision,expires_at:row.expires_at}],rowCount:1};}
  return {rows:[],rowCount:0};
 });
 const repo=new PendingSessionRepository(db,d),initial=resolve(compiled,'create an order for two apples and deliver it there').context.next;
 const created=await repo.create(tenant,session,initial);assert.equal(created.revision,1);
 const loaded=await repo.load(tenant,session);assert.equal(loaded.pendingRequest,'create an order for two apples and deliver it there');
 const answer=resolve(compiled,'home',loaded.context),updated=await repo.update(tenant,session,1,answer.context.next);assert.equal(updated.revision,2);assert.equal(answer.status,'RESOLVED');
 await assert.rejects(repo.update(tenant,session,1,{}),StaleSessionRevision);
 await assert.rejects(repo.load('123e4567-e89b-42d3-a456-426614174002',session),MissingSession);
 assert.ok(statements>=5);
});

test('phase 8 migration scopes rows by tenant/session, enforces revisions and expires/cancels sessions',async()=>{
 const up=await readFile(new URL('../migrations/010_pending_clarification_sessions.sql',import.meta.url),'utf8');
 assert.match(up,/PRIMARY KEY\(tenant_id,session_id\)/);assert.match(up,/revision integer NOT NULL CHECK\(revision>0\)/);assert.match(up,/expires_at timestamptz NOT NULL/);assert.match(up,/cancelled_at timestamptz/);
});
