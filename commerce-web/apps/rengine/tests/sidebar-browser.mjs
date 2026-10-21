// Run from the workspace root with its Playwright dependency.
import { chromium } from '@playwright/test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { configuration } from '../config.mjs';
import { readFile } from 'node:fs/promises';
const diagnosticFixtures=JSON.parse(await readFile(new URL('./fixtures/trace-diagnostics.json',import.meta.url),'utf8'));
const captureV2=JSON.parse(await readFile(new URL('./fixtures/trace-capture-v2.json',import.meta.url),'utf8'));
const captureServices=JSON.parse(await readFile(new URL('./fixtures/trace-services.json',import.meta.url),'utf8'));
let diagnosticFixture=null;
const config=configuration({PORT:'3190'});
const result={contractVersion:2,provenance:{releaseId:'reviewed-fixture-release',generationFingerprint:'27f4c21a9b5d974fc66dca1460fd6805f4c358e68e89e4d95ca0c088d93d26d4'},result:{status:'RESOLVED',intent:'PRODUCT_SEARCH',confidence:0.94,message:'Find fresh fruit within the requested budget.',entities:{productText:'fresh fruit',priceMax:200,currency:'EGP'},requestedActions:[{intent:'PRODUCT_SEARCH'}],context:{next:{previousIntent:'PRODUCT_SEARCH'}},graph:{nodes:[{id:'request',kind:'request'},{id:'action1',kind:'action'},{id:'item1',kind:'product'},{id:'budget',kind:'constraint'}],edges:[{from:'request',to:'action1',relation:'contains'},{from:'action1',to:'item1',relation:'target'},{from:'item1',to:'budget',relation:'constrained_by'}]}},diagnostics:{text:'Find fresh fruit under 200 EGP',normalizedText:'find fresh fruit under 200 egp',latencyMs:2.3,matchedSemanticGroups:['search','fruit','price_max'],evidence:[{group:'search',kind:'REQUIRED',score:20}],debug:{tokens:['find','fresh','fruit','under','200','egp'],candidates:[{intent:'PRODUCT_SEARCH',rule:'primary',score:94,evidence:[{group:'search',kind:'REQUIRED',score:20}],missing:[]}]}}};
let liveRequests=0;let ragFixture=false;let captureEnabled=true,exportAllowed=true;const traceQueries=[];let reportReads=0;let exportReads=0;
const server=createApp(config,async(url,opts)=>{
 const path=new URL(url).pathname;
 if(diagnosticFixture&&path.startsWith('/v1/admin/assistant/tracking/')&&!['settings','live'].includes(path.split('/').at(-1)))return Response.json({...diagnosticFixture,request_id:'10000000-0000-4000-8000-000000000001'});
 if(path==='/v1/admin/auth/login')return new Response(JSON.stringify({user:{name:'Test operator'},permissions:['*']}),{headers:{'content-type':'application/json','set-cookie':'admin_session=synthetic; Path=/; HttpOnly'}});
 if(path==='/v1/admin/assistant/tracking/settings'){if(opts.method==='PUT')captureEnabled=JSON.parse(opts.body).enabled;return Response.json({enabled:captureEnabled,editable:true,source:'saved'});}
 if(path==='/v1/admin/assistant/tracking/live'){liveRequests++;return Response.json({cursor:'10000000-0000-4000-8000-000000000001:0',reset:false,capture_enabled:captureEnabled,events:[]});}
 if(path==='/v1/admin/me')return Response.json({permissions:exportAllowed?['*']:['assistant.tracking.read']});
 if(path==='/api/ready')return Response.json({status:'ok',provenance:result.provenance});
 if(path==='/ready')return Response.json({status:'ok'});
 if(path==='/api/resolve'){const input=JSON.parse(opts.body);return Response.json({...result,diagnostics:{...result.diagnostics,text:input.text}});}
 if(path==='/v1/assistant/chat')return new Response('event: message.delta\ndata: {"text":"Hello from the assistant"}\n\nevent: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}});
 if(path==='/v1/admin/assistant/tracking'){traceQueries.push(new URL(url).searchParams);return Response.json({items:[{request_id:'10000000-0000-4000-8000-000000000001',question_preview:'Find fresh fruit under 200 EGP',created_at:'2026-10-09T12:00:00Z',intent:'PRODUCT_SEARCH',outcome:'completed',latency_ms:115,model_calls:0,report_available:true}],capture_enabled:true,retention_days:7,next_cursor:new URL(url).searchParams.has('cursor')?null:'page2'});}
 if(path.startsWith('/v1/admin/assistant/tracking/')){if(path.endsWith('/export'))exportReads++;else reportReads++;return Response.json({version:1,redacted:true,truncated:true,request_id:'10000000-0000-4000-8000-000000000001',events:[{stage:'customer_request',data:{message:'<script>window.attacked=true</script>',_journey:{atMs:0}}},{stage:'python_function',data:{function:'resolve',outcome:'returned',_journey:{startMs:1,atMs:20,durationMs:19,sourceId:'code1',function:{id:'code1',name:'resolve',file:'app/language/gate.py',line:12,sha256:'fixture-hash',source:'async def resolve(message):\n    return await language_engine(message)'}}}},{stage:'language_rule_evidence',data:{...result,_journey:{atMs:19,sourceId:'code1'}}},...(ragFixture?[{stage:'intent_retrieval',data:{status:'retrieved',query:'find fruit',examples:[{intent:'PRODUCT_SEARCH',text:'find apples',source:'reviewed-example'}],_journey:{atMs:21}}},{stage:'language_model_request',data:{instructions:'Classify the request',_journey:{atMs:22}}},{stage:'model_proposal',data:{intent:'PRODUCT_SEARCH',_journey:{atMs:23}}}]:[]),{stage:'final_result',data:{intent:'PRODUCT_SEARCH',_journey:{atMs:25}}}]});}
 return Response.json({});
});
server.listen(0,'127.0.0.1');await once(server,'listening');config.origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1512,height:1000}});page.setDefaultTimeout(10000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(config.origin);await page.getByRole('button',{name:'Connect demo',exact:true}).click();await page.getByLabel('Email',{exact:true}).fill('test@example.test');await page.getByLabel('Password',{exact:true}).fill('test-password');await page.locator('#login-submit').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
 await page.locator('[data-tab=traces]').click();await page.locator('.trace-link').click();await page.locator('.journey-timeline').waitFor();await page.locator('[data-section=overview]').click();await page.locator('.diagnostic-grid').waitFor();
 assert.equal(await page.locator('[data-section=overview]').getAttribute('aria-current'),'page');
 assert.equal(await page.locator('.trace-navigation').isVisible(),false);assert.equal(await page.locator('.journey-detail').isVisible(),false);
 assert.equal(await page.locator('#trace-store').innerText(),'Grocery trace');
 await page.context().grantPermissions(['clipboard-read','clipboard-write']);await page.locator('#trace-copy').click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'10000000-0000-4000-8000-000000000001');
 assert.equal(await page.locator('#trace-flow .journey-summary code').count(),0);
 await page.screenshot({path:'/tmp/rengine-sidebar-overview.png',fullPage:true});
 await page.locator('[data-section=timeline]').click();await page.locator('.journey-timeline').waitFor();await page.locator('.journey-timeline .journey-node').first().click();await page.locator('.journey-detail').waitFor();
 assert.equal(await page.getByRole('button',{name:'Grouped steps',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Waterfall',exact:true}).count(),0);
 const layout=await page.evaluate(()=>{const timeline=document.querySelector('.journey-timeline'),navigation=document.querySelector('.trace-navigation').getBoundingClientRect(),detail=document.querySelector('.journey-detail').getBoundingClientRect();return {rows:new Set([...timeline.children].map(item=>item.style.gridRow)).size,below:detail.top>=navigation.bottom,full:Math.abs(detail.width-navigation.width)<2};});assert.deepEqual(layout,{rows:3,below:true,full:true});
 await page.getByRole('button',{name:'Close inspector',exact:true}).click();assert.equal(await page.locator('.journey-detail').isVisible(),false);
 await page.locator('[data-section=catalog]').click();await page.locator('.trace-section-empty').waitFor();
 await page.locator('[data-section=ai]').click();await page.locator('.trace-category .trace-event').first().click();await page.locator('.journey-detail').waitFor();
 await page.reload();await page.locator('.trace-category .trace-event').first().waitFor();assert.equal(await page.locator('[data-section=ai]').getAttribute('aria-current'),'page');await page.locator('.journey-detail').waitFor();
 await page.locator('[data-section=issues]').click();await page.getByLabel('Duration threshold (ms)').fill('10');await page.getByLabel('Duration threshold (ms)').press('Tab');assert.match(await page.locator('.trace-category').innerText(),/Capture is incomplete/);
 await page.locator('[data-section=raw]').click();await page.locator('#trace-stages').waitFor();assert.equal(await page.locator('#trace-flow').isVisible(),false);assert.equal(await page.locator('#trace-stages script').count(),0);assert.equal(await page.evaluate(()=>window.attacked),undefined);
 const download=page.waitForEvent('download');await page.locator('#trace-export').click();assert.match((await download).suggestedFilename(),/rengine-grocery/);
 diagnosticFixture=captureServices;await page.locator('[data-section=overview]').click();await page.locator('#trace-refresh').click();await page.locator('.diagnostic-grid').waitFor();
 for(const width of [390,768,1024,1512]){await page.setViewportSize({width,height:1000});for(const section of ['overview','timeline','ai','catalog','issues','raw']){await page.locator(`[data-section=${section}]`).click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${section} overflow at ${width}`);}}
 await page.setViewportSize({width:1512,height:1000});await page.locator('[data-section=overview]').click();await page.screenshot({path:'/tmp/rengine-sidebar-overview.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.locator('[data-section=overview]').click();await page.screenshot({path:'/tmp/rengine-sidebar-mobile.png',fullPage:true});
 await page.setViewportSize({width:1512,height:1000});await page.locator('[data-section=timeline]').click();await page.locator('.journey-timeline .journey-node').first().click();await page.screenshot({path:'/tmp/rengine-sidebar-timeline.png',fullPage:true});
 await page.locator('#trace-close').click();await page.locator('#trace-history').waitFor();assert.equal(new URL(page.url()).searchParams.has('traceSection'),false);
 assert.deepEqual(errors,[]);console.log('Sidebar browser checks passed: sections, inspector, refresh/deep links, raw/export, legacy/v2, empty evidence, issues and responsive layouts.');
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
