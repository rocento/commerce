import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { configuration } from '../config.mjs';
import { languageFlow, percentile, summary, parseSSEFrame } from '../analysis.mjs';
const envelope={contractVersion:2,provenance:{releaseId:'release-1'},result:{status:'RESOLVED',intent:'VIEW_CART',confidence:1,requestedActions:[{intent:'VIEW_CART'}],context:{next:{previousIntent:'VIEW_CART'}}},diagnostics:{text:'show my cart',normalizedText:'show my cart',latencyMs:0.5,matchedSemanticGroups:['cart'],debug:{candidates:[{intent:'VIEW_CART',score:90,rule:'cart_read',evidence:[{group:'cart'}]}]}}};
async function fixture(t, override) {
 const calls=[];
 const config=configuration({PORT:'3190',RENGINE_ORIGIN:'http://localhost:3190'});
 const fetcher=async(url,options={})=>{
  calls.push({url,options}); const path=new URL(url).pathname;
  const custom=await override?.(url,options);if(custom)return custom;
  const json=value=>Response.json(value);
  if(path==='/v1/admin/auth/login')return new Response(JSON.stringify({user:{name:'Test'},permissions:['assistant.tracking.read']}),{headers:{'content-type':'application/json','set-cookie':'admin_session=secret-session; HttpOnly; Path=/'}});
  if(path==='/v1/admin/auth/logout')return json({status:'ok'});
  if(path==='/v1/admin/me')return json({permissions:['assistant.tracking.read']});
  if(path==='/api/resolve')return json(envelope);
  if(path==='/api/ready'||path==='/ready')return json({status:'ok'});
  if(path==='/v1/admin/assistant/tracking')return json({items:[],next_cursor:null,capture_enabled:true,retention_days:7});
  if(path==='/v1/assistant/chat')return new Response('event: message.delta\ndata: {"type":"message.delta","text":"Hello"}\n\nevent: done\ndata: {"type":"done"}\n\n',{headers:{'content-type':'text/event-stream'}});
  return json({});
 };
 const server=createApp(config,fetcher);server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const base=`http://127.0.0.1:${server.address().port}`;
 let cookie='';
 const request=async(path,input,headers={})=>fetch(base+path,{method:input===undefined?'GET':'POST',headers:{cookie,'x-rengine-request':'1','content-type':'application/json',...headers},...(input===undefined?{}:{body:JSON.stringify(input)})});
 const login=async(store='grocery')=>{const response=await request('/api/login',{store,email:'operator@example.test',password:'never-store-this'});cookie=response.headers.get('set-cookie')?.split(';')[0]??'';return response;};
 return {request,login,calls};
}
test('status reads the selected store currency and tolerates unavailable market metadata',async t=>{
 let currency='USD',unavailable=false;
 const f=await fixture(t,url=>new URL(url).pathname==='/v1/market'?Response.json(unavailable?{}:{currency},{status:unavailable?503:200}):null);
 await f.login();
 for(const expected of ['USD','EGP']) {
  currency=expected;
  const data=await(await f.request('/api/status?store=grocery')).json();
  assert.equal(data.currency,expected);
  assert.equal(data.language.ready,true);
 }
 unavailable=true;
 const data=await(await f.request('/api/status?store=grocery')).json();
 assert.equal(data.currency,null);
 assert.equal(data.assistant.ready,true);
 assert.equal((await f.request('/demo-examples.js')).status,200);
});
test('all sensitive endpoints require authentication, while health and static shell are public',async t=>{const f=await fixture(t);assert.equal((await f.request('/health')).status,200);assert.equal((await f.request('/')).status,200);for(const path of ['/api/status?store=grocery','/api/traces?store=grocery','/api/journey?store=grocery&id=10000000-0000-4000-8000-000000000001','/api/session'])assert.equal((await f.request(path)).status,401);assert.equal((await f.request('/api/resolve',{store:'grocery',text:'hello'})).status,401);assert.equal(f.calls.length,0);});
test('login isolates demo authorization, validates permission on every request, never returns gateway cookies',async t=>{let revoke=false;const f=await fixture(t,(url)=>new URL(url).pathname==='/v1/admin/me'&&revoke?Response.json({permissions:[]}):null);const login=await f.login();assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);assert.doesNotMatch(await login.text(),/secret-session|never-store/);assert.equal((await f.request('/api/status?store=jewelry')).status,401);assert.equal((await f.request('/api/status?store=grocery')).status,200);revoke=true;assert.equal((await f.request('/api/resolve',{store:'grocery',text:'show my cart'})).status,403);});
test('CSRF, unknown stores, malformed bodies and arbitrary URLs are rejected',async t=>{const f=await fixture(t);assert.equal((await f.request('/api/login',{store:'grocery'}, {origin:'https://attacker.test'})).status,403);assert.equal((await f.request('/api/login',{store:'grocery'}, {'x-rengine-request':''})).status,403);assert.equal((await f.login('__proto__')).status,400);await f.login();assert.equal((await f.request('/api/resolve',{store:'https://attacker.test',text:'hello'})).status,401);assert.equal((await f.request('/api/resolve',{store:'grocery',text:'x'.repeat(4001)})).status,400);assert.equal((await f.request('/api/resolve',{store:'grocery',text:'hello',context:[]})).status,400);assert.equal((await f.request('/api/benchmark',{store:'grocery',cases:Array(21).fill({text:'hi'})})).status,400);assert.equal(f.calls.some(c=>c.url.includes('attacker')),false);});
test('language forwards a closed request and presents actual evidence',async t=>{const f=await fixture(t);await f.login();const response=await f.request('/api/resolve',{store:'grocery',text:'show my cart',url:'http://attacker',contractVersion:1});assert.equal(response.status,200);const data=await response.json();assert.equal(data.engineMs,0.5);assert.equal(data.flow[3].data.candidates[0].rule,'cart_read');const call=f.calls.find(c=>c.url.endsWith('/api/resolve'));assert.deepEqual(JSON.parse(call.options.body),{text:'show my cart',context:{},contractVersion:2});assert.equal(call.options.headers.cookie,undefined);});
test('benchmark distinguishes expectations from resolution and reports release identity',async t=>{const f=await fixture(t);await f.login();const response=await f.request('/api/benchmark',{store:'grocery',cases:[{text:'one',expectedIntent:'VIEW_CART'},{text:'two',expectedIntent:'OTHER'},{text:'three'}],iterations:1});assert.equal(response.status,200);const data=await response.json();assert.equal(data.summary.accuracy,0.5);assert.equal(data.summary.evaluated,2);assert.equal(data.summary.resolved,3);assert.equal(data.rows[2].matched,null);assert.equal(data.provenances[0].releaseId,'release-1');});
test('assistant calls real guest entry point without admin, shopper or action credentials',async t=>{const f=await fixture(t);await f.login();const response=await f.request('/api/assistant',{store:'grocery',text:'hello',ticket:{subject:'no'},authorization:'no'});const data=await response.json();assert.equal(response.status,200);assert.equal(data.completed,true);assert.equal(data.events.length,2);assert.ok(data.firstTextMs>=0);const call=f.calls.find(c=>c.url.endsWith('/v1/assistant/chat'));assert.equal(call.options.headers.cookie,undefined);assert.equal(call.options.headers.authorization,undefined);assert.deepEqual(Object.keys(JSON.parse(call.options.body)).sort(),['message','request_id']);});
test('logout revokes all connected upstream sessions and the local token',async t=>{const f=await fixture(t);await f.login();await f.login('jewelry');assert.deepEqual((await(await f.request('/api/session')).json()).stores,['grocery','jewelry']);assert.equal((await f.request('/api/logout',{})).status,200);assert.equal((await f.request('/api/session')).status,401);assert.equal(f.calls.filter(c=>c.url.endsWith('/v1/admin/auth/logout')).length,2);});
test('trace routes preserve backend audit path and validate IDs',async t=>{const f=await fixture(t);await f.login();assert.equal((await f.request('/api/traces?store=grocery&hours=24')).status,200);const call=f.calls.find(c=>c.url.includes('/v1/admin/assistant/tracking'));assert.equal(call.options.headers.cookie,'admin_session=secret-session');assert.equal((await f.request('/api/trace?store=grocery&id=../../secret')).status,400);});
test('nearest rank latency statistics exclude failures, never invent accuracy',()=>{assert.equal(percentile([40,10,30,20],50),20);assert.equal(percentile([],95),null);const s=summary([{ok:true,elapsedMs:10,matched:null},{ok:false,elapsedMs:100}],1000);assert.equal(s.p95Ms,10);assert.equal(s.accuracy,null);assert.equal(s.failed,1);});
test('flow is a projection of exposed evidence and SSE parsing supports multiline data',()=>{assert.equal(languageFlow(envelope).length,6);assert.equal(languageFlow(envelope)[2].data.groups[0],'cart');assert.equal(parseSSEFrame(': keepalive'),null);assert.deepEqual(parseSSEFrame('event: done\ndata: {\ndata: "ok":true}'),{type:'done',data:{ok:true}});assert.throws(()=>parseSSEFrame('data: bad'));});
test('configuration accepts only operator-configured origins',()=>{assert.throws(()=>configuration({RENGINE_GROCERY_GATEWAY:'file:///etc/passwd'}));assert.throws(()=>configuration({RENGINE_ORIGIN:'https://example.test/path'}));assert.equal(configuration({RENGINE_ORIGIN:'https://rengine.rocento.com'}).secure,true);});

test('failed expected cases count against accuracy and do not contaminate latency percentiles',()=>{
 const stats=summary([{ok:true,elapsedMs:10,matched:true},{ok:false,matched:false}],100);
 assert.equal(stats.accuracy,0.5);assert.equal(stats.evaluated,2);assert.equal(stats.p95Ms,10);
});

test('journey uses scoped audited trace reads and rejects source path parameters',async t=>{
 const f=await fixture(t,(url)=>new URL(url).pathname.endsWith('/tracking/10000000-0000-4000-8000-000000000001')?Response.json({request_id:'10000000-0000-4000-8000-000000000001',events:[{stage:'final_result',data:{answer:'hi'}}]}):null);
 await f.login();assert.equal((await f.request('/api/journey?store=jewelry&id=10000000-0000-4000-8000-000000000001')).status,401);
 assert.equal((await f.request('/api/journey?store=grocery&id=../../etc/passwd')).status,400);
 const response=await f.request('/api/journey?store=grocery&id=10000000-0000-4000-8000-000000000001');assert.equal(response.status,200);const data=await response.json();assert.equal(data.steps[0].evidence.answer,'hi');assert.equal(data.instrumented,false);
 assert.equal(f.calls.find(c=>c.url.endsWith('/tracking/10000000-0000-4000-8000-000000000001')).options.headers.cookie,'admin_session=secret-session');
 assert.equal((await f.request('/rulebook.json')).status,404);
});

test('capture controls require a demo login and forward only the boolean setting',async t=>{
 let enabled=true,deny=false;
 const f=await fixture(t,(url,options)=>{
  if(new URL(url).pathname!=='/v1/admin/assistant/tracking/settings')return null;
  if(options.method==='PUT'){if(deny)return Response.json({error:'forbidden'},{status:403});enabled=JSON.parse(options.body).enabled;}
  return Response.json({enabled,editable:!deny,source:'saved'});
 });
 assert.equal((await f.request('/api/tracking-settings?store=grocery')).status,401);
 await f.login();assert.equal((await f.request('/api/tracking-settings?store=jewelry')).status,401);
 assert.equal((await f.request('/api/tracking-settings',{store:'grocery',enabled:'false'})).status,400);
 assert.equal((await f.request('/api/tracking-settings',{store:'grocery',enabled:false,path:'/etc/passwd'})).status,400);
 assert.equal((await(await f.request('/api/tracking-settings',{store:'grocery',enabled:false})).json()).enabled,false);
 const call=f.calls.find(c=>c.url.endsWith('/tracking/settings')&&c.options.method==='PUT');assert.deepEqual(JSON.parse(call.options.body),{enabled:false});assert.equal(call.options.headers.cookie,'admin_session=secret-session');
 deny=true;assert.equal((await f.request('/api/tracking-settings',{store:'grocery',enabled:true})).status,403);assert.equal(enabled,false);
});

test('trace filters validate outcomes and preserve request, period and cursor',async t=>{
 const f=await fixture(t);await f.login();
 const id='10000000-0000-4000-8000-000000000001';
 const response=await f.request(`/api/traces?store=grocery&hours=72&outcome=denied&request_id=${id}&cursor=next`);
 assert.equal(response.status,200);assert.equal((await response.json()).can_export,false);
 const call=f.calls.find(c=>c.url.includes('/tracking?'));const params=new URL(call.url).searchParams;
 assert.equal(params.get('outcome'),'denied');assert.equal(params.get('request_id'),id);assert.equal(params.get('cursor'),'next');assert.equal(params.get('hours'),'72');
 assert.equal((await f.request('/api/traces?store=grocery&outcome=made-up')).status,400);
});
test('exports require their own permission, preserve backend audit and reject failed reports',async t=>{
 let permission=false,status=200;
 const id='10000000-0000-4000-8000-000000000001';
 const f=await fixture(t,url=>{
  const path=new URL(url).pathname;
  if(path==='/v1/admin/me')return Response.json({permissions:permission?['assistant.tracking.read','assistant.tracking.export']:['assistant.tracking.read']});
  if(path.endsWith('/export'))return Response.json(status===200?{request_id:id,events:[],redacted:true}:{error:'Unavailable'},{status});
 });
 const route=`/api/trace-export?store=grocery&id=${id}`;
 assert.equal((await f.request(route)).status,401);await f.login();
 assert.equal((await f.request(route)).status,403);assert.equal(f.calls.some(c=>c.url.endsWith('/export')),false);
 permission=true;assert.equal((await f.request(route.replace('grocery','jewelry'))).status,401);
 const response=await f.request(route);assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/attachment/);assert.equal((await response.json()).request_id,id);
 const call=f.calls.find(c=>c.url.endsWith('/export'));assert.equal(new URL(call.url).pathname,`/v1/admin/assistant/tracking/${id}/export`);assert.equal(call.options.headers.cookie,'admin_session=secret-session');assert.equal(call.options.headers.authorization,undefined);
 for(status of [403,404,503]){const failure=await f.request(route);assert.equal(failure.status,status===503?502:status);assert.equal(failure.headers.get('content-disposition'),null);}
 permission=false;assert.equal((await f.request(route)).status,403);
});

test('live feed multiplexes only authorized demos and preserves execution identities',async t=>{
 let revoke=false;
 const cursor='10000000-0000-4000-8000-000000000001:1', id='20000000-0000-4000-8000-000000000001';
 const f=await fixture(t,url=>{
  const path=new URL(url).pathname;
  if(path==='/v1/admin/me'&&revoke&&new URL(url).port==='58080')return Response.json({permissions:[]});
  if(path==='/v1/admin/assistant/tracking/live')return Response.json({cursor,reset:false,capture_enabled:true,events:[{sequence:1,request_id:id,kind:'stage',data:{stage:'python_function_start',data:{function:'resolve',callId:1,outcome:'running',_journey:{atMs:1,startMs:1,sourceId:'source',function:{id:'source',source:'def resolve(): pass'}}}}}]});
 });
 assert.equal((await f.request('/api/live')).status,401);await f.login();await f.login('jewelry');
 const batch=await(await f.request('/api/live')).json();assert.deepEqual(batch.batches.map(b=>b.store),['grocery','jewelry']);assert.equal(batch.batches[0].events[0].step.kind,'python');assert.equal(batch.batches[0].events[0].step.evidence.outcome,'running');assert.equal(batch.batches[0].events[0].sources.source.source,'def resolve(): pass');
 assert.equal((await f.request('/api/live?cursors='+encodeURIComponent(JSON.stringify({pharmacy:cursor})))).status,400);
 assert.equal((await f.request('/api/live?cursors=bad')).status,400);
 revoke=true;const denied=await(await f.request('/api/live?cursors='+encodeURIComponent(JSON.stringify({grocery:cursor,jewelry:cursor})))).json();assert.equal(denied.batches[0].events.length,1);assert.equal(denied.batches[1].status,403);assert.equal(denied.batches[1].events,undefined);
 const call=f.calls.find(c=>c.url.includes('/tracking/live?'));assert.equal(new URL(call.url).searchParams.get('cursor'),cursor);assert.equal(call.options.headers.cookie,'admin_session=secret-session');
});

// Keep EOF latency intact: persistence can continue after the shopper's done event.
test('assistant distinguishes done from delayed stream EOF',async t=>{
 const encoder=new TextEncoder();
 const f=await fixture(t,url=>new URL(url).pathname==='/v1/assistant/chat'?new Response(new ReadableStream({
  start(controller){
   controller.enqueue(encoder.encode('event: done\ndata: {"type":"done"}\n\n'));
   setTimeout(()=>controller.close(),80);
  }
 }),{headers:{'content-type':'text/event-stream'}}):null);
 await f.login();
 const response=await f.request('/api/assistant',{store:'grocery',text:'show me milk'});
 assert.equal(response.status,200);
 const data=await response.json();
 assert.equal(data.completed,true);
 assert.equal(data.doneMs,data.events.find(event=>event.type==='done').atMs);
 assert.ok(data.postDoneMs>=50);
 assert.equal(data.elapsedMs,data.doneMs+data.postDoneMs);
});
test('assistant without done does not invent completion timing',async t=>{
 const f=await fixture(t,url=>new URL(url).pathname==='/v1/assistant/chat'?new Response('event: error\ndata: {"type":"error","code":"unavailable"}\n\n',{headers:{'content-type':'text/event-stream'}}):null);
 await f.login();
 const data=await(await f.request('/api/assistant',{store:'grocery',text:'show me milk'})).json();
 assert.equal(data.completed,false);
 assert.equal(data.doneMs,null);
 assert.equal(data.postDoneMs,null);
});
