import { chromium, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
const catalog = JSON.parse(await readFile(new URL('../../commerce-api/interface-messages.json', import.meta.url),'utf8'));
const browser = await chromium.launch({headless:true});
await mkdir('test-results/language-markets',{recursive:true});
try {
  for (const width of [1440,390]) {
    const context = await browser.newContext({viewport:{width,height:1000}});
    const page = await context.newPage(), errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    let languageConflict=true, translationConflict=true, phraseConflict=true, translationReads=0;
    let languages = [{locale:'ar',name:'Arabic',native_name:'العربية',direction:'rtl',revision:1},{locale:'fr',name:'French',native_name:'Français',direction:'ltr',revision:1}], marketReads = 0;
    const markets = [{id:'eg',name:'Egypt',country:'EG',currency:'EGP',locales:['en','ar'],default_locale:'ar',revision:2},{id:'us',name:'United States',country:'US',currency:'USD',locales:['en'],default_locale:'en',revision:1}];
    const permissions = ['languages.read','languages.write','markets.read','markets.write','catalog.read','catalog.write'];
    await page.route('**/api/**',async route=>{
      const req=route.request(),path=new URL(req.url()).pathname;
      if(path.endsWith('/admin/me')) return route.fulfill({json:{user:{id:'test',name:'Manager',email:'manager@example.test',active:true},permissions}});
      if(path.endsWith('/admin/languages')) {
        if(req.method()==='POST') {if(languageConflict){languageConflict=false;return route.fulfill({status:409,json:{error:'Conflict'}});} const {expected_revision,...input}=req.postDataJSON();expect(expected_revision).toBe(1);languages=languages.map(item=>item.locale===input.locale?{...input,revision:2}:item);return route.fulfill({json:languages.find(item=>item.locale===input.locale)});}
        return route.fulfill({json:{source_locale:'en',languages,publication_available:false}});
      }
      if(path.endsWith('/admin/markets')) {marketReads++;return route.fulfill({json:{items:markets,locales:['en','ar','fr'],live:{region:'EG',currency:'EGP'},source_locale:'en',activation_available:true}});}
      if(path.endsWith('/translations/product/prod')) {
        if(req.method()==='PUT') {if(translationConflict){translationConflict=false;return route.fulfill({status:409,json:{error:'Conflict'}});}const input=req.postDataJSON();expect(input.expected_revision).toBe(3);return route.fulfill({json:{revision:4,status:input.reviewed?'reviewed':'draft'}});}
        translationReads++;return route.fulfill({json:{entity_id:'prod',name:'Apple',source:{name:'Apple updated'},fields:{name:'تفاح حديث'},revision:3,status:'reviewed'}});
      }
      if(path.endsWith('/translations')) return route.fulfill({json:{items:[{entity_id:'prod',name:'Apple',source:{name:'Apple'},fields:{},revision:0,status:'missing'}],total:1,missing:1,draft:0,reviewed:0,needs_review:0,offset:0,limit:50}});
      if(path.endsWith('/interface')) {
        if(req.method()==='PUT') {if(phraseConflict){phraseConflict=false;return route.fulfill({status:409,json:{error:'Conflict'}});}return route.fulfill({json:{revision:2,changed:1}});}
        return route.fulfill({json:{revision:1,catalog_version:'v1',messages:catalog.messages.map(message=>({...message,plural:message.plural??null})),overrides:[]}});
      }
      return route.fulfill({status:404,json:{error:'Not configured'}});
    });
    await page.goto('http://127.0.0.1:5274/settings/languages');
    const registry=page.getByRole('region',{name:'Language registry'});
    await expect(registry.getByRole('row')).toHaveCount(4);
    const arabic=registry.getByRole('row').filter({has:page.getByText('العربية',{exact:true})});
    await expect(arabic).toContainText('Egypt');await expect(arabic).toContainText('Default');
    await expect(registry.getByRole('row').filter({has:page.getByText('Français',{exact:true})})).toContainText('Unassigned');
    await page.getByLabel('Market',{exact:true}).selectOption('us');await expect(registry.getByRole('row')).toHaveCount(2);
    await page.getByLabel('Market',{exact:true}).selectOption('eg');await expect(registry.getByRole('row')).toHaveCount(3);
    await page.getByLabel('Search languages').fill('العربية');await expect(registry.getByRole('row')).toHaveCount(2);
    await page.getByLabel('Search languages').fill('');await page.getByLabel('Market',{exact:true}).selectOption('');
    await page.screenshot({path:`test-results/language-markets/registry-${width}.png`,fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await arabic.getByRole('button',{name:'Edit language'}).click();
    await expect(page.getByLabel('Locale code')).toBeDisabled();await page.getByLabel('Language name',{exact:true}).fill('Arabic updated');
    await expect(page.getByRole('button',{name:'Shopping interface',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'Save language',exact:true}).click();
    await expect(page.getByRole('button',{name:'Save language',exact:true})).toBeDisabled();
    page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Reload latest version'}).click();
    await expect(page.getByLabel('Language name',{exact:true})).toHaveValue('Arabic');
    await page.getByLabel('Language name',{exact:true}).fill('Arabic updated');
    await page.getByRole('button',{name:'Save language',exact:true}).click();await expect(registry).toContainText('Arabic updated');
    expect(marketReads).toBeGreaterThan(1);
    await arabic.getByRole('button',{name:'Translations',exact:true}).click();await page.getByRole('button',{name:'Translate',exact:true}).click();
    await page.getByLabel('Name · Arabic updated',{exact:true}).fill('تفاح');
    await expect(page.getByRole('button',{name:'Shopping interface',exact:true})).toBeDisabled();
    page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'Back to list'}).click();await expect(page.getByLabel('Name · Arabic updated')).toHaveValue('تفاح');
    page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Back to list'}).click();
    await page.getByRole('button',{name:'Translate',exact:true}).click();
    await page.getByLabel('Name · Arabic updated',{exact:true}).fill('تفاح');
    await page.getByRole('button',{name:'Save draft',exact:true}).click();
    page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Reload latest version'}).click();
    await expect(page.getByLabel('Name · Arabic updated')).toHaveValue('تفاح حديث');
    await expect(page.getByRole('checkbox',{name:'I reviewed this translation against the current source'})).toBeChecked();
    await expect(page.getByRole('button',{name:'Save reviewed translation'})).toBeDisabled();
    await page.getByLabel('Name · Arabic updated').fill('تفاح جديد');
    await expect(page.getByRole('checkbox',{name:'I reviewed this translation against the current source'})).not.toBeChecked();
    await page.getByRole('button',{name:'Save draft',exact:true}).click();expect(translationReads).toBe(1);
    await page.getByRole('button',{name:'Shopping interface',exact:true}).click();
    await expect(page.locator('.interface-workspace tbody tr')).toHaveCount(50);
    await page.getByRole('button',{name:'Next',exact:true}).click();await expect(page.locator('.interface-workspace tbody tr')).toHaveCount(50);
    await page.getByLabel('Search phrases or keys').fill('cart.add');
    await page.getByRole('row').filter({has:page.getByText('cart.add',{exact:true})}).getByRole('button',{name:'Edit',exact:true}).click();
    await page.getByLabel('Translation',{exact:true}).fill('أضف المنتج');
    await expect(page.getByRole('button',{name:'Languages & content',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'Save phrase',exact:true}).click();
    await expect(page.getByRole('button',{name:'Save phrase',exact:true})).toBeDisabled();
    page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'Reload latest version'}).click();await expect(page.getByLabel('Translation',{exact:true})).toHaveValue('أضف المنتج');
    page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Reload latest version'}).click();
    await page.getByLabel('Translation',{exact:true}).fill('أضف المنتج الآن');
    await page.getByRole('button',{name:'Save phrase',exact:true}).click();await expect(page.getByRole('button',{name:'Languages & content',exact:true})).toBeEnabled();
    await page.goto('http://127.0.0.1:5274/settings/markets');
    await page.getByRole('button',{name:'Add market',exact:true}).click();
    await expect(page.getByLabel('Default language',{exact:true})).toHaveValue('en');
    await expect(page.locator('.market-languages input[type=checkbox]').first()).toBeChecked();
    expect(errors).toEqual([]);await context.close();
  }
  // Language access alone must not trigger a protected markets request.
  const page=await browser.newPage();let marketReads=0;
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/admin/me'))return route.fulfill({json:{user:{id:'viewer',name:'Viewer',email:'viewer@example.test',active:true},permissions:['languages.read']}});
    if(path.endsWith('/admin/languages'))return route.fulfill({json:{source_locale:'en',languages:[],publication_available:false}});
    if(path.endsWith('/admin/markets'))marketReads++;
    return route.fulfill({status:403,json:{error:'Forbidden'}});
  });
  await page.goto('http://127.0.0.1:5274/settings/languages');
  await expect(page.getByText('Source · Fallback',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Market',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Add language',exact:true})).toHaveCount(0);expect(marketReads).toBe(0);
  console.log('Language markets: desktop/mobile assignments, defaults, filters, edit/save, unsaved drafts, interface pagination, conflict recovery, review status, new-market default and permissions passed.');
} finally {await browser.close();}
