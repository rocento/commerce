import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const output='../output/electronics-performance';
await mkdir(output,{recursive:true});
const browser=await chromium.launch();
const reports=[];
try {
  for(const scale of [1.75,3]) for(const optimized of [false,true]) {
    const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:scale});
    const page=await context.newPage(),errors=[],requests=[],deliveryTheme=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{requests.push(request.url());if(request.url().includes('/api/v1/theme/storefront')&&request.headers()['x-delivery-latitude']==='30')deliveryTheme.push(request.url());});
    await page.addInitScript(()=>{
      sessionStorage.setItem('commerce-guest-location',JSON.stringify({location_method:'pin',latitude:30,longitude:31,formatted_address:'Demo delivery area',label:'home'}));
      window.fixtureLcp=0;
      new PerformanceObserver(list=>{window.fixtureLcp=list.getEntries().at(-1)?.startTime||0;}).observe({type:'largest-contentful-paint',buffered:true});
    });
    await page.goto(`http://127.0.0.1:${optimized?4186:4185}`,{waitUntil:'networkidle'});
    const hero=page.locator('.theme-editorial-hero > img');
    await hero.waitFor({timeout:10000}).catch(async error=>{console.error({url:page.url(),errors,text:await page.locator('body').innerText()});throw error;});
    await hero.evaluate(async image=>{await image.decode();});
    const image=await hero.evaluate(i=>({url:i.currentSrc,loaded:i.complete&&i.naturalWidth>0,srcset:i.srcset,priority:i.fetchPriority}));
    assert.ok(image.loaded);
    assert.equal(image.priority,'high');
    assert.equal(requests.filter(url=>url===image.url).length,1,'Hero has one download after delivery selection');
    assert.equal(deliveryTheme.length,1,'One theme request for the selected delivery area');
    if(optimized)assert.match(image.url,new RegExp(`width=${scale===3?1254:960}$`));
    else assert.ok(!image.srcset);
    const resources=await page.evaluate(()=>performance.getEntriesByType('resource').filter(r=>r.name.includes('/catalog/media/')).map(r=>({url:r.name,bytes:r.transferSize,body:r.encodedBodySize,start:r.startTime,end:r.responseEnd})));
    reports.push({scale,optimized,hero:image.url,imageBytes:resources.reduce((total,r)=>total+r.body,0),lcp:await page.evaluate(()=>window.fixtureLcp),resources});
    assert.deepEqual(errors,[]);
    if(optimized&&scale===1.75)await page.screenshot({path:`${output}/optimized-mobile.png`,fullPage:true});
    await page.locator('.store-header button[aria-controls=header-search]').click();
    await page.getByRole('combobox',{name:'Search products'}).fill('phone');
    await page.getByRole('option').first().waitFor();
    await context.close();
  }
  for(const scale of [1.75,3]) {
    const original=reports.find(r=>r.scale===scale&&!r.optimized);
    const optimized=reports.find(r=>r.scale===scale&&r.optimized);
    assert.ok(optimized.imageBytes<original.imageBytes*.2,'Image transfer reduces at least 80%');
  }
  await writeFile(`${output}/browser-comparison.json`,JSON.stringify(reports,null,2));
  console.log(JSON.stringify(reports.map(({scale,optimized,imageBytes,lcp})=>({scale,optimized,imageBytes,lcp})),null,2));
} finally {await browser.close();}
