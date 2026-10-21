import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';

test('HTTP context round trip binds the same request and rejects malformed context', {timeout:15000}, async()=>{
 const child=spawn(process.execPath,['src/server.ts'],{cwd:new URL('../',import.meta.url),env:{...process.env,PORT:'0',HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
 try {
  const url=await new Promise<string>((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('engine startup timed out')),5000);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);reject(new Error(`engine exited ${code}`));});child.stdout.on('data',chunk=>{output+=String(chunk);const match=/http:\/\/127\.0\.0\.1:\d+/.exec(output);if(match){clearTimeout(timer);resolve(match[0]);}});});
  const call=(text:string,context:unknown={})=>fetch(url+'/api/resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,context}),signal:AbortSignal.timeout(3000)});
  const readiness=await fetch(url+'/api/ready');
  assert.equal(readiness.status,200);assert.equal((await readiness.json()).resolutionContractVersion,1);
  const health=await fetch(url+'/api/health');
  assert.equal(health.status,200);assert.equal((await health.json()).resolutionContractVersion,1);
  const traceContext=`1/${randomUUID()}/span-1`;
  const traced=await fetch(url+'/api/resolve',{method:'POST',headers:{'content-type':'application/json','x-commerce-trace-request':traceContext},body:JSON.stringify({text:'show my cart',contractVersion:2})});
  assert.equal(traced.status,200);assert.ok(traced.headers.get('x-commerce-trace-response')?.startsWith(traceContext+'/'));assert.equal((await traced.json()).contractVersion,2);
  assert.equal((await call('show my cart')).headers.get('x-commerce-trace-response'),null);
  const versioned=await fetch(url+'/api/resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'show me products for camping',contractVersion:2})});
  assert.equal(versioned.status,200);
  const envelope=await versioned.json();
  assert.equal(envelope.contractVersion,2);assert.equal(envelope.result.status,'RESOLVED');
  assert.equal(envelope.provenance.clauseSpanEncoding,'utf-16-code-units');
  assert.equal(envelope.provenance.evidenceSpanEncoding,'unicode-code-points');
  assert.match(envelope.provenance.runtimeVersion,/^[a-f0-9]{64}$/);
  assert.deepEqual(envelope.result.actions[0].itemIndexes,[]);
  const incompatible=await fetch(url+'/api/resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'show my cart',contractVersion:99})});
  assert.equal(incompatible.status,400);assert.equal((await incompatible.json()).error,'incompatible_version');
  const counted=await (await call('add to cart 1 banana then also to wishlist')).json();
  assert.equal(counted.requestedActionsVersion,1);assert.ok(Array.isArray(counted.requestedActionIssues));assert.equal(counted.intentCount,2);assert.equal(counted.uniqueIntentCount,2);assert.equal(counted.intentCountStatus,'EXACT');
  assert.deepEqual(counted.requestedActions.map((a:any)=>a.intent),['ADD_TO_CART','ADD_TO_WISHLIST']);
  assert.equal(counted.compoundInterpretationVersion,1);assert.equal(counted.status,'RESOLVED');assert.equal(counted.intent,null);
  assert.equal(counted.fulfillment.status,'NOT_EXECUTED');
  const conditionalPair=await (await call('add banana to cart and add apple to wishlist if cheap')).json();
  assert.equal(conditionalPair.compoundInterpretationVersion,undefined);assert.equal(conditionalPair.status,'NEEDS_CONTEXT');
  const continued=await (await call('banana',{pendingActionRequest:'add 2 of it to cart then also to wishlist'})).json();
  assert.equal(continued.compoundReply,'filled');assert.equal(continued.intentCount,2);
  assert.deepEqual(continued.requestedActions.map((a:any)=>a.items),[[{quantity:2,productText:'banana'}],[{quantity:2,productText:'banana'}]]);
  assert.equal((await call('banana',{pendingActionRequest:'x'.repeat(4001)})).status,400);
  const first=await (await call('create an order for two apples and deliver it there')).json();assert.equal(first.status,'NEEDS_CONTEXT');assert.equal(first.intentCount,2);
  const second=await (await call('home',first.context.next)).json();assert.equal(second.status,'RESOLVED');assert.equal(second.intentCount,2);assert.equal(second.primaryIntent,'CREATE_ORDER');assert.equal(second.entities.items[0].quantity,2);assert.equal(second.entities.delivery.addressReference,'HOME');
  assert.equal((await call('fish',{selectedItems:[{productText:'fish',quantity:-2}]})).status,400);
  assert.equal((await call('fish',null)).status,200); // null means no context, preserving existing HTTP semantics
  assert.equal((await call('fish',{pendingRequest:'x'.repeat(4001)})).status,400);
  const search=await (await call('find black running shoes under $100')).json();
  const edited=await (await call('actually blue and make the budget $80',search.context.next)).json();
  assert.equal(edited.status,'RESOLVED');assert.equal(edited.entities.color,'blue');assert.equal(edited.entities.price.value,80);
  const excluded=await (await call('find shoes between $50 and $100 excluding Nike')).json();
  assert.equal(excluded.status,'NEEDS_CONTEXT');assert.equal(excluded.entities.requestConstraints[0].value,'Nike');
  assert.equal((await call('actually blue',{activeSearch:{text:'find shoes',productId:'fake'}})).status,400);
 } finally {if(child.exitCode===null){child.kill();await once(child,'exit');}}
});
