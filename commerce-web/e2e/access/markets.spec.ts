import { test, expect, type Page } from '@playwright/test';
const id='20000000-0000-0000-0000-000000000002';
const category={id,name:'Fruit',slug:'fruit',parent_id:null};
const product={id,name:'Apples',description:'Fresh apples',sku:'APPLE',slug:'apples',price:'12',currency:'EGP',unit:'kg',category_id:id,category_ids:[id],attribute_set_id:null,attributes:{},media_ids:[],active:true,in_stock:true,product_type:'simple'};
const blocks=[{kind:'link',heading:'',text:'',image_id:null,link_label:'Shop',link_url:'/search',navigation:{icon:'',badge:'New',enabled:true,new_tab:false,columns:3,links:[{label:'Fruit',group:'Fresh',description:'Seasonal',url:'/categories/fruit',icon:'',new_tab:false}]}}];
const menuDocument={id,kind:'navigation',key:'navigation',version:1};
const revision={id,document_id:id,version:1,title:'Main menu',blocks};
async function setup(page:Page, permissions=['*']) {
 const marketId='30000000-0000-0000-0000-000000000003';
 const markets=[{id:marketId,name:'Saudi Arabia',country:'SA',currency:'SAR',locales:['en','ar'],default_locale:'ar',revision:1}];
 const overrides:Record<string,{available:boolean|null;price:string|null;revision:number}>={};
 const translations:Record<string,Record<string,unknown>>={};
 await page.route('**/api/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  let body:unknown=[];
  if(path.endsWith('/admin/me'))body={user:{id,name:'Admin',email:'admin@example.com'},permissions};
  else if(path.endsWith('/admin/markets')) {
   if(route.request().method()==='POST'){const input=route.request().postDataJSON();body={...input,revision:input.expected_revision+1};markets.push(body as typeof markets[number]);}
   else body={items:markets,live:{region:'EG',currency:'EGP'},locales:['en','ar'],activation_available:false};
  }
  else if(path.includes('/admin/markets/')) {
   const kind=path.split('/').at(-2);const source=kind==='product'?{name:'Apples',available:true,price:'12.00',currency:'EGP'}:{name:kind==='category'?'Fruit':'Main menu',available:true};
   if(route.request().method()==='PUT'){const input=route.request().postDataJSON();overrides[path]={available:input.available,price:input.price,revision:input.expected_revision+1};body={revision:input.expected_revision+1};}
   else body={source,currency:'SAR',override:overrides[path]??{available:null,price:null,revision:0}};
  }
  else if(path.endsWith('/admin/languages'))body={source_locale:'en',publication_available:false,languages:[{locale:'ar',name:'Arabic',native_name:'العربية',direction:'rtl',revision:1},{locale:'fr',name:'French',native_name:'Français',direction:'ltr',revision:1}]};
  else if(path.includes('/translations/')){
   const kind=path.split('/').at(-2);
   const source=kind==='product'?{name:'Apples',description:'Fresh apples'}:kind==='category'?{name:'Fruit'}:{title:'Main menu','__version':'1','item.0.label':'Shop','item.0.badge':'New','item.0.link.0.label':'Fruit','item.0.link.0.group':'Fresh','item.0.link.0.description':'Seasonal'};
   if(route.request().method()==='PUT') {const input=route.request().postDataJSON();translations[path]={entity_id:id,name:kind==='product'?'Apples':kind==='category'?'Fruit':'Main menu',source,fields:input.fields,revision:input.expected_revision+1,status:input.reviewed?'reviewed':'draft'};body={revision:input.expected_revision+1,status:input.reviewed?'reviewed':'draft'};}
   else body=translations[path]??{entity_id:id,name:kind==='product'?'Apples':kind==='category'?'Fruit':'Main menu',source,fields:{},revision:0,status:'missing'};
  }
  else if(path.endsWith('/family'))body={structure:{product_type:'simple',parent_id:null,variant_attributes:[],child_ids:[],groups:[]},children:[]};
  else if(path.endsWith('/categories'))body=[category];
  else if(path.endsWith(`/products/${id}`))body=product;
  else if(path.endsWith('/admin/content'))body=[menuDocument];
  else if(path.endsWith(`/admin/content/${id}`))body={document:menuDocument,revisions:[revision],releases:[]};
  else if(path.endsWith('/sorts'))body=['id'];
  else if(path.includes('/grids/'))body={items:[],total_count:0,next_cursor:null};
  else if(path.endsWith('/fulfillment/settings'))body={stores:[]};
  else if(path.endsWith('/attributes')&&path.includes(`/categories/${id}`))body={};
  await route.fulfill({json:body});
 });
}
const marketId='30000000-0000-0000-0000-000000000003';
for(const [kind,path] of [['product',`/catalog/products/${id}`],['category',`/catalog/categories/${id}`],['navigation','/content/navigation']] as const) {
 test(`${kind}: market override save, inheritance and scope protection`,async({page})=>{
  await setup(page);const writes:string[]=[];page.on('request',r=>{if(['PUT','POST'].includes(r.method()))writes.push(new URL(r.url()).pathname);});
  await page.goto(path);
  const marketControl=page.getByLabel('Market',{exact:true}),languageControl=page.getByLabel('Content language',{exact:true});
  await expect(languageControl).toBeVisible();
  const marketBox=await marketControl.boundingBox(),languageBox=await languageControl.boundingBox();
  expect(Math.abs(marketBox!.y-languageBox!.y)).toBeLessThan(1);expect(marketBox!.height).toBe(languageBox!.height);expect(marketBox!.width).toBe(languageBox!.width);
  await page.setViewportSize({width:390,height:844});await expect(languageControl).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.setViewportSize({width:1440,height:1000});await marketControl.selectOption(marketId);
  await expect(page.getByLabel('Content language')).toBeDisabled();
  await page.getByRole('combobox',{name:'Availability',exact:true}).selectOption('false');await expect(page.getByLabel('Market',{exact:true})).toBeDisabled();
  if(kind==='product'){await expect(page.getByText('A SAR price is required',{exact:false})).toBeVisible();await page.getByLabel('Use default price').uncheck();await page.getByLabel('Market price (SAR)',{exact:true}).fill('20.50');}
  await page.getByRole('button',{name:'Save market overrides'}).click();await expect(page.getByRole('status')).toContainText('Draft market overrides saved');
  await page.getByLabel('Market',{exact:true}).selectOption('');await page.getByLabel('Market',{exact:true}).selectOption(marketId);
  await expect(page.getByRole('combobox',{name:'Availability',exact:true})).toHaveValue('false');
  if(kind==='product')await expect(page.getByLabel('Market price (SAR)',{exact:true})).toHaveValue('20.50');
  await page.getByRole('combobox',{name:'Availability',exact:true}).selectOption('inherit');if(kind==='product')await page.getByLabel('Use default price').check();
  const request=page.waitForRequest(r=>r.method()==='PUT');await page.getByRole('button',{name:'Save market overrides'}).click();expect((await request).postDataJSON()).toMatchObject({available:null,price:null,expected_revision:1,currency:'SAR'});
  expect(writes.every(path=>path===`/api/v1/admin/markets/${marketId}/${kind}/${id}`)).toBe(true);
  await page.screenshot({path:`/tmp/market-${kind}.png`,fullPage:true});
 });
}
test('market creation and configured languages',async({page})=>{
 await setup(page);await page.goto('/settings/markets');await page.getByRole('button',{name:'Add market',exact:true}).click();await page.getByLabel('Market name').fill('United Arab Emirates');await page.getByRole('combobox',{name:'Country',exact:true}).selectOption('AE');await page.getByRole('combobox',{name:'Currency',exact:false}).selectOption('AED');await page.getByRole('checkbox',{name:'ar',exact:true}).check();await page.getByRole('combobox',{name:'Default language',exact:true}).selectOption('ar');
 const request=page.waitForRequest(r=>r.method()==='POST');await page.getByRole('button',{name:'Save draft market'}).click();expect((await request).postDataJSON()).toMatchObject({country:'AE',currency:'AED',locales:['en','ar'],default_locale:'ar',expected_revision:0});await expect(page.getByText('United Arab Emirates saved as a draft.')).toBeVisible();await page.screenshot({path:'/tmp/markets-settings.png',fullPage:true});
});
test('read-only market and mobile layout',async({page})=>{
 await setup(page,['markets.read','catalog.read','catalog.write']);await page.goto(`/catalog/products/${id}`);await page.getByLabel('Market',{exact:true}).selectOption(marketId);await expect(page.getByRole('combobox',{name:'Availability',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Save market overrides'})).toHaveCount(0);await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('conflict preserves draft until reload and source edits block market switch',async({page})=>{
 await setup(page);await page.route('**/admin/markets/*/product/*',async route=>{if(route.request().method()==='PUT')await route.fulfill({status:409,json:{error:'conflict'}});else await route.fallback();});
 await page.goto(`/catalog/products/${id}`);await page.getByRole('textbox',{name:'Product name',exact:true}).fill('Unsaved apples');await expect(page.getByLabel('Market',{exact:true})).toBeDisabled();await page.getByRole('textbox',{name:'Product name',exact:true}).fill('Apples');await page.getByLabel('Market',{exact:true}).selectOption(marketId);await page.getByLabel('Use default price').uncheck();await page.getByLabel('Market price (SAR)',{exact:true}).fill('44.50');await page.getByRole('button',{name:'Save market overrides'}).click();await expect(page.getByRole('alert')).toContainText('another session');await expect(page.getByLabel('Market price (SAR)',{exact:true})).toHaveValue('44.50');page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Reload latest values'}).click();await expect(page.getByLabel('Use default price')).toBeChecked();
});

async function publicationSetup(page:Page,ready=true,permissions=['*']) {
 await setup(page,permissions);
 const egypt={id:marketId,name:'Egypt',country:'EG',currency:'EGP',locales:['en'],default_locale:'en',revision:1};
 let published=false;
 await page.route('**/admin/markets',route=>route.fulfill({json:{items:[egypt],live:{region:'EG',currency:'EGP'},locales:['en','ar'],activation_available:true,active:{revision:published?2:1,market_id:published?marketId:null,release_id:published?'release':null,name:published?'Egypt':null,created_at:null}}}));
 await page.route('**/admin/markets/*/readiness',route=>route.fulfill({json:{token:'review-token',ready,active_revision:1,available_products:1,missing_prices:0,overridden_products:1,source_locale:'en',delivery:{amount:'3.00',currency:'EGP'},tax:[],checks:[{code:'country',ready,message:ready?'Existing Egypt delivery settings.':'Country setup required.'},{code:'currency',ready:true,message:'Checkout settles in EGP.'}]}}));
 await page.route('**/admin/markets/*/preview?*',route=>route.fulfill({json:{items:[{id,sku:'APPLE',name:'Apples',available:true,source_price:'12.00',source_currency:'EGP',price:'25.50',currency:'EGP',inherited:false}],total:1,offset:0,limit:25}}));
 await page.route('**/admin/markets/*/publish',route=>{published=true;return route.fulfill({json:{release_id:'release',revision:2}});});
 await page.route('**/admin/markets/restore-defaults',route=>{published=false;return route.fulfill({json:{revision:3}});});
}
test('reviews exact prices and explicitly publishes Egypt, then restores defaults',async({page})=>{
 await publicationSetup(page);await page.goto('/settings/markets');await page.getByRole('button',{name:'Review Egypt',exact:true}).click();
 await expect(page.getByRole('cell',{name:'25.50 EGP Override'})).toBeVisible();await expect(page.getByRole('button',{name:'Publish market',exact:true})).toBeDisabled();
 await page.getByRole('checkbox',{name:'I reviewed the prices',exact:false}).check();await page.getByLabel('Publication reason',{exact:true}).fill('Egypt launch reviewed');
 const publish=page.waitForRequest(r=>r.url().endsWith('/publish')&&r.method()==='POST');await page.getByRole('button',{name:'Publish market',exact:true}).click();expect((await publish).postDataJSON()).toEqual({token:'review-token',reason:'Egypt launch reviewed'});await expect(page.getByText('Egypt published to this storefront.',{exact:true})).toBeVisible();
 await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'/tmp/market-release-review.png',fullPage:true});
 await page.getByRole('button',{name:'Close review'}).click();await page.getByRole('button',{name:'Restore store defaults',exact:true}).click();await page.getByLabel('Reason for restoring defaults',{exact:true}).fill('Rollback test');const restore=page.waitForRequest(r=>r.url().endsWith('/restore-defaults'));await page.getByRole('button',{name:'Restore store defaults',exact:true}).click();expect((await restore).postDataJSON()).toEqual({expected_revision:2,reason:'Rollback test'});await expect(page.getByText('Using store-wide default catalog values.',{exact:true})).toBeVisible();
});
test('unready markets and read-only roles cannot publish',async({page})=>{
 await publicationSetup(page,false);await page.goto('/settings/markets');await page.getByRole('button',{name:'Review Egypt',exact:true}).click();await expect(page.getByText('Country setup required.')).toBeVisible();await page.getByRole('checkbox',{name:'I reviewed the prices',exact:false}).check();await page.getByLabel('Publication reason',{exact:true}).fill('Blocked');await expect(page.getByRole('button',{name:'Publish market',exact:true})).toBeDisabled();
 await publicationSetup(page,true,['markets.read','catalog.read']);await page.reload();await page.getByRole('button',{name:'Review Egypt',exact:true}).click();await expect(page.getByRole('button',{name:'Publish market',exact:true})).toHaveCount(0);
});
