import { entryCookie } from './entry-attribution.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {createObservations,alertFor,crawler} from './observability.mjs';
import {inspectProduct,runHealth,sitemapValid} from './health.mjs';
import {createPublicationServer} from './publication.mjs';import {gatewayFetch} from './transport.mjs';
const origin='https://shop.example.test/',installationId='00000000-0000-0000-0000-000000000001';
const canonical={url:origin+'products/apple',json_ld:origin+'products/apple',html:origin+'products/apple',feed:origin+'products/apple',sitemap:origin+'products/apple',path:'/products/apple',locale:'en',installation_id:installationId};
const product={id:'00000000-0000-0000-0000-000000000002',name:'Apple',description:'Fresh apple',price:'2.00',currency:'USD',slug:'apple',offer_eligible:true};
const structured={'@context':'https://schema.org','@graph':[{'@type':'Organization','@id':origin+'#merchant',name:'Store',url:origin},{'@type':'Product','@id':canonical.url+'#product',name:'Apple',description:'Fresh apple',url:canonical.url,offers:{price:'2.00',priceCurrency:'USD',url:canonical.url,seller:{'@id':origin+'#merchant'}}}]};
const snapshot={schema_version:1,installation_id:installationId,origin,site_name:'Store',locale:'en',path:'/products/apple',page:1,status:200,robots:'index, follow',product,products:[product],canonical,structured_data:structured,metadata:{title:'Apple',description:'Fresh apple'},images:{},family:[]};
const html=`<h1>Apple</h1><link rel="canonical" href="${canonical.url}"/><meta name="robots" content="index, follow"/><script type="application/ld+json">${JSON.stringify(structured)}</script>`;
test('meaningful server HTML, canonical, robots and structured facts detect regressions',()=>{
 assert.ok(inspectProduct(html,snapshot).every(f=>f.severity==='Healthy'));
 const broken=`<h1>Loading</h1><script>Apple</script><link rel="canonical" href="https://evil.test/"/><meta name="robots" content="noindex"/><script type="application/ld+json">{broken}</script>`;
 assert.equal(inspectProduct(broken,snapshot).filter(f=>f.severity==='Error').length,4);
 assert.equal(inspectProduct(html.replace('2.00','99.00'),snapshot).find(f=>f.code==='structured_data').severity,'Error');
});
test('XML validator rejects malformed, foreign-host and forbidden XML',()=>{
 const valid=`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}products/apple</loc></url></urlset>`;
 assert.ok(sitemapValid(valid,origin));assert.ok(!sitemapValid(valid.replace('</url>',''),origin));assert.ok(!sitemapValid(valid.replace(origin,'https://shop.example.test.evil/'),origin));assert.ok(!sitemapValid(valid.replace('<url>','<!DOCTYPE x><url>'),origin));
});
test('redacted bounded counters and alert thresholds do not expose request secrets',()=>{
 let now=1_000_000;const rows=[];const o=createObservations(installationId,r=>rows.push(r),()=>now);
 assert.ok(!alertFor(9,9));assert.ok(!alertFor(100,4));assert.ok(!alertFor(100,19));assert.ok(alertFor(10,5));
 for(let i=0;i<10;i++)o.record({path:'/products/private-name?token=SECRET',userAgent:'Googlebot customer@example.test',status:i<5?503:200,code:'SECRET'});
 assert.ok(o.snapshot().alert);assert.equal(rows.filter(r=>r.event==='publication_alert').length,1);assert.ok(!JSON.stringify(rows).includes('SECRET'));assert.ok(!JSON.stringify(o.snapshot()).includes('customer@'));assert.ok(!JSON.stringify(rows).includes('private-name'));
 assert.equal(crawler('Mozilla/5.0'),'none');o.record({path:'/',status:503,userAgent:'Rocento-Publication-Health'});assert.equal(o.snapshot().crawler_requests,10);
 now+=16*60000;assert.equal(o.snapshot().crawler_requests,0);assert.ok(!o.snapshot().alert);
});
test('timeouts and redirect loops produce actionable findings without leaking transport details',async()=>{
 const o=createObservations(installationId,()=>{});
 const report=await runHealth({origin,installationId,observations:o,snapshot:async()=>snapshot,redirectPath:'/products/old',get:async path=>{if(path==='/products/old')return new Response('',{status:301,headers:{location:'/products/old'}});throw new Error('SECRET customer@example.test');}});
 assert.ok(report.findings.some(f=>f.code==='redirect_chain'&&f.severity==='Error'));
 assert.ok(report.findings.some(f=>f.code==='robots'&&f.severity==='Error'));
 assert.ok(report.findings.every(f=>f.resource&&f.observed_at&&f.evidence&&f.remediation));assert.ok(!JSON.stringify(report).includes('SECRET'));
});
test('real HTTP health endpoint requires secret; probes recover after a renderer failure',async()=>{
 let broken=true;let slowRobots=false;const logs=[];const token='synthetic-probe-token'.repeat(3);
 const server=createPublicationServer({origin,installationId,observationToken:token,emitObservation:r=>logs.push(r),gateway:'http://gateway.test/',template:'<html lang="en"><head></head><body><!--publication-html--><!--publication-state--></body></html>',render:s=>{if(broken)throw new Error('customer-secret');return s.status===404?'<h1>Missing</h1>':'<h1>Apple</h1>';},fetcher:async(url,opts)=>{
  const u=new URL(url);if(u.hostname==='127.0.0.1')return gatewayFetch(u,opts);
  if(u.pathname==='/robots.txt'&&slowRobots)await new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(new Error('PRIVATE timeout body')),{once:true}));
  if(u.pathname==='/robots.txt')return new Response(`User-agent: *\nAllow: /\nSitemap: ${origin}sitemap.xml`,{headers:{'x-publication-installation-id':installationId}});
  if(u.pathname.includes('sitemap'))return new Response(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}products/apple</loc></url></urlset>`,{headers:{'x-publication-installation-id':installationId}});
  const path=u.searchParams.get('path');return Response.json(path?.includes('rocento-health-missing')?{...snapshot,status:404,path,canonical:null,structured_data:null}:{...snapshot,path,canonical:path==='/'?{...canonical,url:origin,html:origin,json_ld:origin,feed:origin,sitemap:origin,path:'/'}:canonical});
 }});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 try{
 const get=(path,secret)=>gatewayFetch(new URL(path,base),{headers:{host:'shop.example.test',...(secret?{'x-publication-observation-token':secret}:{})}});
 assert.equal((await get('/__publication/health')).status,404);
 let report=await (await get('/__publication/health',token)).json();assert.ok(report.findings.some(f=>f.code==='product_response'&&f.severity==='Error'));
 const redirect=await get('/products/apple?utm_source=chatgpt.com');assert.equal(redirect.status,301);assert.equal(redirect.headers.get('location'),'/products/apple');assert.ok(redirect.headers.get('set-cookie').includes('chatgpt.com'));
 broken=false;report=await (await get('/__publication/health',token)).json();assert.ok(report.findings.some(f=>f.code==='product_html'&&f.severity==='Healthy'));
 slowRobots=true;const started=Date.now();const timed=await (await get('/__publication/health',token)).json();assert.ok(Date.now()-started>=1900);assert.ok(timed.findings.some(f=>f.code==='robots'&&f.severity==='Error'));assert.ok(!JSON.stringify(timed).includes('PRIVATE timeout body'));
 if(process.env.PUBLICATION_EVIDENCE_DIR){const fs=await import('node:fs/promises');await fs.mkdir(process.env.PUBLICATION_EVIDENCE_DIR,{recursive:true});await fs.writeFile(process.env.PUBLICATION_EVIDENCE_DIR+'/renderer-health-recovered.json',JSON.stringify(report,null,2));await fs.writeFile(process.env.PUBLICATION_EVIDENCE_DIR+'/renderer-health-timeout.json',JSON.stringify(timed,null,2));}
 assert.equal((await gatewayFetch(new URL('/',base),{headers:{host:'foreign.test?secret'}})).status,421);
 assert.ok(logs.some(r=>r.code==='unknown_canonical_host'));assert.ok(!JSON.stringify(logs).includes('customer-secret'));assert.ok(!JSON.stringify(logs).includes(token));
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('canonical redirects retain bounded campaign claims without queries or secrets',()=>{
 const cookie=entryCookie('/products/a?utm_source=chatgpt.com&utm_campaign=spring&token=SECRET','https://chatgpt.com/c/PRIVATE?token=SECRET');
 assert.ok(cookie.includes('Max-Age=120'));assert.ok(cookie.includes('SameSite=Lax'));assert.ok(!cookie.includes('SECRET'));assert.ok(!cookie.includes('PRIVATE'));
 const parsed=JSON.parse(decodeURIComponent(cookie.split(';')[0].split('=')[1]));assert.equal(parsed.source,'chatgpt.com');assert.equal(parsed.referrer,'https://chatgpt.com');
 assert.equal(entryCookie('/?utm_source=chatgpt.com','',{'sec-gpc':'1'}),null);assert.equal(entryCookie('/?utm_source=user%40example.test',''),null);
});
