import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const browser=await chromium.launch();
const output='../output/category-layout';
await mkdir(output,{recursive:true});
try {
  for(const route of ['/', '/published'])for(const width of [320,390,768,1440]){
    const page=await browser.newPage({viewport:{width,height:900}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:4187${route}`,{waitUntil:'networkidle'});
    const grid=page.locator('.theme-category-showcase').first();
    await grid.waitFor();
    assert.equal(await grid.locator('a').count(),8);
    const geometry=await grid.evaluate(el=>({columns:getComputedStyle(el).gridTemplateColumns.split(' ').length,images:[...el.querySelectorAll('img')].map(i=>({width:i.getBoundingClientRect().width,height:i.getBoundingClientRect().height,fit:getComputedStyle(i).objectFit})),scrollWidth:document.documentElement.scrollWidth}));
    assert.equal(geometry.columns,width>1024?8:width>640?4:2);
    assert.ok(geometry.scrollWidth<=width+1,'No horizontal page overflow');
    geometry.images.forEach(i=>{assert.ok(Math.abs(i.width-i.height)<1,'Category image frame stays square');assert.equal(i.fit,'contain','Full artwork remains visible');});
    await grid.locator('img').first().scrollIntoViewIfNeeded();
    await grid.locator('img').first().evaluate(image=>image.decode());
    assert.deepEqual(errors,[]);
    if(width===1440)await grid.screenshot({path:`${output}/${route==='/'?'interactive':'published'}-desktop.png`});
    if(width===390)await grid.screenshot({path:`${output}/${route==='/'?'interactive':'published'}-mobile.png`});
    await page.close();
  }
  const rtl=await browser.newPage({viewport:{width:390,height:900}});
  await rtl.goto('http://127.0.0.1:4187/published?lang=ar',{waitUntil:'networkidle'});
  assert.equal(await rtl.locator('.store-shell').getAttribute('dir'),'rtl');
  assert.ok(await rtl.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await rtl.close();
  console.log('Passed: square uncropped category tiles; desktop/tablet/mobile columns; both storefront renderers; RTL; no overflow or runtime errors.');
}finally{await browser.close();}
