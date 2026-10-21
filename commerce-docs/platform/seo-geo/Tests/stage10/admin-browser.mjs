// Synthetic UI contract fixtures; backend persistence is tested separately in Rust.
import {createRequire} from 'node:module';import {spawn} from 'node:child_process';import {createServer} from 'node:net';import {fileURLToPath} from 'node:url';import {mkdir,writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../../../../',import.meta.url));const require=createRequire(root+'frontend/package.json');const {chromium}=require('@playwright/test');
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const vite=spawn(process.execPath,[root+'frontend/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port)],{cwd:root+'frontend/apps/admin',stdio:['ignore','pipe','pipe']});
let output='';vite.stdout.on('data',c=>output+=c);vite.stderr.on('data',c=>output+=c);
let browser;try{
 for(let i=0;i<100;i++){if(output.includes('Local:'))break;await new Promise(r=>setTimeout(r,100));}assert.ok(output.includes('Local:'),'Vite started');
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});let failed=true;let finance=true;let reads=0;const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async route=>{
  const p=new URL(route.request().url()).pathname;let body;let status=200;
  if(p==='/api/v1/admin/me')body={user:{id:'fixture-admin',name:'Synthetic operator',email:'operator@example.test'},permissions:['discovery.read','reports.read']};
  else if(p==='/api/v1/admin/discovery/health'){reads++;body={observed_at:'2026-09-21T12:00:00Z',scope:'Synthetic UI fixture — not production observations.',findings:[{code:'product_html',severity:failed?'Error':'Healthy',resource:'https://shop.example.test/products/apple',evidence:failed?'Expected product H1 was missing.':'Server-visible product H1 matched.',remediation:failed?'Restore initial server-visible product content.':'No action required.',observed_at:'2026-09-21T12:00:00Z'}],observations:null};}
  else if(p==='/api/v1/admin/discovery/analytics')body={timezone:'UTC',from:'2026-08-22T12:00:00Z',days:30,sampling:'Synthetic browser observations for UI verification.',session_model:'first touch',revenue_authorized:finance,channels:[{channel:'ai_chatgpt',sessions:12,referrer_sessions:10,campaign_claim_sessions:2,ai_assisted_sessions:12}],top_landings:[{path:'/products/apple',sessions:12}],top_products:[{path:'/products/apple',sessions:12}],trend:[{day:'2026-09-21',sessions:12,recognized_ai_sessions:12}],conversions:finance?[{channel:'ai_chatgpt',currency:'USD',orders:2,ai_assisted_orders:2,collected_net_revenue:'80.00'}]:null};
  else {status=503;body={error:'Synthetic fixture: this adjacent feature is not under test.'};}
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto(`http://127.0.0.1:${port}/discoverability/seo`);const card=page.locator('.discovery-evidence');await card.getByText('Error: product html',{exact:true}).waitFor();await card.getByText('80.00 USD',{exact:true}).waitFor();assert.equal(await card.getByText('ai_chatgpt',{exact:true}).count(),2);
 const dir=root+'commerce-ai-docs/platform/seo-geo/Reports/evidence/stage10';await mkdir(dir,{recursive:true});await page.setViewportSize({width:1440,height:2200});await card.evaluate(el=>el.scrollIntoView({block:'start'}));await page.evaluate(()=>window.scrollBy(0,-100));await card.screenshot({path:dir+'/admin-health-desktop.png'});
 failed=false;await card.getByRole('button',{name:'Refresh evidence'}).click();await card.getByText('Healthy: product html',{exact:true}).waitFor();assert.ok(reads>=2);
 finance=false;await card.getByRole('button',{name:'Refresh evidence'}).click();await card.getByText('Revenue reporting requires reports.read permission.',{exact:true}).waitFor();assert.equal(await card.getByText('80.00 USD',{exact:true}).count(),0);
 await page.setViewportSize({width:390,height:844});await page.setViewportSize({width:390,height:2600});await card.evaluate(el=>el.scrollIntoView({block:'start'}));await page.evaluate(()=>window.scrollBy(0,-100));await card.screenshot({path:dir+'/admin-health-mobile.png'});
 const overflow=await card.evaluate(el=>el.scrollWidth>el.clientWidth+1);assert.equal(overflow,false);assert.deepEqual(errors,[]);
 await writeFile(dir+'/admin-browser.json',JSON.stringify({synthetic:true,desktop:'1440px wide; tall capture viewport',mobile:'390px wide; tall capture viewport',health_failure_visible:true,refresh_recovery:true,revenue_permission_redaction:true,card_overflow:false,page_errors:errors},null,2));console.log('PASS: synthetic admin health, refresh/recovery, revenue permissions, desktop/mobile layout');
}finally{await browser?.close();vite.kill('SIGTERM');}
