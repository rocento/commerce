import {chromium, expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
const root=process.env.ADMIN_BASE_URL || 'http://127.0.0.1:5278';
const category={id:'cat',name:'Jewelry',slug:'jewelry',parent_id:null};
const product={id:'prod',sku:'RING',slug:'ring',name:'Ring',description:'Gold ring',price:'12.00',currency:'USD',unit:'each',category_id:'cat',category_ids:['cat'],attributes:{finish:'Polished'},media_ids:[],attribute_set_id:null,active:true,in_stock:true,product_type:'simple'};
const definition={id:'attr',entity_type:'product',attribute_code:'finish',label:'Finish',input_type:'select',scope:'global',options:[{value:'polished.gold',label:'Polished gold'}],swatch_type:'none',metadata:{description:'Surface finish'},version:1,is_required:false,is_unique:false,is_searchable:false,is_filterable:false,is_comparable:false,is_visible_on_front:true,used_for_promo_rules:false,used_for_configurations:false};
const sources={product:{name:'Ring',description:'Gold ring','attribute.finish':'Polished','__label.attribute.finish':'Finish'},category:{name:'Jewelry','attribute.intro':'Handcrafted pieces','__label.attribute.intro':'Introduction'},attribute:{label:'Finish',description:'Surface finish','option.polished.gold':'Polished gold'}};
const browser=await chromium.launch({headless:true});
await mkdir('test-results/catalog-translations',{recursive:true});
try {
 for (const width of [1440,390]) {
  const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();
  const errors=[],writes=[],saved={};let conflict=false;
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',async route=>{
   const req=route.request(),url=new URL(req.url()),path=url.pathname;
   if(req.method()!=='GET') writes.push(path);
   if(path.endsWith('/admin/me')) return route.fulfill({json:{user:{id:'test',name:'Translator',email:'test@example.test',active:true},permissions:['catalog.read','catalog.write','languages.read','languages.write','attributes.read','attributes.write']}});
   if(path.endsWith('/admin/languages')) return route.fulfill({json:{source_locale:'en',languages:[{locale:'ar',name:'Arabic',native_name:'العربية',direction:'rtl',revision:1},{locale:'fr',name:'French',native_name:'Français',direction:'ltr',revision:1}],publication_available:false}});
   if(path.endsWith('/ar/translations')) return route.fulfill({json:{items:[{entity_id:'cat',fields:saved['ar/translations/category/cat']?.fields??{}}],total:1,offset:0,limit:100}});
   if(path.includes('/translations/')) {
    const parts=path.split('/'),kind=parts.at(-2),key=parts.slice(-4).join('/');
    if(req.method()==='PUT') {
     if(conflict) return route.fulfill({status:409,json:{error:'Conflict'}});
     const input=req.postDataJSON();expect(input.source).toEqual(sources[kind]);
     saved[key]={...input,revision:(saved[key]?.revision??0)+1,status:input.reviewed?'reviewed':'draft'};
     return route.fulfill({json:saved[key]});
    }
    return route.fulfill({json:{entity_id:parts.at(-1),name:kind,source:sources[kind],fields:{},revision:0,status:'missing',...saved[key]}});
   }
   if(path.endsWith('/admin/catalog/products/prod')) return route.fulfill({json:product});
   if(path.endsWith('/admin/catalog/categories')) return route.fulfill({json:[category]});
   if(path.endsWith('/admin/attribute-definitions')) return route.fulfill({json:url.searchParams.get('entity_type')==='product'?[definition]:url.searchParams.get('entity_type')==='category'?[{...definition,id:'intro',entity_type:'category',attribute_code:'intro',label:'Introduction',input_type:'textarea',options:[]}]:[]});
   if(path.endsWith('/categories/cat/attributes')) return route.fulfill({json:{intro:'Handcrafted pieces'}});
   if(path.endsWith('/family')) return route.fulfill({json:{product,children:[],structure:{product_type:'simple',children:[],configurable_attributes:[]}}});
   if(['/sources','/items','/attribute-sets','/media','/attributes'].some(suffix=>path.endsWith(suffix))) return route.fulfill({json:[]});
   return route.fulfill({status:404,json:{error:'Not configured'}});
  });
  async function translate(label,text) {
   await page.getByRole('checkbox',{name:`Use source value for ${label.toLowerCase()}`,exact:true}).uncheck();
   const field=page.getByLabel(`${label} · Arabic`,{exact:true});
   await field.fill(text);await expect(field).toHaveAttribute('dir','rtl');
  }
  await page.goto(`${root}/catalog/products/prod`);
  await page.getByLabel('Content language',{exact:true}).waitFor({timeout:10000}).catch(async error=>{console.log(errors,await page.locator('body').innerText());throw error;});
  await page.getByLabel('Content language',{exact:true}).selectOption('ar');
  await expect(page.getByRole('complementary',{name:'Product sections'})).toBeVisible();
  await expect(page.getByLabel('SKU',{exact:true})).toBeDisabled();
  await translate('Product name','خاتم');await translate('Description','خاتم ذهب');
  await page.getByRole('button',{name:'Attributes',exact:true}).click();await translate('Finish','لامع');
  await page.getByRole('button',{name:'Pricing',exact:true}).click();await expect(page.getByLabel('Price (USD)',{exact:true})).toBeDisabled();
  await page.getByLabel('Content language',{exact:true}).selectOption('fr');await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button',{name:'Keep editing',exact:true}).click();await expect(page.getByLabel('Content language',{exact:true})).toHaveValue('ar');
  await page.getByRole('checkbox',{name:'I reviewed this translation against the current source'}).check();
  await page.getByRole('button',{name:'Save reviewed translation',exact:true}).click();await expect(page.getByText('Arabic translation saved and reviewed.',{exact:true})).toBeVisible();
  expect(saved['ar/translations/product/prod'].fields).toEqual({name:'خاتم',description:'خاتم ذهب','attribute.finish':'لامع'});
  await page.getByRole('button',{name:'Information',exact:true}).click();await page.screenshot({path:`test-results/catalog-translations/product-${width}.png`,fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByLabel('Content language',{exact:true}).selectOption('');await expect(page.getByLabel('Product name',{exact:true})).toHaveValue('Ring');
  await page.getByLabel('Product name',{exact:true}).fill('Unsaved source');await page.getByLabel('Content language',{exact:true}).selectOption('ar');
  await page.getByRole('button',{name:'Discard and switch',exact:true}).click();await expect(page.getByLabel('Product name · Arabic',{exact:true})).toHaveValue('خاتم');
  await page.goto(`${root}/catalog/categories/cat`);await page.getByLabel('Content language',{exact:true}).selectOption('ar');
  await translate('Category name','مجوهرات');await translate('Introduction','قطع يدوية');
  await expect(page.getByLabel('URL key',{exact:true})).toBeDisabled();await expect(page.getByRole('tree',{name:'Categories',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Save translation draft',exact:true}).click();await expect(page.getByText('Arabic translation saved as a draft.',{exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'مجوهرات',exact:true})).toBeVisible();
  await expect(page.getByRole('treeitem',{name:'مجوهرات',exact:true})).toBeVisible();
  await page.getByRole('searchbox',{name:'Search categories',exact:true}).fill('مجوهرات');await expect(page.getByRole('treeitem',{name:'مجوهرات',exact:true})).toBeVisible();
  await page.getByRole('searchbox',{name:'Search categories',exact:true}).fill('Jewelry');await expect(page.getByRole('treeitem',{name:'مجوهرات',exact:true})).toBeVisible();
  await page.getByRole('searchbox',{name:'Search categories',exact:true}).fill('');
  await page.screenshot({path:`test-results/catalog-translations/category-${width}.png`,fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.goto(`${root}/catalog/attributes/definitions/attr`);await page.getByLabel('Content language',{exact:true}).selectOption('ar');
  await translate('Label','التشطيب');await translate('Description','تشطيب السطح');await translate('Option 1 label','ذهبي لامع');
  await expect(page.getByLabel('Option 1 value',{exact:true})).toHaveValue('polished.gold');await expect(page.getByLabel('Option 1 value',{exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Add option',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Save translation draft',exact:true}).click();await expect(page.getByText('Arabic translation saved as a draft.',{exact:true})).toBeVisible();
  await page.screenshot({path:`test-results/catalog-translations/attribute-${width}.png`,fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByLabel('Label · Arabic',{exact:true}).fill('تغيير');conflict=true;
  await page.getByRole('button',{name:'Save translation draft',exact:true}).click();await expect(page.getByText(/This content changed in another session/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Save translation draft',exact:true})).toBeDisabled();
  expect(writes.every(path=>path.includes('/translations/'))).toBe(true);expect(errors).toEqual([]);await context.close();
 }
 console.log('Catalog translations: desktop/mobile product, category, attribute, RTL, shared settings, source preservation, dirty switching, save and conflict checks passed.');
} finally {await browser.close();}
