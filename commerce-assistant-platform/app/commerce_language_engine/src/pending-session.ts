import type pg from 'pg';
import type {Context,Dictionary} from './types.ts';
import {validContext} from './context.ts';

export type PendingSession={tenantId:string;sessionId:string;revision:number;context:Context;pendingRequest?:string;expiresAt:string};
export class StaleSessionRevision extends Error {constructor(){super('Conversation session revision is stale');this.name='StaleSessionRevision';}}
export class MissingSession extends Error {constructor(){super('Conversation session not found or expired');this.name='MissingSession';}}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validSessionKey(tenantId:unknown,sessionId:unknown):tenantId is string {
 return typeof tenantId==='string'&&uuid.test(tenantId)&&typeof sessionId==='string'&&uuid.test(sessionId);
}
export class PendingSessionRepository {
 private readonly db:pg.PoolClient;private readonly dictionary:Dictionary;private readonly ttlSeconds:number;
 constructor(db:pg.PoolClient,dictionary:Dictionary,ttlSeconds=1800) {
  this.db=db;this.dictionary=dictionary;this.ttlSeconds=ttlSeconds;
  if(!Number.isInteger(ttlSeconds)||ttlSeconds<60||ttlSeconds>604800)throw new Error('Session TTL must be 60 seconds to 7 days');
 }
 async load(tenantId:string,sessionId:string):Promise<PendingSession>{
  const result=await this.db.query("SELECT tenant_id,session_id,revision,context || CASE WHEN pending_request IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('pendingRequest',pending_request) END AS context,pending_request,expires_at FROM context.sessions WHERE tenant_id=$1 AND session_id=$2 AND cancelled_at IS NULL AND expires_at>now()",[tenantId,sessionId]);
  const row=result.rows[0];if(!row)throw new MissingSession();
  if(!validContext(row.context,this.dictionary))throw new Error('Stored conversation context failed validation');
  return {tenantId:row.tenant_id,sessionId:row.session_id,revision:row.revision,context:row.context,...(row.pending_request?{pendingRequest:row.pending_request}:{}),expiresAt:new Date(row.expires_at).toISOString()};
 }
 async create(tenantId:string,sessionId:string,context:Context):Promise<PendingSession>{
  if(!validSessionKey(tenantId,sessionId)||!validContext(context,this.dictionary))throw new Error('Invalid tenant, session, or context');
  const pendingRequest=typeof context.pendingRequest==='string'?context.pendingRequest:null;
  const {pendingRequest:_,...storedContext}=context;
  const result=await this.db.query(`INSERT INTO context.sessions(tenant_id,session_id,revision,context,pending_request,expires_at)
   VALUES($1,$2,1,$3,$4,now()+($5::text||' seconds')::interval) RETURNING revision,expires_at`,[tenantId,sessionId,storedContext,pendingRequest,this.ttlSeconds]);
  return {tenantId,sessionId,revision:result.rows[0].revision,context,...(pendingRequest?{pendingRequest}:{}),expiresAt:new Date(result.rows[0].expires_at).toISOString()};
 }
 async update(tenantId:string,sessionId:string,expectedRevision:number,context:Context):Promise<PendingSession>{
  if(!Number.isInteger(expectedRevision)||expectedRevision<1||!validContext(context,this.dictionary))throw new Error('Invalid session revision or context');
  const pendingRequest=typeof context.pendingRequest==='string'?context.pendingRequest:null;
  const {pendingRequest:_,...storedContext}=context;
  const result=await this.db.query(`UPDATE context.sessions SET revision=revision+1,context=$4,pending_request=$5,
   expires_at=now()+($6::text||' seconds')::interval,updated_at=now()
   WHERE tenant_id=$1 AND session_id=$2 AND revision=$3 AND cancelled_at IS NULL AND expires_at>now()
   RETURNING revision,expires_at`,[tenantId,sessionId,expectedRevision,storedContext,pendingRequest,this.ttlSeconds]);
  if(result.rowCount!==1){const current=await this.db.query('SELECT 1 FROM context.sessions WHERE tenant_id=$1 AND session_id=$2 AND cancelled_at IS NULL AND expires_at>now()',[tenantId,sessionId]);if(current.rowCount)throw new StaleSessionRevision();throw new MissingSession();}
  return {tenantId,sessionId,revision:result.rows[0].revision,context,...(pendingRequest?{pendingRequest}:{}),expiresAt:new Date(result.rows[0].expires_at).toISOString()};
 }
 async cancel(tenantId:string,sessionId:string,expectedRevision:number):Promise<void>{
  const result=await this.db.query('UPDATE context.sessions SET revision=revision+1,cancelled_at=now(),updated_at=now(),context=$4,pending_request=NULL WHERE tenant_id=$1 AND session_id=$2 AND revision=$3 AND cancelled_at IS NULL AND expires_at>now()',[tenantId,sessionId,expectedRevision,{}]);
  if(result.rowCount!==1){const current=await this.db.query('SELECT 1 FROM context.sessions WHERE tenant_id=$1 AND session_id=$2 AND cancelled_at IS NULL AND expires_at>now()',[tenantId,sessionId]);if(current.rowCount)throw new StaleSessionRevision();throw new MissingSession();}
 }
 async purgeExpired():Promise<number>{
  const expired=await this.db.query(`WITH batch AS (SELECT ctid FROM context.sessions WHERE cancelled_at IS NULL AND expires_at<=now() ORDER BY expires_at LIMIT 500)
   DELETE FROM context.sessions s USING batch b WHERE s.ctid=b.ctid`);
  const cancelled=await this.db.query(`WITH batch AS (SELECT ctid FROM context.sessions WHERE cancelled_at IS NOT NULL ORDER BY cancelled_at LIMIT 500)
   DELETE FROM context.sessions s USING batch b WHERE s.ctid=b.ctid`);
  return (expired.rowCount??0)+(cancelled.rowCount??0);
 }
}
