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
async function assertTimelineFits(page,width){
 await page.waitForFunction(()=>{
  const viewport=document.querySelector('#trace-flow .timeline-viewport');
  if(!viewport)return false;
  const bounds=viewport.getBoundingClientRect(),cards=[...viewport.querySelectorAll('.journey-node')];
  return cards.length>0&&cards.every(card=>{const box=card.getBoundingClientRect();return box.left>=bounds.left-2&&box.right<=bounds.right+2;})&&viewport.scrollWidth<=viewport.clientWidth+2;
 });
 const boxes=await page.locator('#trace-flow .journey-step').evaluateAll(items=>items.map(el=>{const box=el.getBoundingClientRect();return {top:box.top,left:box.left,width:box.width};}));
 const rows=[];for(const box of boxes){let row=rows.find(row=>Math.abs(row[0].top-box.top)<2);if(!row){row=[];rows.push(row);}row.push(box);}
 assert.ok(boxes.every(box=>box.width>=180),`Cards must remain readable at ${width}px`);
 for(const row of rows)for(let i=1;i<row.length;i++)assert.ok(row[i].left>=row[i-1].left+row[i-1].width-1,`Steps must not overlap at ${width}px`);
 for(let i=1;i<rows.length;i++)assert.ok(rows[i][0].top>rows[i-1][0].top,'Card rows follow execution order');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Timeline must not overflow the page at ${width}px`);
}
async function timelineView(page,name){
 if(await page.locator('#trace-sections').isVisible()&&await page.locator('[data-section=timeline]').getAttribute('aria-current')!=='page')await page.locator('[data-section=timeline]').click();
 await page.getByRole('button',{name,exact:true}).click();
}
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
 const page=await browser.newPage({viewport:{width:1512,height:1100}});page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(config.origin);assert.equal(await page.locator('#live-workspace').count(),0);assert.equal(await page.locator('[data-tab=journey]').count(),0);await page.getByRole('button',{name:'Connect demo',exact:true}).click();await page.getByLabel('Administrator email').fill('test@example.test');await page.getByLabel('Password',{exact:true}).fill('test-password');await page.locator('#login-submit').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
 await page.locator('#run').click();await page.locator('#metric-intent').filter({hasText:'PRODUCT_SEARCH'}).waitFor();await page.getByRole('button',{name:/Rules & ranking/}).click();await page.locator('#stage-detail').filter({hasText:'primary'}).waitFor();
 await page.getByRole('tab',{name:'Rule evidence'}).click();await page.locator('#result-content').filter({hasText:'primary'}).waitFor();
 await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'/tmp/rengine-explorer-desktop.png',fullPage:true});
 await page.getByRole('tab',{name:'Semantic graph'}).click();assert.equal(await page.locator('svg .graph-node').count(),4);
 await page.getByRole('button',{name:/Performance lab/}).click();await page.locator('#suite').fill('Find fruit | PRODUCT_SEARCH\nFind milk | OTHER');await page.locator('#run-suite').click();await page.locator('#benchmark-rows tr').nth(1).waitFor();assert.match(await page.locator('#benchmark-summary').innerText(),/50.0%/);
 await page.getByRole('button',{name:/Production traces/}).click();await page.locator('.trace-link').click();
 await page.locator('.journey-node').first().waitFor();
 assert.equal(await page.locator('[data-section=timeline]').getAttribute('aria-current'),'page');
 assert.equal(await page.getByRole('button',{name:'Cards',exact:true}).getAttribute('aria-pressed'),'true');
 assert.equal(await page.locator('.journey-summary').isVisible(),true);
 const sectionButtons=await page.locator('#trace-sections button').evaluateAll(buttons=>buttons.map(button=>button.getBoundingClientRect().top));
 assert.ok(sectionButtons.every(top=>Math.abs(top-sectionButtons[0])<2),'This request navigation is horizontal');
 await page.locator('#trace-refresh').click();await page.locator('.journey-node').first().waitFor();
 assert.equal(await page.getByRole('button',{name:'Cards',exact:true}).getAttribute('aria-pressed'),'true');
 await page.locator('[data-section=raw]').click();await page.locator('#trace-stages').filter({hasText:'Final routing and response'}).waitFor();
 await timelineView(page,'Cards');await page.locator('#trace-flow .journey-node.python').click();await page.locator('#trace-flow').getByRole('button',{name:'View function',exact:true}).click();assert.match(await page.locator('#trace-flow .source-code').innerText(),/async def resolve/);
 assert.match(await page.locator('#trace-facts').innerText(),/Version 1 · Redacted · No model input captured/);
 assert.match(await page.locator('#trace-stages').innerText(),/Some stages or details were omitted/);
 assert.equal(await page.locator('#trace-stages script').count(),0);assert.equal(await page.evaluate(()=>window.attacked),undefined);
 assert.match(page.url(),/store=grocery&request=10000000/);
 const before=reportReads;await page.locator('#trace-refresh').click();await page.locator('[data-section=raw]').click();await page.locator('#trace-stages').filter({hasText:'Final routing and response'}).waitFor();assert.ok(reportReads>before);
 const downloadPromise=page.waitForEvent('download');await page.locator('#trace-export').click();const downloaded=await downloadPromise;assert.match(downloaded.suggestedFilename(),/rengine-grocery-10000000/);assert.equal(exportReads,1);
 assert.equal(await page.locator('#trace-history').isVisible(),false);await page.locator('#trace-close').click();await page.locator('#trace-history').waitFor();
 await page.locator('#trace-outcome').selectOption('denied');await page.waitForResponse(r=>r.url().includes('/api/all-traces?')&&r.url().includes('outcome=denied'));assert.equal(traceQueries.at(-1).get('outcome'),'denied');
 await page.locator('#trace-next').click();await page.locator('#trace-page').filter({hasText:'Page 2'}).waitFor();assert.equal(traceQueries.at(-1).get('cursor'),'page2');await page.locator('.trace-link').click();await timelineView(page,'Cards');await page.locator('#trace-flow .journey-node').first().waitFor();await page.goBack();await page.locator('#trace-history').waitFor();assert.equal(await page.locator('#trace-outcome').inputValue(),'denied');assert.match(await page.locator('#trace-page').innerText(),/Page 2/);await page.screenshot({path:'/tmp/rengine-history-grid.png',fullPage:true});
 await page.locator('#trace-clear').click();await page.locator('#trace-page').filter({hasText:'Page 1'}).waitFor();assert.equal(await page.locator('#trace-outcome').inputValue(),'');
 await page.locator('#trace-search').fill('10000000-0000-4000-8000-000000000001');await page.getByRole('button',{name:'Search',exact:true}).click();await page.waitForResponse(r=>r.url().includes('/api/all-traces?')&&r.url().includes('request_id='));assert.equal(traceQueries.at(-1).get('request_id'),'10000000-0000-4000-8000-000000000001');
 await page.locator('.trace-link').click();await page.locator('#trace-export').waitFor();await page.reload();await page.locator('#trace-export').waitFor();
 exportAllowed=false;await page.locator('#trace-refresh').click();await page.locator('[data-section=raw]').click();await page.locator('#trace-stages').filter({hasText:'Final routing and response'}).waitFor();assert.equal(await page.locator('#trace-export').isVisible(),false);exportAllowed=true;
 await page.locator('[data-section=timeline]').click();await timelineView(page,'Cards');await page.locator('#trace-flow .journey-node.python').click();await page.locator('#trace-flow').getByRole('button',{name:'View function',exact:true}).click();await page.evaluate(()=>scrollTo(0,0));
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/rengine-traces-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.setViewportSize({width:1512,height:1100});await page.screenshot({path:'/tmp/rengine-traces-desktop.png',fullPage:true});
 await page.locator('#trace-close').click();await page.locator('#trace-history').waitFor();assert.equal(new URL(page.url()).searchParams.has('request'),false);

 await page.getByRole('button',{name:/Request explorer/}).click();await page.locator('#mode').selectOption('assistant');await page.locator('#run').click();await page.locator('#metric-intent').filter({hasText:'Stream completed'}).waitFor({state:'attached'});
 await timelineView(page,'Cards');await page.locator('#trace-flow .journey-node').first().waitFor();await page.locator('#trace-close').click();await page.locator('#trace-history').waitFor();
 await page.locator('#tracking-state').filter({hasText:'ON'}).waitFor();await page.locator('#tracking-toggle').click();await page.locator('#tracking-state').filter({hasText:'OFF'}).waitFor();assert.equal(captureEnabled,false);await page.locator('#tracking-toggle').click();await page.locator('#tracking-state').filter({hasText:'ON'}).waitFor();assert.equal(captureEnabled,true);await page.locator('.trace-link').click();await timelineView(page,'Cards');await page.locator('#trace-flow .journey-node').first().waitFor();
 await timelineView(page,'Cards');await page.locator('#trace-flow .journey-node').nth(1).click();await page.getByRole('button',{name:'View function',exact:true}).click();await page.locator('.source-code').filter({hasText:'async def resolve'}).waitFor();
 await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'/tmp/rengine-journey-desktop.png',fullPage:true});
 await timelineView(page,'Cards');await page.locator('#trace-flow .journey-node.rules').click();await page.getByRole('button',{name:'View rules',exact:true}).click();await page.locator('#trace-flow').filter({hasText:'ACTION_SEARCH'}).waitFor();
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/rengine-journey-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.getByRole('button',{name:/Request explorer/}).click();
 await page.getByRole('tab',{name:'Summary',exact:true}).click();await page.locator('#result-content').filter({hasText:'Hello from the assistant'}).waitFor();
 await page.locator('#mode').selectOption('language');await page.locator('#run').click();await page.locator('#metric-intent').filter({hasText:'PRODUCT_SEARCH'}).waitFor();
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/rengine-explorer-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.evaluate(()=>document.fonts.ready);
 assert.equal(await page.evaluate(()=>document.fonts.check('400 15px "Source Sans 3"')),true);
 const fontResponse=await page.request.get(config.origin+'/fonts/source-sans-3.woff2');assert.equal(fontResponse.status(),200);assert.match(fontResponse.headers()['content-type'],/font\/woff2/);
 await page.getByRole('tab',{name:'Summary',exact:true}).focus();await page.keyboard.press('ArrowRight');assert.equal(await page.getByRole('tab',{name:'Rule evidence'}).getAttribute('aria-selected'),'true');await page.keyboard.press('End');assert.equal(await page.getByRole('tab',{name:'Raw response'}).getAttribute('aria-selected'),'true');
 for(const width of [390,768,1024,1512]){await page.setViewportSize({width,height:1000});for(const tab of ['explore','benchmark','traces','architecture']){await page.locator(`[data-tab="${tab}"]`).click();assert.equal(await page.locator(`[data-tab="${tab}"]`).getAttribute('aria-current'),'page');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${tab} overflows at ${width}px`);}}
 await page.locator('[data-tab="architecture"]').click();await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'/tmp/rengine-system-desktop.png',fullPage:true});
 await page.locator('[data-tab="benchmark"]').click();await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'/tmp/rengine-benchmark-desktop.png',fullPage:true});
 await page.locator('[data-tab="explore"]').click();
 ragFixture=true;await page.locator('[data-tab="traces"]').click();await page.locator('.trace-link').click();await timelineView(page,'Cards');await page.locator('#trace-flow .journey-node[data-kind=retrieval]').waitFor();
 await timelineView(page,'Cards');await page.locator('#trace-flow .journey-node[data-kind=retrieval]').click();assert.match(await page.locator('#trace-flow .step-summary').innerText(),/Search query/);assert.match(await page.locator('#trace-flow .step-summary').innerText(),/find fruit/);assert.equal(await page.locator('#trace-flow .journey-detail').getAttribute('data-kind'),'retrieval');
 await page.locator('#trace-flow').getByRole('button',{name:'Play timeline',exact:true}).click();await timelineView(page,'Cards');await page.locator('#trace-flow .journey-node.python.selected').waitFor();await page.locator('#trace-flow').getByRole('button',{name:'Pause',exact:true}).click();
 assert.equal(await page.locator('#trace-flow .journey-timeline').count(),1);assert.equal(await page.locator('#trace-flow .journey-milestones').count(),0);assert.equal(await page.locator('#trace-flow .journey-node').count(),7);
 await timelineView(page,'Cards');await page.locator('#trace-flow .journey-node[data-kind=retrieval]').focus();await page.keyboard.press('End');assert.equal(await page.locator('#trace-flow .journey-detail').getAttribute('data-kind'),'response');await page.keyboard.press('Home');assert.equal(await page.locator('#trace-flow .journey-detail').getAttribute('data-kind'),'customer');await page.keyboard.press('ArrowRight');assert.equal(await page.locator('#trace-flow .journey-detail').getAttribute('data-kind'),'python');await timelineView(page,'Cards');await page.locator('#trace-flow .journey-node[data-kind=retrieval]').click();
 for(const width of [390,768,1512]){
  await page.setViewportSize({width,height:1000});await assertTimelineFits(page,width);
  const path=page.locator('#trace-flow .journey-path'),firstCard=page.locator('#trace-flow .journey-node').first();
  const fittedWidth=(await firstCard.boundingBox()).width;
  await path.getByRole('button',{name:'Zoom in',exact:true}).click();
  await page.waitForFunction(fitted=>document.querySelector('#trace-flow .journey-node').getBoundingClientRect().width>fitted+1,fittedWidth);
  const zoomedWidth=(await firstCard.boundingBox()).width;
  await path.getByRole('button',{name:'Zoom out',exact:true}).click();
  await page.waitForFunction(zoomed=>document.querySelector('#trace-flow .journey-node').getBoundingClientRect().width<zoomed-1,zoomedWidth);
  await path.getByRole('button',{name:'Actual size',exact:true}).click();assert.equal(await path.locator('.zoom-label').innerText(),'100%');await timelineView(page,'Cards');await page.locator('#trace-flow .journey-node').last().click();assert.equal(await page.locator('#trace-flow .journey-detail').getAttribute('data-kind'),'response');
  await path.getByRole('button',{name:'Fit to screen',exact:true}).click();await assertTimelineFits(page,width);
  await timelineView(page,'Cards');await page.locator('#trace-flow .journey-node').last().click();assert.equal(await page.locator('#trace-flow .journey-detail').getAttribute('data-kind'),'response');
  await timelineView(page,'Cards');await page.locator('#trace-flow .journey-node[data-kind=retrieval]').click();assert.equal(await page.locator('#trace-flow .journey-detail').getAttribute('data-kind'),'retrieval');
  if(width<1100)assert.equal(await page.locator('#trace-flow .journey-detail').evaluate(el=>el===document.activeElement),true,'Mobile card selection focuses its evidence');
 }
 await page.locator('#trace-flow .retrieved-example summary').click();assert.match(await page.locator('#trace-flow .retrieved-example').innerText(),/reviewed-example/);
 await page.setViewportSize({width:1512,height:1100});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'/tmp/rengine-rag-details-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/rengine-rag-details-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.locator('[data-section=overview]').click();diagnosticFixture=diagnosticFixtures.completedWithoutProof;await page.locator('#trace-refresh').click();
 await page.locator('.diagnostic-grid').filter({hasText:'PRODUCT_SEARCH'}).waitFor();
 assert.match(await page.locator('.diagnostic-grid').innerText(),/Business outcome\nunknown/);
 await page.locator('.diagnostic-finding').first().getByRole('button',{name:'Inspect supporting step'}).click();
 assert.match(await page.locator('.journey-detail h2').innerText(),/Filter returned products/);
 assert.match(await page.locator('.step-summary').innerText(),/individual check effects were not recorded/);
 assert.equal(await page.locator('.journey-detail').evaluate(el=>el===document.activeElement),true);
 for(const width of [390,768,1024,1512]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Diagnostic summary overflows at ${width}px`);}
 await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'/tmp/rengine-m01-summary-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/rengine-m01-summary-mobile.png',fullPage:true});
 diagnosticFixture=diagnosticFixtures.modelRecovery;await page.locator('#trace-refresh').click();
 await page.locator('.trace-diagnostics').filter({hasText:'AI response failed validation'}).waitFor();
 await page.locator('.diagnostic-measurements summary').click();
 assert.match(await page.locator('.diagnostic-metrics').innerText(),/Captured response input tokens\n100/);
 assert.match(await page.locator('.diagnostic-metrics').innerText(),/Total model calls\nNot recorded/);
 assert.match(await page.locator('.trace-diagnostics .notice').innerText(),/truncated/);
 await page.locator('.diagnostic-finding').first().getByRole('button',{name:'Inspect supporting step'}).click();assert.match(await page.locator('.journey-detail h2').innerText(),/AI response could not be accepted/);
 diagnosticFixture=diagnosticFixtures.legacy;await page.locator('#trace-refresh').click();
 await page.locator('.diagnostic-grid').filter({hasText:'completion not captured'}).waitFor();
 assert.match(await page.locator('.diagnostic-grid').innerText(),/Business outcome\nunknown/);
 diagnosticFixture=captureV2;await page.locator('#trace-refresh').click();
 await page.locator('.diagnostic-grid').filter({hasText:'clarification needed'}).waitFor();
 await page.locator('.diagnostic-measurements summary').click();
 assert.match(await page.locator('.diagnostic-metrics').innerText(),/Python turn duration\n31 ms/);
 assert.match(await page.locator('.diagnostic-metrics').innerText(),/Server first text event\n27 ms/);
 assert.match(await page.locator('.diagnostic-metrics').innerText(),/Provider dispatch attempts\n1/);
 await timelineView(page,'Cards');await page.locator('.journey-node').filter({hasText:'Filter returned products'}).click();
 assert.match(await page.locator('.step-summary').innerText(),/12 → 3 products/);assert.match(await page.locator('.step-summary').innerText(),/3 → 0 products/);
 await timelineView(page,'Cards');await page.locator('.journey-node').filter({hasText:'Provider dispatch attempt'}).click();
 assert.match(await page.locator('.step-summary').innerText(),/Adapter validation\naccepted/);
 await timelineView(page,'Cards');await page.locator('.journey-node[data-kind=retrieval]').click();assert.match(await page.locator('.step-summary').innerText(),/Examples linked to prepared model input\n1/);
 const v2Download=page.waitForEvent('download');await page.locator('#trace-export').click();
 const exported=JSON.parse(await readFile(await (await v2Download).path(),'utf8'));
 assert.equal(exported.version,2);assert.equal(exported.events.at(-1).data.measurements.request_duration_ms,31);
 await timelineView(page,'Cards');await page.locator('.journey-node').filter({hasText:'Filter returned products'}).click();
 for(const width of [390,768,1024,1512]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
 await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'/tmp/rengine-m2-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/rengine-m2-mobile.png',fullPage:true});
 // M3 shares selection between all views and restores it from the request URL.
 await page.setViewportSize({width:1512,height:1100});
 await timelineView(page,'Grouped steps');
 if(await page.locator('.trace-overview details').filter({has:page.locator('summary').filter({hasText:'Model'})}).getAttribute('open')===null)await page.locator('.trace-overview summary').filter({hasText:'Model'}).click();
 await page.locator('.trace-overview .trace-event').filter({hasText:'Provider dispatch attempt'}).click();
 const selectedEvent=new URL(page.url()).searchParams.get('event');assert.ok(selectedEvent.startsWith('span:'));
 await timelineView(page,'Waterfall');
 assert.equal(await page.locator('.waterfall-row.selected').count(),1);
 assert.equal(await page.locator('.waterfall-row').count(),captureV2.events.length);
 assert.ok(await page.locator('.waterfall-bar').count()>0);
 assert.equal(await page.locator('.journey-detail').evaluate(el=>getComputedStyle(el).position),'sticky');
 await page.locator('#trace-refresh').click();await page.locator('.waterfall-row.selected').waitFor();
 assert.equal(new URL(page.url()).searchParams.get('event'),selectedEvent);
 assert.equal(new URL(page.url()).searchParams.get('traceView'),'waterfall');
 await page.reload();await page.locator('.waterfall-row.selected').waitFor();assert.equal(await page.locator('.waterfall-row.selected').getAttribute('data-step-id'),selectedEvent);
 await page.locator('.waterfall-row.selected').focus();await page.keyboard.press('End');
 assert.equal(await page.locator('.journey-detail').getAttribute('data-kind'),'response');
 for(const width of [390,768,1024,1512]){
  await page.setViewportSize({width,height:1000});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.ok(await page.locator('.waterfall-row strong').first().evaluate(el=>parseFloat(getComputedStyle(el).fontSize))>=14);
  if(width<1100)assert.equal(await page.locator('.journey-detail').evaluate(el=>getComputedStyle(el).position),'static');
 }
 await page.locator('[data-section=issues]').click();await page.getByLabel('Duration threshold (ms)').fill('10');await page.getByLabel('Duration threshold (ms)').press('Tab');
 assert.match(await page.locator('.trace-category').innerText(),/Span exceeds 10 ms/);
 await page.locator('.trace-problem').filter({hasText:'Span exceeds 10 ms'}).first().getByRole('button').click();
 assert.equal(await page.locator('.journey-detail').evaluate(el=>el===document.activeElement),true);
 await timelineView(page,'Grouped steps');await page.locator('[data-section=issues]').click();await page.evaluate(()=>document.querySelector('.trace-workspace').scrollIntoView());await page.screenshot({path:'/tmp/rengine-m3-overview.png',animations:'disabled'});await timelineView(page,'Waterfall');
 await page.evaluate(()=>document.querySelector('.trace-workspace').scrollIntoView());await page.screenshot({path:'/tmp/rengine-m3-desktop.png'});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/rengine-m3-mobile.png',fullPage:true});
 diagnosticFixture=captureServices;await page.locator('#trace-refresh').click();await page.locator('.service-lane[data-service="language-engine"]').waitFor();
 assert.equal(await page.locator('.service-lane').count(),2);
 assert.match(await page.locator('.service-lane[data-service="language-engine"]').innerText(),/5.000 ms · remote handler duration/);
 assert.match(await page.locator('.service-lane[data-service="api-gateway"]').innerText(),/Dispatch recorded · duration and completion not captured/);
 assert.equal(await page.locator('.waterfall-row').count(),10);
 await page.locator('.service-lane[data-service="language-engine"] button').click();
 assert.match(await page.locator('.journey-detail').innerText(),/Its start is not aligned to the Python clock/);
 await page.getByRole('button',{name:'Inspect parent span',exact:true}).click();
 assert.equal(await page.locator('.waterfall-row.selected').getAttribute('data-step-id'),'span:span-3');
 for(const width of [390,768,1024,1512]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
 await page.locator('.service-lane[data-service="language-engine"] button').click();await page.locator('.service-lane[data-service="language-engine"]').scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/rengine-m4-services.png',animations:'disabled'});
 diagnosticFixture=diagnosticFixtures.legacy;await page.locator('#trace-refresh').click();await page.locator('.trace-waterfall h3').filter({hasText:'Untimed'}).waitFor();
 assert.equal(await page.locator('.waterfall-bar').count(),0);assert.equal(await page.locator('.waterfall-marker').count(),0);
 diagnosticFixture=null;
 await page.locator('#store').selectOption('jewelry');await page.locator('#login-dialog').waitFor({state:'visible'});assert.match(await page.locator('#login-store').innerText(),/Jewelry/);assert.equal(await page.locator('#context').inputValue(),'{}');
 await page.evaluate(async()=>{
  document.querySelector('#login-dialog').close();
  const {renderJourney}=await import('/journey.js');
  const root=document.createElement('section');root.id='catalog-check';document.querySelector('main').replaceChildren(root);
  renderJourney(root,{requestId:'catalog-fixture',instrumented:true,sources:{},steps:[
   {id:'routing',stage:'execution_route',kind:'decision',title:'execution route',startMs:0,atMs:0,durationMs:null,evidence:{path:'deterministic',reason:'existing_deterministic',journey:'discovery'}},
   {id:'schema',stage:'python_function',kind:'python',title:'ShoppingCatalog.call',startMs:0,atMs:10,durationMs:10,evidence:{outcome:'returned',details:{operation:'get_catalog_schema',schema_returned:true,products_returned:0}}},
   {id:'search',stage:'python_function',kind:'python',title:'ShoppingCatalog.call',startMs:11,atMs:20,durationMs:9,evidence:{outcome:'returned',details:{operation:'search_products',criteria:{query:'<script>window.catalogAttacked=true</script>',max_price:'200',exclusive_max:true,currency:'EGP'},products_returned:0}}},
   {id:'old',stage:'python_function',kind:'python',title:'ShoppingCatalog.call',startMs:21,atMs:30,durationMs:9,evidence:{outcome:'returned'}}
  ]},{navigationView:'cards'});
 });
 assert.equal(await page.locator('#catalog-check .route-option').count(),3);
 assert.equal(await page.locator('#catalog-check .route-option[data-selected=true]').count(),1);
 assert.match(await page.locator('#catalog-check .step-summary').innerText(),/Unselected paths were not executed/);
 await page.getByRole('button',{name:/Search with filters/}).click();
 assert.match(await page.locator('#catalog-check .step-summary').innerText(),/Price below/);
 assert.match(await page.locator('#catalog-check .step-summary').innerText(),/200/);
 assert.match(await page.locator('#catalog-check .step-readable-state').innerText(),/0 products returned/);
 assert.equal(await page.evaluate(()=>window.catalogAttacked),undefined);
 await page.getByRole('button',{name:/Request catalog information/}).click();
 assert.match(await page.locator('#catalog-check .step-summary').innerText(),/older capture/);
 await page.evaluate(async()=>{
  const {renderJourney}=await import('/journey.js');const root=document.querySelector('#catalog-check');
  window.m3Live={requestId:'live-fixture',capture:{version:2},sources:{},steps:[
   {id:'span:root',spanId:'root',parentSpanId:null,service:'assistant-python',clockDomain:'python-perf-counter',stage:'python_function_start',kind:'python',title:'Parent.call',startMs:0,durationMs:null,evidence:{outcome:'running'}},
   {id:'span:a',spanId:'a',parentSpanId:'root',service:'assistant-python',clockDomain:'python-perf-counter',stage:'python_function',kind:'python',title:'Repeated.call',startMs:10,durationMs:50,evidence:{outcome:'returned'}},
   {id:'span:b',spanId:'b',parentSpanId:'root',service:'assistant-python',clockDomain:'python-perf-counter',stage:'python_function',kind:'python',title:'Repeated.call',startMs:20,durationMs:50,evidence:{outcome:'returned'}},
   {id:'span:c',spanId:'c',parentSpanId:'missing',service:'assistant-python',clockDomain:'python-perf-counter',stage:'python_function',kind:'python',title:'Orphan.call',startMs:25,durationMs:10,evidence:{outcome:'returned'}}]};
  renderJourney(root,window.m3Live,{live:true,navigationView:'waterfall',selectedId:'span:root'});
 });
 assert.match(await page.locator('.waterfall-row.selected').innerText(),/Running — duration not captured/);
 assert.equal(await page.locator('.waterfall-row[data-depth="1"]').count(),2);
 assert.match(await page.locator('.trace-waterfall').innerText(),/Parent not captured/);
 const positions=await page.locator('.waterfall-bar').evaluateAll(bars=>bars.map(b=>({left:parseFloat(b.style.left),width:parseFloat(b.style.width)})));
 assert.ok(positions[0].left<positions[1].left&&positions[0].left+positions[0].width>positions[1].left);
 await page.evaluate(async()=>{const {renderJourney}=await import('/journey.js');window.m3Live.steps[0]={...window.m3Live.steps[0],stage:'python_function',durationMs:80,evidence:{outcome:'returned'}};renderJourney(document.querySelector('#catalog-check'),window.m3Live,{live:true});});
 assert.equal(await page.locator('.waterfall-row').count(),4);assert.equal(await page.locator('.waterfall-row.selected').getAttribute('data-step-id'),'span:root');assert.match(await page.locator('.waterfall-row.selected').innerText(),/80.0 ms inclusive/);
 assert.deepEqual(errors,[]);assert.equal(liveRequests,0);console.log('Browser checks passed: login, live explorer, rule evidence, semantic graph, benchmark accuracy, trace inspection, assistant stream, responsive timeline fit, zoom, M3 overview/waterfall/shared inspector, deep links, live updates, mobile layout and demo isolation.');
} finally {await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
