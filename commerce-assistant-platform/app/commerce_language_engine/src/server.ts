import {traceBoundary} from './trace-boundary.ts';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {loadRuntime} from './runtime.ts';
import {resolve} from './engine.ts';
import {validContext} from './context.ts';
import {randomUUID} from 'node:crypto';
import {withDb,closeDb} from './database.ts';
import {MissingSession,PendingSessionRepository,StaleSessionRevision,validSessionKey} from './pending-session.ts';
import {loadResolutionProvenance,resolutionEnvelope} from './resolution-wire.ts';
const compiled=await loadRuntime();const publicRoot=new URL('../public/',import.meta.url);
const provenance=await loadResolutionProvenance(compiled.dictionary);
const durableSessions=process.env.ENABLE_DURABLE_SESSIONS==='true';
const trustedTenant=(req:import('node:http').IncomingMessage)=>{
 const resolver=(globalThis as typeof globalThis&{__rocentoResolveTenant?: (request:import('node:http').IncomingMessage)=>string|undefined}).__rocentoResolveTenant;
 return resolver?.(req);
};
const withSessionRepository=<T>(fn:(repo:PendingSessionRepository)=>Promise<T>)=>withDb(db=>fn(new PendingSessionRepository(db,compiled.dictionary,Number(process.env.PENDING_SESSION_TTL_SECONDS??1800))));
async function requestBody(req:import('node:http').IncomingMessage):Promise<string|undefined>{
 const chunks:Buffer[]=[];let bytes=0;
 for await(const chunk of req){bytes+=chunk.length;if(bytes>32768)return undefined;chunks.push(chunk);}
 // Decode once after assembly: a TCP chunk can end inside a UTF-8 code point.
 return Buffer.concat(chunks).toString('utf8');
}
const server=createServer(async(req,res)=>{
 const trace=req.method==='POST'&&req.url==='/api/resolve'?traceBoundary(req.headers['x-commerce-trace-request']):null;
 const json=(status:number,data:unknown)=>{res.writeHead(status,{'content-type':'application/json',...(trace?{'x-commerce-trace-response':trace()}:{})});res.end(JSON.stringify(data));};
 try {
  if(req.method==='POST'&&req.url==='/api/resolve') {
   const body=await requestBody(req);if(body===undefined){json(413,{error:'Request too large',message:'That request is too large. Please shorten it and try again.'});return;}
   let data;try{data=JSON.parse(body);}catch{json(400,{error:'Invalid JSON',message:'The request could not be read. Please send valid JSON.'});return;}
   if(!data||typeof data.text!=='string'||data.text.length>4000){json(400,{error:'text must be a string of at most 4000 characters',message:'Please enter a text request of no more than 4,000 characters.'});return;}
   if(data.contractVersion!==undefined&&data.contractVersion!==1&&data.contractVersion!==2){json(400,{error:'incompatible_version',message:'Unsupported language response contract.'});return;}
   const ctx=data.context??{};
   if(!validContext(ctx,compiled.dictionary)){json(400,{error:'Invalid context',message:'The conversation context is invalid. Reset it and try again.'});return;}
   const result=resolve(compiled,data.text,ctx);
   json(200,data.contractVersion===2?resolutionEnvelope(result,provenance):result);return;
  }
  if(req.method==='POST'&&req.url==='/api/sessions'){
   if(!durableSessions){json(404,{error:'Durable sessions are disabled'});return;}
   const tenantId=trustedTenant(req);if(!tenantId){json(401,{error:'Authenticated tenant required'});return;}
   const body=await requestBody(req);if(body===undefined){json(413,{error:'Request too large'});return;}
   let data;try{data=JSON.parse(body);}catch{json(400,{error:'Invalid JSON'});return;}
   const context=data?.context??{};if(!validContext(context,compiled.dictionary)){json(400,{error:'Invalid context'});return;}
   const sessionId=randomUUID();const session=await withSessionRepository(repo=>repo.create(tenantId,sessionId,context));json(201,{sessionId:session.sessionId,revision:session.revision,expiresAt:session.expiresAt,context:session.context});return;
  }
  const sessionMatch=req.method==='POST'&&/^\/api\/sessions\/([^/]+)\/(resolve|cancel)$/.exec(req.url??'');
  if(sessionMatch){
   if(!durableSessions){json(404,{error:'Durable sessions are disabled'});return;}
   const tenantId=trustedTenant(req),sessionId=sessionMatch[1],action=sessionMatch[2];if(!tenantId){json(401,{error:'Authenticated tenant required'});return;}
   if(!validSessionKey(tenantId,sessionId)){json(400,{error:'Invalid session ID'});return;}
   const body=await requestBody(req);if(body===undefined){json(413,{error:'Request too large'});return;}
   let data;try{data=JSON.parse(body);}catch{json(400,{error:'Invalid JSON'});return;}
   if(!Number.isInteger(data?.revision)||data.revision<1){json(400,{error:'A positive session revision is required'});return;}
   try{
    if(action==='cancel'){await withSessionRepository(repo=>repo.cancel(tenantId,sessionId,data.revision));json(200,{sessionId,revision:data.revision+1,cancelled:true});return;}
    if(typeof data.text!=='string'||data.text.length>4000){json(400,{error:'text must be a string of at most 4000 characters'});return;}
    const result=await withSessionRepository(async repo=>{const stored=await repo.load(tenantId,sessionId);if(stored.revision!==data.revision)throw new StaleSessionRevision();const answer=resolve(compiled,data.text,stored.context);const updated=await repo.update(tenantId,sessionId,data.revision,answer.context.next);return {answer,updated};});
    json(200,{...result.answer,session:{sessionId,revision:result.updated.revision,expiresAt:result.updated.expiresAt}});return;
   }catch(error){if(error instanceof StaleSessionRevision){json(409,{error:'Stale session revision',message:'This conversation changed in another tab. Reload the latest conversation and try again.'});return;}if(error instanceof MissingSession){json(410,{error:'Session expired or cancelled'});return;}throw error;}
  }
  if(req.method==='GET'&&req.url==='/api/ready'){
   // A fixed read-intent self-check exercises parsing without customer data,
   // database access, model calls, or commerce execution.
   const probe=resolve(compiled,'show my cart');
   const ready=probe.status==='RESOLVED'&&probe.intent==='VIEW_CART'&&probe.requestedActions.length===1&&probe.requestedActions[0].intent==='VIEW_CART'&&!(probe.operations?.length);
   json(ready?200:503,{status:ready?'ok':'unavailable',resolutionContractVersion:1,supportedResolutionContractVersions:[1,2],provenance,dictionaryVersion:compiled.dictionary.version,intents:compiled.dictionary.intents.length,generationFingerprint:compiled.dictionary.generationFingerprint});return;
  }
  if(req.method==='GET'&&req.url==='/api/health'){json(200,{status:'ok',resolutionContractVersion:1,supportedResolutionContractVersions:[1,2],provenance,dictionaryVersion:compiled.dictionary.version,intents:compiled.dictionary.intents.length,terms:compiled.dictionary.groups.reduce((n,g)=>n+g.terms.length,0),generationFingerprint:compiled.dictionary.generationFingerprint});return;}
  const files:Record<string,[string,string]>={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
  const file=req.method==='GET'?files[req.url??'']:undefined;if(!file){json(404,{error:'Not found',message:'That page or endpoint was not found.'});return;}
  res.writeHead(200,{'content-type':file[1]+'; charset=utf-8','x-content-type-options':'nosniff'});res.end(await readFile(new URL(file[0],publicRoot)));
 }catch(e){console.error(e);if(!res.headersSent)json(500,{error:'Internal error',message:'Something went wrong. Please try again.'});else res.end();}
});
server.listen(Number(process.env.PORT??3000),process.env.HOST??'127.0.0.1',()=>{const address=server.address();console.log('Commerce inspector: http://127.0.0.1:'+(typeof address==='object'&&address?address.port:process.env.PORT??3000));});
const sessionCleanup=durableSessions?setInterval(()=>{void withSessionRepository(repo=>repo.purgeExpired()).catch(error=>console.error('Session cleanup failed',error));},300000):undefined;
sessionCleanup?.unref();
const shutdown=()=>{if(sessionCleanup)clearInterval(sessionCleanup);server.close(()=>{void closeDb();});};
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
