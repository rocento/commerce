import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { rememberedSessions, sessionKey, REMEMBER_MS } from './sessions.mjs';
import { connectionVault } from './connections.mjs';
import { configuration } from './config.mjs';
import { customerJourney, ruleEvidence } from './journey.mjs';
import { languageFlow, parseSSEFrame, summary } from './analysis.mjs';

const MAX_BODY = 96 * 1024, MAX_RESPONSE = 2 * 1024 * 1024, SESSION_MS = 2 * 60 * 60 * 1000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class Failure extends Error { constructor(status, message) { super(message); this.status = status; } }
const ensure = (condition, message) => { if (!condition) throw new Failure(400, message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validateCase(value) {
  ensure(object(value), 'Each case must be an object.');
  ensure(typeof value.text === 'string' && value.text.trim() && value.text.length <= 4000, 'Enter 1–4,000 characters per request.');
  ensure(value.context === undefined || object(value.context), 'Context must be a JSON object.');
  ensure(value.expectedIntent === undefined || value.expectedIntent === null || (typeof value.expectedIntent === 'string' && value.expectedIntent.length <= 100), 'Invalid expected intent.');
  ensure(value.expectedStatus === undefined || ['RESOLVED','UNKNOWN','AMBIGUOUS','NEEDS_CONTEXT','UNSUPPORTED','DENIED'].includes(value.expectedStatus), 'Invalid expected status.');
  return { text: value.text, context: value.context ?? {}, contractVersion: 2 };
}
async function limitedText(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE) { await response.body?.cancel(); throw new Failure(502, 'Upstream response exceeded the capture limit.'); }
  const reader = response.body?.getReader(); if (!reader) return '';
  let size = 0; const parts = [];
  try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > MAX_RESPONSE) throw new Failure(502, 'Upstream response exceeded the capture limit.'); parts.push(value); } }
  finally { await reader.cancel(); }
  return Buffer.concat(parts).toString('utf8');
}
async function body(req) {
  ensure(req.headers['content-type']?.split(';')[0] === 'application/json', 'Use application/json.');
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > MAX_BODY) throw new Failure(413, 'Request too large.'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); ensure(object(value), 'Expected a JSON object.'); return value; }
  catch (error) { if (error instanceof Failure) throw error; throw new Failure(400, 'Invalid JSON.'); }
}
export function createApp(config = configuration(), fetcher = fetch) {
  const vault=connectionVault(config), remembered=rememberedSessions(config);
  const sessions = new Map(), loginAttempts = new Map(); let active = 0, activeLive = 0;
  for(const [id, record] of remembered?.entries() ?? []) {
    const session={owner:true,ownerCookie:record.ownerCookie,ownerCredentials:record.credentials,expires:record.expires,busy:false,stores:{[config.ownerStore]:{cookie:record.ownerCookie,name:'Operator'}}};
    attachSaved(session);sessions.set(id,session);
  }
  const cookieName = config.secure ? '__Host-rengine' : 'rengine';
  const sessionCookie = (token, age = SESSION_MS / 1000) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${config.secure ? '; Secure' : ''}`;
  async function upstream(base, path, { method = 'GET', payload, cookie, timeout = 12000, signal } = {}) {
    const abort = AbortSignal.timeout(timeout);
    let response;
    try { response = await fetcher(base + path, { method, redirect: 'error', signal: signal ? AbortSignal.any([abort, signal]) : abort, headers: { accept: 'application/json', ...(payload ? {'content-type':'application/json','x-commerce-request':'1'} : {}), ...(cookie ? {cookie} : {}) }, ...(payload ? {body: JSON.stringify(payload)} : {}) }); }
    catch { throw new Failure(502, 'The selected demo did not respond. Check its service status.'); }
    const raw = await limitedText(response); let data;
    try { data = JSON.parse(raw); } catch { throw new Failure(502, 'The selected demo returned an invalid response.'); }
    if (!response.ok) throw new Failure([400,401,403,404,409,422,429].includes(response.status) ? response.status : 502, response.status === 401 ? 'Your demo session expired. Reconnect this demo.' : response.status === 403 ? 'Your administrator account lacks the required permission for this operation.' : `Demo request failed (${response.status}).`);
    return { response, data };
  }
  function identity(req) {
    const token = (req.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    const id=typeof token==='string'?sessionKey(token):'';
    const session = sessions.get(id);
    if (!session || session.expires < Date.now()) { if (id) {remembered?.remove(id);sessions.delete(id);} throw new Failure(401, 'Sign in with a demo administrator account.'); }
    return { token:id, session };
  }
  async function demoLogin(name, credentials) {
    const {response,data}=await upstream(config.stores[name].gateway,'/v1/admin/auth/login',{method:'POST',payload:{email:credentials.email,password:credentials.password}});
    const cookie=response.headers.getSetCookie().find(v=>v.startsWith('admin_session='))?.split(';')[0];
    if(!cookie)throw new Failure(502,'Demo login did not issue a session.');
    if(!data.permissions?.some(p=>p==='*'||p==='assistant.tracking.read')) {
      await upstream(config.stores[name].gateway,'/v1/admin/auth/logout',{method:'POST',payload:{},cookie}).catch(()=>{});
      throw new Failure(403,'Assistant tracking permission is required.');
    }
    return {cookie,name:data.user?.name??'Operator'};
  }
  async function owner(req) {
    const {session}=identity(req);
    if(!session.owner || !vault)throw new Failure(403,'Sign in with the configured rengine operator account to manage saved demos.');
    const {token}=identity(req);
    let data;
    try { ({data}=await upstream(config.stores[config.ownerStore].gateway,'/v1/admin/me',{cookie:session.ownerCookie})); }
    catch(error) {
      if(error.status!==401 || !session.ownerCredentials)throw error;
      if(session.ownerRetryAfter>Date.now())throw new Failure(502,'Operator authentication is temporarily unavailable. Please retry shortly.');
      // Renew only this browser's authenticated operator identity, never a demo account.
      session.ownerRenewing??=demoLogin(config.ownerStore,session.ownerCredentials).then(admin=>{
        session.ownerCookie=admin.cookie;
        if(session.stores[config.ownerStore])session.stores[config.ownerStore].cookie=admin.cookie;
        if(sessions.get(token)===session)remembered?.set(token,session);
      }).finally(()=>{delete session.ownerRenewing;});
      try {await session.ownerRenewing;}
      catch(failure){session.ownerRetryAfter=Date.now()+30000;if([401,403].includes(failure.status)){remembered?.remove(token);sessions.delete(token);}throw failure;}
      ({data}=await upstream(config.stores[config.ownerStore].gateway,'/v1/admin/me',{cookie:session.ownerCookie}));
    }
    if(!data.permissions?.includes('*')){remembered?.remove(token);sessions.delete(token);throw new Failure(403,'The rengine operator must retain administrator access.');}
    if(sessions.get(token)!==session)throw new Failure(401,'Sign in to rengine.');
    return session;
  }
  function attachSaved(session) {
    if(session.owner && vault)for(const name of vault.names()){if(!session.stores[name])session.stores[name]={saved:true};else session.stores[name].saved=true;}
  }
  async function authorize(req, name) {
    const {session}=identity(req);const store=Object.hasOwn(config.stores,name)?config.stores[name]:null;
    if(session.owner){await owner(req);attachSaved(session);}
    const admin=store && session.stores[name];
    if(!admin)throw new Failure(401,'Connect this demo with its administrator account.');
    const credentials=admin.saved && vault?.get(name);
    const renew=async()=>{
      if(!credentials)throw new Failure(401,'Your demo session expired. Reconnect this demo.');
      if(admin.retryAfter>Date.now())throw new Failure(502,'Saved demo connection needs attention. Check Settings.');
      admin.renewing??=demoLogin(name,credentials).then(value=>Object.assign(admin,value)).catch(error=>{admin.retryAfter=Date.now()+30000;if(error.status===401)throw new Failure(502,'Saved credentials were rejected. Update this demo in Settings.');throw error;}).finally(()=>{delete admin.renewing;});
      await admin.renewing;
    };
    if(!admin.cookie)await renew();
    let data;
    try{({data}=await upstream(store.gateway,'/v1/admin/me',{cookie:admin.cookie}));}
    catch(error){if(error.status!==401||!credentials)throw error;await renew();({data}=await upstream(store.gateway,'/v1/admin/me',{cookie:admin.cookie}));}
    if(!data.permissions?.some(p=>p==='*'||p==='assistant.tracking.read'))throw new Failure(403,'Assistant tracking permission is required.');
    return {session,store,admin,canExport:data.permissions.some(p=>p==='assistant.tracking.export'||p==='*')};
  }
  async function bounded(session, operation) {
    if (session.busy || active >= 2) throw new Failure(429, 'Another evaluation is running. Please retry when it finishes.');
    session.busy = true; active++;
    try { return await operation(); } finally { session.busy = false; active--; }
  }
  async function resolve(store, input, signal) {
    const payload = validateCase(input); const started = performance.now();
    const {data} = await upstream(store.language, '/api/resolve', {method:'POST',payload,signal});
    ensure(data.contractVersion === 2 && object(data.result), 'The demo returned an incompatible language contract.');
    return { elapsedMs: performance.now() - started, engineMs: data.diagnostics?.latencyMs ?? null, envelope: data, rules: ruleEvidence(data), flow: languageFlow(data) };
  }
  const server = createServer(async (req, res) => {
    const headers = { 'cache-control':'no-store', 'x-content-type-options':'nosniff', 'x-frame-options':'DENY', 'referrer-policy':'no-referrer', 'x-robots-tag':'noindex, nofollow', 'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
    const send = (status, data, extra = {}) => { if (!res.destroyed) { res.writeHead(status, {...headers, 'content-type':'application/json; charset=utf-8', ...extra}); res.end(JSON.stringify(data)); } };
    const controller = new AbortController(); res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const url = new URL(req.url, config.origin), path = url.pathname;
      if (req.method === 'GET' && path === '/health') return send(200, {status:'ok', service:'rengine'});
      if (req.method === 'GET' && path === '/api/config') return send(200, {stores:Object.keys(config.stores), version:'1.1.0',savedConnections:!!vault,operatorStore:vault?config.ownerStore:null});
      if (!['GET','POST'].includes(req.method)) throw new Failure(405, 'Method not allowed.');
      if (req.method === 'POST') {
        if (req.headers['x-rengine-request'] !== '1' || (req.headers.origin && req.headers.origin !== config.origin) || req.headers['sec-fetch-site'] === 'cross-site') throw new Failure(403, 'Same-origin request required.');
      }
      if (req.method === 'POST' && path === '/api/login') {
        // Remote address is trusted only from the directly attached Nginx listener.
        const peer = req.socket.remoteAddress ?? 'unknown';
        const attempts = loginAttempts.get(peer) ?? {count:0, until:Date.now()+60000};
        if (attempts.until < Date.now()) {attempts.count=0; attempts.until=Date.now()+60000;}
        if (++attempts.count > 20) throw new Failure(429, 'Too many sign-in attempts. Try again in a minute.');
        loginAttempts.set(peer, attempts);
        const input = await body(req); input.store ??= vault ? config.ownerStore : undefined; const store = Object.hasOwn(config.stores, input.store) ? config.stores[input.store] : null;
        ensure(store && typeof input.email === 'string' && input.email.length <= 254 && typeof input.password === 'string' && input.password.length <= 256, 'Choose a demo and enter your administrator credentials.');
        const { response, data } = await upstream(store.gateway, '/v1/admin/auth/login', {method:'POST',payload:{email:input.email,password:input.password}});
        const cookie = response.headers.getSetCookie().find(value => value.startsWith('admin_session='))?.split(';')[0];
        if (!cookie) throw new Failure(502, 'Demo login did not issue a session.');
        if (!data.permissions?.some(p => p === '*' || p === 'assistant.tracking.read')) {
          await upstream(store.gateway, '/v1/admin/auth/logout', {method:'POST',payload:{},cookie}).catch(()=>{});
          throw new Failure(403, 'Assistant tracking permission is required.');
        }
        let previous; try { previous = identity(req); } catch { /* New browser session. */ }
        if (sessions.size >= 200 && !previous) throw new Failure(503, 'Session capacity reached. Try again later.');
        if (previous?.session.busy) throw new Failure(409, 'Wait for your current evaluation to finish before connecting a demo.');
        const token = randomBytes(32).toString('hex');
        const session = previous?.session ?? {stores:{},expires:Date.now()+SESSION_MS,busy:false};
        session.expires = Date.now() + SESSION_MS;
        session.stores[input.store] = {cookie, name:data.user?.name ?? 'Operator'};
        if(vault && input.store===config.ownerStore && input.email.toLowerCase()===config.ownerEmail && data.permissions.includes('*')){session.owner=true;session.ownerCookie=cookie;session.ownerCredentials={email:input.email,password:input.password};session.expires=Date.now()+REMEMBER_MS;attachSaved(session);}
        const id=sessionKey(token);
        if(session.owner)remembered?.set(id,session);
        if (previous) {remembered?.remove(previous.token);sessions.delete(previous.token);} sessions.set(id, session);
        return send(200, {operator:!!session.owner,stores:Object.keys(session.stores),store:input.store,name:session.stores[input.store].name}, {'set-cookie':sessionCookie(token, Math.floor((session.expires-Date.now())/1000))});
      }
      if (req.method === 'GET' && path === '/api/session') { const {session} = identity(req); if(session.owner){await owner(req);attachSaved(session);}return send(200,{operator:!!session.owner,stores:Object.keys(session.stores)}); }
      if (req.method === 'POST' && path === '/api/logout') {
        const {token, session} = identity(req); remembered?.remove(token);sessions.delete(token);
        await Promise.allSettled(Object.entries(session.stores).filter(([,admin])=>admin.cookie).map(([name, admin]) => upstream(config.stores[name].gateway,'/v1/admin/auth/logout',{method:'POST',payload:{},cookie:admin.cookie})));
        if(session.ownerCookie && !Object.values(session.stores).some(admin=>admin.cookie===session.ownerCookie))await upstream(config.stores[config.ownerStore].gateway,'/v1/admin/auth/logout',{method:'POST',payload:{},cookie:session.ownerCookie}).catch(()=>{});
        return send(200,{status:'signed_out'},{'set-cookie':sessionCookie('',0)});
      }
      if(path==='/api/connections') {
        const session=await owner(req);
        if(req.method==='POST') {
          const input=await body(req);
          ensure(Object.hasOwn(config.stores,input.store),'Choose a configured demo.');
          if(input.action==='remove') {
            vault.remove(input.store);
            for(const current of sessions.values())if(current.owner){delete current.stores[input.store];current.pages?.clear();}
          } else {
            ensure(input.action==='save' && typeof input.email==='string' && input.email.length>0 && input.email.length<=254 && typeof input.password==='string' && input.password.length>0 && input.password.length<=256,'Enter an administrator email and password.');
            let admin;try{admin=await demoLogin(input.store,input);}catch(error){if(error.status===401)throw new Failure(400,'Demo credentials were rejected. Check the email and password.');throw error;}
            try{vault.set(input.store,input.email,input.password);}catch(error){await upstream(config.stores[input.store].gateway,'/v1/admin/auth/logout',{method:'POST',payload:{},cookie:admin.cookie}).catch(()=>{});throw error;}
            for(const current of sessions.values())if(current.owner){current.stores[input.store]={saved:true};current.pages?.clear();}
            session.stores[input.store]={...admin,saved:true};
          }
        }
        return send(200,{connections:vault.list(),stores:Object.keys(session.stores)});
      }
      if(req.method==='GET' && path==='/api/all-traces') {
        const {session}=identity(req);if(session.owner){await owner(req);attachSaved(session);}
        const input=Object.fromEntries(url.searchParams), params=new URLSearchParams({limit:'25',hours:['24','72','168'].includes(input.hours)?input.hours:'24'});
        if(input.outcome){ensure(['completed','unavailable','disconnected','denied'].includes(input.outcome),'Invalid outcome.');params.set('outcome',input.outcome);}
        if(input.request_id){ensure(uuid.test(input.request_id),'Invalid request ID.');params.set('request_id',input.request_id);}
        if(input.demo)ensure(Object.hasOwn(session.stores,input.demo),'Demo is not connected.');
        const selected=input.demo?[input.demo]:Object.keys(session.stores), signature=JSON.stringify([selected,params.toString()]);
        session.pages??=new Map();
        const previous=input.cursor?session.pages.get(input.cursor):null;
        ensure(!input.cursor || previous?.signature===signature,'History page expired. Refresh the list.');
        const next=structuredClone(previous?.states??Object.fromEntries(selected.map(name=>[name,{buffer:[],cursor:null,done:false}])));
        const demos=await Promise.all(selected.map(async name=>{
          const state=next[name];
          try {
            const {store,admin}=await authorize(req,name);
            if(state.buffer.length<25&&!state.done){
              const query=new URLSearchParams(params);if(state.cursor)query.set('cursor',state.cursor);
              const {data}=await upstream(store.gateway,'/v1/admin/assistant/tracking?'+query,{cookie:admin.cookie});
              ensure(Array.isArray(data.items)&&data.items.length<=25,'Invalid history response.');
              state.buffer.push(...data.items.map(row=>({request_id:row.request_id,created_at:row.created_at,question_preview:String(row.question_preview??'').slice(0,500),intent:row.intent,route:row.route,outcome:row.outcome,latency_ms:row.latency_ms,model_calls:row.model_calls,report_available:row.report_available,store:name})));state.cursor=data.next_cursor;state.done=!data.next_cursor;
              state.capture_enabled=data.capture_enabled;state.retention_days=data.retention_days;
            }
            return {store:name,capture_enabled:state.capture_enabled,retention_days:state.retention_days};
          }catch(error){return {store:name,error:error instanceof Failure?error.message:'Demo unavailable.',status:error.status??502};}
        }));
        const available=new Set(demos.filter(demo=>!demo.error).map(demo=>demo.store));
        const items=Object.entries(next).filter(([name])=>available.has(name)).flatMap(([,state])=>state.buffer).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)||String(b.request_id).localeCompare(String(a.request_id))||a.store.localeCompare(b.store)).slice(0,25);
        for(const row of items){const buffer=next[row.store].buffer;buffer.splice(buffer.indexOf(row),1);}
        let cursor=null;
        if(items.length&&Object.values(next).some(state=>state.buffer.length||!state.done)){
          cursor=randomBytes(16).toString('hex');session.pages.set(cursor,{signature,states:next});
          while(session.pages.size>12)session.pages.delete(session.pages.keys().next().value);
        }
        return send(200,{items,next_cursor:cursor,demos});
      }
      if(req.method === 'GET' && path === '/api/live') {
        const {session}=identity(req);if(session.owner){await owner(req);attachSaved(session);}
        let cursors;try{cursors=JSON.parse(url.searchParams.get('cursors')??'{}');}catch{throw new Failure(400,'Invalid live cursors.');}
        ensure(object(cursors)&&Object.keys(cursors).every(name=>Object.hasOwn(session.stores,name)&&typeof cursors[name]==='string'&&/^[0-9a-f-]{36}:[0-9]{1,16}$/i.test(cursors[name])), 'Invalid live cursors.');
        if(session.liveBusy||activeLive>=4)throw new Failure(429,'Live watchers are busy. Retrying shortly.');
        session.liveBusy=true;activeLive++;
        try{
          const batches=await Promise.all(Object.keys(session.stores).map(async name=>{
            try{
              const {store,admin}=await authorize(req,name);
              const query=cursors[name]?'?'+new URLSearchParams({cursor:cursors[name]}):'';
              const {data}=await upstream(store.gateway,'/v1/admin/assistant/tracking/live'+query,{cookie:admin.cookie,signal:controller.signal,timeout:7000});
              ensure(Array.isArray(data.events)&&data.events.length<=128&&typeof data.cursor==='string','Invalid live feed response.');
              const events=data.events.map(event=>{
                if(event.kind!=='stage')return event;
                const journey=customerJourney({request_id:event.request_id,events:[event.data]});
                return {sequence:event.sequence,request_id:event.request_id,kind:'stage',step:journey.steps[0],sources:journey.sources};
              });
              return {store:name,cursor:data.cursor,reset:data.reset,capture_enabled:data.capture_enabled,events};
            }catch(error){return {store:name,error:error instanceof Failure?error.message:'Live feed unavailable.',status:error.status??502};}
          }));
          return send(200,{batches});
        }finally{session.liveBusy=false;activeLive--;}
      }
      if (path.startsWith('/api/')) {
        const input = req.method === 'POST' ? await body(req) : Object.fromEntries(url.searchParams);
        const {session,store,admin,canExport} = await authorize(req,input.store);
        if (req.method === 'GET' && path === '/api/status') {
          const checks = await Promise.allSettled([upstream(store.language,'/api/ready'),upstream(store.assistant,'/ready'),upstream(store.gateway,'/v1/market')]);
          return send(200,{store:store.name, checkedAt:new Date().toISOString(), currency:checks[2].status==='fulfilled' && /^[A-Z]{3}$/.test(checks[2].value.data.currency??'') ? checks[2].value.data.currency : null, language: checks[0].status === 'fulfilled' ? {ready:true,...checks[0].value.data} : {ready:false,error:checks[0].reason.message}, assistant:checks[1].status === 'fulfilled' ? {ready:true} : {ready:false,error:checks[1].reason.message}});
        }
        if (req.method === 'POST' && path === '/api/resolve') return send(200, await bounded(session,()=>resolve(store,input,controller.signal)));
        if (req.method === 'POST' && path === '/api/benchmark') {
          ensure(Array.isArray(input.cases) && input.cases.length >= 1 && input.cases.length <= 20, 'Use 1–20 cases.');
          const iterations = input.iterations ?? 1; ensure(Number.isInteger(iterations) && iterations >= 1 && iterations <= 3, 'Use 1–3 repetitions.');
          input.cases.forEach(validateCase);
          const result = await bounded(session,async()=>{
            const rows=[]; const started=performance.now(); const provenances=new Map();
            const deadline=AbortSignal.any([controller.signal,AbortSignal.timeout(90000)]);
            for(let iteration=0; iteration<iterations; iteration++) for(let index=0; index<input.cases.length;index++) {
              if(deadline.aborted) throw new Failure(408,'Evaluation cancelled or exceeded the 90-second limit.');
              const item=input.cases[index];
              try {
                const resolved=await resolve(store,item,deadline); const result=resolved.envelope.result;
                const checked = item.expectedIntent !== undefined || item.expectedStatus !== undefined;
                const matched=checked ? (item.expectedIntent === undefined || result.intent === item.expectedIntent) && (item.expectedStatus === undefined || result.status === item.expectedStatus) : null;
                const provenance=resolved.envelope.provenance; provenances.set(JSON.stringify(provenance),provenance);
                rows.push({index,iteration,text:item.text,expectedIntent:item.expectedIntent,expectedStatus:item.expectedStatus,ok:true,matched,intent:result.intent,status:result.status,confidence:result.confidence,elapsedMs:resolved.elapsedMs,engineMs:resolved.engineMs});
              } catch(error) { rows.push({index,iteration,text:item.text,expectedIntent:item.expectedIntent,expectedStatus:item.expectedStatus,ok:false,matched:item.expectedIntent!==undefined||item.expectedStatus!==undefined?false:null,error:error instanceof Failure ? error.message : 'Evaluation failed.'}); }
              await new Promise(r=>setTimeout(r,250));
            }
            return {store:store.name, createdAt:new Date().toISOString(), scope:'Sequential language requests; includes network overhead and pacing, not maximum throughput.',provenances:[...provenances.values()],mixedRelease:provenances.size>1,rows,summary:summary(rows,performance.now()-started)};
          });return send(200,result);
        }
        if(req.method === 'POST' && path === '/api/assistant') {
          validateCase(input);
          // Deliberately forward no shopper identity or mutation payload. Guest
          // admission remains enforced by the real gateway and assistant.
          return send(200,await bounded(session,async()=>{
            const requestId=randomUUID(),started=performance.now();
            const response=await fetcher(store.gateway+'/v1/assistant/chat',{method:'POST',redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(50000)]),headers:{'content-type':'application/json','x-commerce-request':'1',accept:'text/event-stream'},body:JSON.stringify({request_id:requestId,message:input.text})});
            if(!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {await response.body?.cancel();throw new Failure(502,`Assistant request failed (${response.status}).`);}
            const reader=response.body.getReader(),decoder=new TextDecoder(),events=[];let buffer='',size=0,firstEventMs=null,firstTextMs=null;
            try { while(true) {const {done,value}=await reader.read();if(done) break; size+=value.length;if(size>MAX_RESPONSE)throw new Failure(502,'Assistant capture limit reached.');buffer+=decoder.decode(value,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');let end;
              while((end=buffer.indexOf('\n\n'))>=0){const event=parseSSEFrame(buffer.slice(0,end));buffer=buffer.slice(end+2);if(!event)continue;const atMs=performance.now()-started;firstEventMs??=atMs;if(event.type==='message.delta')firstTextMs??=atMs;events.push({...event,atMs});}
            }}finally{await reader.cancel();}
            const elapsedMs=performance.now()-started,doneMs=events.find(event=>event.type==='done')?.atMs??null;
            return {requestId,store:store.name,identity:'guest',events,elapsedMs,doneMs,postDoneMs:doneMs===null?null:Math.max(0,elapsedMs-doneMs),firstEventMs,firstTextMs,completed:events.some(e=>e.type==='done')&&!events.some(e=>e.type==='error'),scope:'Live guest assistant. Customer-only actions require sign-in; no shopper credentials are forwarded.'};
          }));
        }
        if(path === '/api/tracking-settings' && ['GET','POST'].includes(req.method)) {
          const writing=req.method === 'POST';
          if(writing)ensure(typeof input.enabled === 'boolean' && Object.keys(input).every(key=>['store','enabled'].includes(key)), 'Use a boolean enabled setting.');
          const {data}=await upstream(store.gateway,'/v1/admin/assistant/tracking/settings',{method:writing?'PUT':'GET',...(writing?{payload:{enabled:input.enabled}}:{}),cookie:admin.cookie});
          return send(200,data);
        }
        if(req.method === 'GET' && path === '/api/traces') {
          const params=new URLSearchParams({limit:'25',hours:['24','72','168'].includes(input.hours)?input.hours:'24'});
          if(input.outcome) {ensure(['completed','unavailable','disconnected','denied'].includes(input.outcome),'Invalid outcome.');params.set('outcome',input.outcome);}
          if(input.cursor) {ensure(input.cursor.length<=100,'Invalid cursor.');params.set('cursor',input.cursor);}
          if(input.request_id) {ensure(uuid.test(input.request_id),'Invalid request ID.');params.set('request_id',input.request_id);}
          const {data}=await upstream(store.gateway,'/v1/admin/assistant/tracking?'+params,{cookie:admin.cookie});return send(200,{...data,can_export:canExport});
        }
        if(req.method === 'GET' && path === '/api/trace-export') {
          ensure(uuid.test(input.id ?? ''),'Invalid request ID.');
          if(!canExport)throw new Failure(403,'Assistant tracking export permission is required.');
          const {data}=await upstream(store.gateway,'/v1/admin/assistant/tracking/'+input.id+'/export',{cookie:admin.cookie});
          return send(200,data,{'content-disposition':`attachment; filename="rengine-${input.store}-${input.id}.json"`});
        }
        if(req.method === 'GET' && (path === '/api/trace' || path === '/api/journey')) {
          ensure(uuid.test(input.id ?? ''),'Invalid request ID.');
          const {data}=await upstream(store.gateway,'/v1/admin/assistant/tracking/'+input.id,{cookie:admin.cookie});return send(200,path === '/api/journey' ? customerJourney(data) : {...data,can_export:canExport,journey:customerJourney(data)});
        }
        throw new Failure(404,'Not found.');
      }
      const files={'/brand/rocento-logo.png':['brand/rocento-logo.png','image/png'],'/trace-navigation.js':['trace-navigation.js','text/javascript'],'/trace-diagnostics.js':['trace-diagnostics.js','text/javascript'],'/demo-examples.js':['demo-examples.js','text/javascript'],'/fonts/source-sans-3.woff2':['fonts/source-sans-3.woff2','font/woff2'],'/fonts/LICENSE.md':['fonts/LICENSE.md','text/plain'],'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/journey-presentation.js':['journey-presentation.js','text/javascript'],'/journey.js':['journey.js','text/javascript'],'/style.css':['style.css','text/css'],'/favicon.svg':['favicon.svg','image/svg+xml'],'/favicon.ico':['favicon.ico','image/x-icon'],'/brand/rocento-icon-96.webp':['brand/rocento-icon-96.webp','image/webp']};
      if(req.method!=='GET'||!files[path]) throw new Failure(404,'Not found.');
      const [file,type]=files[path];res.writeHead(200,{...headers,'content-type':type+'; charset=utf-8'});res.end(await readFile(new URL('./public/'+file,import.meta.url)));
    } catch(error) {send(error instanceof Failure ? error.status : 502,{error:error instanceof Failure ? error.message : 'Request failed or timed out. Please retry.'});}
  });
  server.requestTimeout=15000; server.headersTimeout=10000;
  const cleanup=setInterval(()=>{
    for(const [token,session] of sessions)if(session.expires<Date.now()&&!session.busy)sessions.delete(token);
    try{remembered?.prune();}catch{/* A failed disk cleanup does not make expired sessions valid. */}
    for(const [peer,attempts] of loginAttempts)if(attempts.until<Date.now())loginAttempts.delete(peer);
  },60000);cleanup.unref();server.on('close',()=>clearInterval(cleanup));
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config=configuration(),server=createApp(config);
  server.listen(config.port,config.host,()=>console.log(`rengine listening on ${config.host}:${config.port}`));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.close();setTimeout(()=>process.exit(0),55000).unref();});
}
