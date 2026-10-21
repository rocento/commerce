// Run against storefront-live-preview.mjs, which blocks shopping writes.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const base=process.env.STOREFRONT_PERFORMANCE_URL || 'http://127.0.0.1:4183';
const browser=await chromium.launch();
try {
  const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1.75});
  const page=await context.newPage(), errors=[], requests=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>requests.push(request.url()));
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await page.getByRole('heading',{name:'Good food. Everyday.'}).waitFor();
  await page.waitForTimeout(1500);
  const logo=await page.locator('.recento-brand-logo').first().evaluate(i=>({url:i.currentSrc,loaded:i.complete&&i.naturalWidth>0}));
  const hero=await page.locator('.theme-hero>img').evaluate(i=>({url:i.currentSrc,loaded:i.complete&&i.naturalWidth>0}));
  assert.ok(logo.loaded&&hero.loaded);
  assert.match(logo.url,/rocento-logo-320-/);
  assert.match(hero.url,/theme-default-800-/);
  assert.equal(requests.filter(url=>url.includes('/api/v1/theme/storefront')).length,1,'guest startup must reuse its early theme request');
  assert.equal(requests.filter(url=>url===hero.url).length,1,'hero preload and img must share one request');
  const timing=await page.evaluate(()=>performance.getEntriesByType('resource').map(r=>({name:r.name,start:r.startTime,end:r.responseEnd})));
  const theme=timing.find(r=>r.name.includes('/api/v1/theme/storefront'));
  const app=timing.find(r=>/\/assets\/app-[^/]+\.js$/.test(r.name));
  assert.ok(theme.start<app.end,'theme starts before the application finishes downloading');
  await page.locator('.mobile-search-toggle').click();
  const input=page.getByRole('combobox',{name:'Search products'});
  await input.fill('apple');
  await page.getByRole('option').first().waitFor();
  await input.press('Escape');
  assert.deepEqual(errors,[]);
  await page.screenshot({path:'../output/storefront-performance-live-2026-10-02/final-mobile.png'});
  // Theme request failure is retryable by the normal application path.
  const recovery=await context.newPage();let calls=0;
  await recovery.route('**/api/v1/theme/storefront',route=>++calls===1?route.abort():route.continue());
  await recovery.goto(base,{waitUntil:'domcontentloaded'});
  await recovery.getByRole('heading',{name:'Good food. Everyday.'}).waitFor();
  assert.equal(calls,2);
  const delayed=await context.newPage();
  await delayed.route('**/api/v1/customer/auth/refresh', async route=>{await new Promise(resolve=>setTimeout(resolve,1500));await route.fulfill({status:401,json:{error:'Signed out'}});});
  await delayed.goto(base,{waitUntil:'domcontentloaded'});
  await delayed.locator('.storefront-page-loading').waitFor();
  const footer=await delayed.locator('footer.theme-footer').boundingBox();
  assert.ok(footer.y>=844,'loading must keep the footer below the viewport');
  await delayed.getByRole('heading',{name:'Good food. Everyday.'}).waitFor();
  console.log('Passed: early theme, one guest request, responsive images, one hero download, mobile search, failed-warmup recovery, no runtime errors.');
} finally { await browser.close(); }
