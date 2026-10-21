import { chromium, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
const catalog=JSON.parse(await readFile(new URL('../../commerce-api/interface-messages.json',import.meta.url),'utf8'));
const browser=await chromium.launch({headless:true});
await mkdir('test-results/interface-translations',{recursive:true});
try {
  for(const width of [1440,390]) {
    const context=await browser.newContext({viewport:{width,height:1000}}), page=await context.newPage();
    const errors=[];page.on('pageerror',error=>{errors.push(error.stack); console.error(error.stack);});
    let revision=1,overrides=[],imports=0;
    const translated='أضف الآن،\nإلى السلة';
    await page.route('**/api/**',async route=>{
      const req=route.request(),url=new URL(req.url()),method=req.method();
      if(url.pathname.endsWith('/admin/me'))return route.fulfill({json:{user:{id:'test',name:'Translator',email:'test@example.test',role_id:'test',active:true},permissions:['languages.read','languages.write']}});
      if(url.pathname.endsWith('/admin/languages'))return route.fulfill({json:{source_locale:'en',languages:[],publication_available:false}});
      if(url.pathname.endsWith('/interface')) {
        if(method==='GET')return route.fulfill({json:{revision,catalog_version:'v1',messages:catalog.messages.map(m=>({...m,plural:m.plural??null})),overrides}});
        const body=req.postDataJSON();expect(body.expected_revision).toBe(revision);expect(req.headers()['x-commerce-request']).toBe('1');
        const source=catalog.messages.find(m=>m.key===body.key)[body.locale][body.form];
        overrides=body.text===null?[]:[{key:body.key,locale:body.locale,form:body.form,text:body.text,source_text:source}];
        return route.fulfill({json:{revision:++revision,changed:1}});
      }
      if(url.pathname.endsWith('/interface/preview')) {
        const valid=!req.postDataJSON().csv.includes('INVALID');
        return route.fulfill({json:{revision,catalog_version:'v1',changes:valid?[{key:'cart.add',locale:'ar',form:'other',before:overrides[0]?.text||'أضف إلى السلة',after:translated}]:[],errors:valid?[]:[{row:2,field:'ar',message:'Keep exactly these placeholders: {name}'}]}});
      }
      if(url.pathname.endsWith('/interface/import')) {
        imports++;expect(req.postDataJSON().expected_revision).toBe(revision);expect(req.headers()['x-commerce-request']).toBe('1');
        overrides=[{key:'cart.add',locale:'ar',form:'other',text:translated,source_text:'أضف إلى السلة'}];return route.fulfill({json:{revision:++revision,changed:1}});
      }
      if(url.pathname.endsWith('/interface/export'))return route.fulfill({contentType:'text/csv; charset=utf-8',headers:{'Content-Disposition':'attachment; filename=storefront-interface.csv'},body:'\uFEFFkey,form,en,ar\ncart.add,other,Add to cart,"أضف الآن،\nإلى السلة"\n'});
      return route.fulfill({status:404,json:{error:'Not configured'}});
    });
    await page.goto(process.env.ADMIN_BASE_URL||'http://127.0.0.1:5274/settings/languages');
    await page.getByRole('button',{name:'Shopping interface',exact:true}).click();
    await page.getByLabel('Search phrases or keys').fill('cart.add');
    await page.getByRole('row').filter({has:page.getByText('cart.add',{exact:true})}).getByRole('button',{name:'Edit',exact:true}).click();
    await page.getByLabel('Translation',{exact:true}).fill('أضف المنتج',{timeout:5000}).catch(async error=>{await page.screenshot({path:`test-results/interface-translations/failure-${width}.png`,fullPage:true});console.error(await page.locator('main').innerText());throw error;});
    await expect(page.getByLabel('Phrase preview')).toHaveText('أضف المنتج');
    await page.getByRole('button',{name:'Save phrase',exact:true}).click();
    await expect(page.getByRole('cell',{name:/Custom translation$/})).toBeVisible();
    await page.getByLabel('Import interface CSV').setInputFiles({name:'invalid.csv',mimeType:'text/csv',buffer:Buffer.from('key,ar\ncart.remove_item,INVALID')});
    await expect(page.getByRole('alert')).toContainText('Keep exactly these placeholders');
    await expect(page.getByRole('button',{name:'Apply 0 changes'})).toBeDisabled();expect(imports).toBe(0);
    await page.getByRole('button',{name:'Cancel import'}).click();
    await page.getByLabel('Import interface CSV').setInputFiles({name:'valid.csv',mimeType:'text/csv',buffer:Buffer.from('key,form,ar\ncart.add,other,"أضف الآن،\nإلى السلة"')});
    await expect(page.getByRole('button',{name:'Apply 1 changes'})).toBeEnabled();expect(imports).toBe(0);
    await page.screenshot({path:`test-results/interface-translations/preview-${width}.png`,fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.getByRole('button',{name:'Apply 1 changes'}).click();
    await expect(page.getByText('1 interface translations saved as drafts.',{exact:true})).toBeVisible();expect(imports).toBe(1);
    const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export CSV'}).click();
    const csv=await download;expect(csv.suggestedFilename()).toBe('storefront-interface.csv');expect(await readFile(await csv.path(),'utf8')).toContain('أضف الآن');
    await page.getByLabel('Search phrases or keys').fill('cart.item_count');
    await expect(page.getByRole('button',{name:'Edit',exact:true})).toHaveCount(6);
    expect(errors).toEqual([]);await context.close();
  }
  console.log('Interface translations: desktop/mobile editing, invalid import blocking, preview-before-apply, CSV export and six Arabic plural forms passed.');
} finally {await browser.close();}
