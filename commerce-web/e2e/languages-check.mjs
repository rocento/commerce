import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({headless:true});
await mkdir('test-results/languages',{recursive:true});
try {
  for (const width of [1440,390]) {
    const context=await browser.newContext({viewport:{width,height:1000}});
    const page=await context.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    let languages=[], rows=[{entity_id:'00000000-0000-0000-0000-000000000007',name:'Fresh apple',source:{name:'Fresh apple',description:'Organic fruit'},fields:{},revision:0,status:'missing'}];
    let saved;
    await page.route('**/api/**',async route=>{
      const req=route.request(), url=new URL(req.url());
      if(url.pathname.endsWith('/admin/me')) return route.fulfill({json:{user:{id:'test',name:'Language manager',email:'test@example.test',role_id:'test',active:true},permissions:['languages.read','languages.write','catalog.read','catalog.write']}});
      if(url.pathname.endsWith('/admin/languages')) {
        if(req.method()==='POST') { const {expected_revision,...body}=req.postDataJSON(); const value={...body,revision:expected_revision+1};languages=[value];return route.fulfill({json:value}); }
        return route.fulfill({json:{source_locale:'en',languages,publication_available:false}});
      }
      if(url.pathname.endsWith('/translations')) return route.fulfill({json:{items:rows,total:1,missing:rows[0].revision?0:1,reviewed:rows[0].status==='reviewed'?1:0,draft:0,needs_review:0,offset:0,limit:50}});
      if(url.pathname.includes('/translations/product/')) {saved=req.postDataJSON();rows=[{...rows[0],fields:saved.fields,revision:1,status:saved.reviewed?'reviewed':'draft'}];return route.fulfill({json:{revision:1,status:rows[0].status}});}
      return route.fulfill({status:404,json:{error:'Not configured'}});
    });
    await page.goto(process.env.ADMIN_BASE_URL || 'http://127.0.0.1:5274/settings/languages');
    await expect(page.getByRole('heading',{name:'Languages',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Add language',exact:true}).click();
    await expect(page.getByLabel('Native name',{exact:true})).toHaveValue('العربية');
    await page.getByRole('button',{name:'Save language',exact:true}).click();
    await page.getByRole('button',{name:'Translate',exact:true}).click();
    await page.getByLabel('Name · Arabic',{exact:true}).fill('تفاح طازج');
    await page.getByLabel('Description · Arabic',{exact:true}).fill('فاكهة عضوية');
    await page.getByText('Preview translated text',{exact:true}).click();
    await expect(page.locator('.translation-preview')).toHaveAttribute('dir','rtl');
    await expect(page.locator('.translation-preview')).toContainText('تفاح طازج');
    await page.getByRole('checkbox',{name:'I reviewed this translation against the current source'}).check();
    await page.screenshot({path:`test-results/languages/editor-${width}.png`,fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.getByRole('button',{name:'Save reviewed translation',exact:true}).click();
    await expect(page.getByRole('cell',{name:/^(Status )?Reviewed$/})).toBeVisible();
    expect(saved).toEqual({expected_revision:0,source:{name:'Fresh apple',description:'Organic fruit'},fields:{name:'تفاح طازج',description:'فاكهة عضوية'},reviewed:true});
    expect(errors).toEqual([]);
    await context.close();
  }
  console.log('Language editor: desktop/mobile creation, Arabic preview, review and save passed.');
} finally { await browser.close(); }
