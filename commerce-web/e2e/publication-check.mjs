import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
const target=process.env.PUBLICATION_TEST_URL;
// Match production ingress: /api goes to the gateway, preserving POST/body semantics.
const proxy=http.createServer((req,res)=>{const api=req.url.startsWith('/api/');const destination=api?new URL(req.url.slice(4),process.env.PUBLICATION_TEST_GATEWAY):new URL(req.url,target);const headers={...req.headers,host:'shop.example.test'};if(headers.origin)headers.origin='https://shop.example.test';const upstream=http.request(destination,{method:req.method,headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});upstream.on('error',()=>{res.writeHead(503);res.end();});req.pipe(upstream);});
proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
const base=`http://127.0.0.1:${proxy.address().port}`;
const browser=await chromium.launch({headless:true, ...(process.env.PUBLICATION_BROWSER_EXECUTABLE ? {executablePath:process.env.PUBLICATION_BROWSER_EXECUTABLE} : {})});
try {
  const context=await browser.newContext({});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error' && /hydrat|did not match|server HTML|Minified React/.test(m.text()))errors.push(m.text());});
  const requests=[];page.on('request',r=>requests.push(r.url()));
  // Keepalive telemetry is not page readiness: assert its response and the usable UI separately.
  const attribution=page.waitForResponse(r=>r.url().endsWith('/api/v1/discovery/attribution') && r.request().method()==='POST');
  await page.goto(`${base}/products/apples`,{waitUntil:'domcontentloaded'});assert.equal((await attribution).status(),200);
  assert.equal(await page.locator('h1').textContent(),'Orchard apples');
  assert.ok((await page.locator('main').innerText()).includes('3.25 USD'));
  assert.equal(requests.filter(url=>/auth|session|cart|location/.test(new URL(url).pathname)).length,0);
  await page.getByRole('link',{name:'Fresh fruit',exact:true}).first().click();await page.waitForLoadState('domcontentloaded');
  assert.equal(await page.locator('h1').textContent(),'Fresh fruit');
  await page.getByRole('link',{name:'Orchard apples',exact:true}).first().click();await page.waitForLoadState('domcontentloaded');
  assert.equal(await page.locator('h1').textContent(),'Orchard apples');assert.deepEqual(errors,[]);
  if(process.env.PUBLICATION_EVIDENCE_DIR)await page.screenshot({path:`${process.env.PUBLICATION_EVIDENCE_DIR}/product-desktop.png`,fullPage:true});
  await page.setViewportSize({width:390,height:844});
  if(process.env.PUBLICATION_EVIDENCE_DIR)await page.screenshot({path:`${process.env.PUBLICATION_EVIDENCE_DIR}/product-mobile.png`,fullPage:true});
  // Existing live-search widget remains interactive after hydration; API fixture is explicit.
  await page.route('**/api/v1/search?*',route=>route.fulfill({json:{hits:[{id:'00000000-0000-0000-0000-000000000002',name:'Orchard apples',description:'Crisp apples',price:'3.25',currency:'USD',unit:'kg',media_ids:[],product_type:'simple'}],total:1,facets:{}}}));
  const input=page.getByRole('combobox',{name:'Search products'});await input.fill('apples');
  await page.getByRole('option').first().waitFor();await input.press('ArrowDown');await input.press('Enter');await page.waitForLoadState('domcontentloaded');
  assert.ok(page.url().endsWith('/products/apples'));
  const theme=await page.locator('#publication-state').evaluate(el=>JSON.parse(el.textContent).theme);
  await page.route('**/api/**',route=>route.fulfill({json:[]}));
  await page.route('**/api/v1/customer/auth/refresh',route=>route.fulfill({status:401,json:{error:'Unauthorized'}}));
  await page.route('**/api/v1/theme/*',route=>route.fulfill({json:{configuration:theme,cities:[]}}));
  await page.route('**/api/v1/content/*',route=>route.fulfill({json:{key:'fixture',title:'',blocks:[]}}));
  await page.route('**/api/v1/search?*',route=>route.fulfill({json:{hits:[],total:0,offset:0,limit:20,facets:{}}}));
  await page.route('**/api/v1/cart',route=>route.fulfill({json:{id:'11111111-1111-4111-8111-111111111111',items:[],subtotal:'0.00',total:'0.00',currency:'USD'}}));
  await page.goto(`${base}/account`);await page.getByRole('heading',{name:'Login',exact:true}).waitFor();
  await page.goto(`${base}/cart`);await page.getByRole('heading',{name:'Your shopping cart is empty',exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  const nojs=await browser.newContext({javaScriptEnabled:false});
  const raw=await nojs.newPage();for(const [path,title] of [['/products/apples','Orchard apples'],['/categories/fruit','Fresh fruit'],['/pages/about','About our store']]){const response=await raw.goto(base+path);assert.equal(response.status(),200);assert.equal(await raw.locator('h1').last().textContent(),title);}
  assert.equal((await raw.goto(`${base}/products/missing`)).status(),404);assert.equal((await raw.goto(`${base}/products/retired`)).status(),410);
  console.log('Hydration, document navigation, no-session startup and JavaScript-disabled pages passed');
} finally {await browser.close();proxy.close();}
