import { test, expect, type Page } from '@playwright/test';
const id='20000000-0000-0000-0000-000000000002';
const category={id,name:'Fruit',slug:'fruit',parent_id:null};
const product={id,name:'Apples',description:'Fresh apples',sku:'APPLE',slug:'apples',price:'12',currency:'EGP',unit:'kg',category_id:id,category_ids:[id],attribute_set_id:null,attributes:{},media_ids:[],active:true,in_stock:true,product_type:'simple'};
const blocks=[{kind:'link',heading:'',text:'',image_id:null,link_label:'Shop',link_url:'/search',navigation:{icon:'',badge:'New',enabled:true,new_tab:false,columns:3,links:[{label:'Fruit',group:'Fresh',description:'Seasonal',url:'/categories/fruit',icon:'',new_tab:false}]}}];
const menuDocument={id,kind:'navigation',key:'navigation',version:1};
const revision={id,document_id:id,version:1,title:'Main menu',blocks};
async function setup(page:Page, permissions=['*']) {
 const translations:Record<string,Record<string,unknown>>={};
 await page.route('**/api/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  let body:unknown=[];
  if(path.endsWith('/admin/me'))body={user:{id,name:'Admin',email:'admin@example.com'},permissions};
  else if(path.endsWith('/admin/markets'))body={items:[],live:{region:'EG',currency:'EGP'},locales:['en','ar'],activation_available:false};
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
for(const [kind,path,field,inherit] of [
 ['product',`/catalog/products/${id}`,'Product name · Arabic','Use source value for product name'],
 ['category',`/catalog/categories/${id}`,'Category name · Arabic','Use source value for category name'],
 ['navigation','/content/navigation','Label · Arabic','Use source value for label'],
] as const){
 test(`${kind}: switches language in place and saves translation only`,async({page})=>{
  await setup(page);
  const writes:string[]=[];page.on('request',r=>{if(r.method()==='PUT'||r.method()==='POST')writes.push(new URL(r.url()).pathname);});
  await page.goto(path);await page.getByLabel('Content language').selectOption('ar');
  const input=page.getByRole('textbox',{name:field,exact:true});
  await expect(input).toHaveAttribute('dir','auto');await expect(input).toBeDisabled();
  await page.getByRole('checkbox',{name:inherit,exact:true}).uncheck();await input.fill('نص مترجم');await expect(input).toHaveAttribute('dir','rtl');
  const save=page.waitForRequest(r=>r.method()==='PUT');await page.getByRole('button',{name:'Save translation draft',exact:true}).click();
  const request=await save;expect(request.url()).toContain(`/languages/ar/translations/${kind}/${id}`);
  expect(Object.keys(request.postDataJSON()).sort()).toEqual(['expected_revision','fields','reviewed','source']);
  await expect(page.getByRole('status').filter({hasText:/translation (draft )?saved/})).toBeVisible();
  await page.getByLabel('Content language').selectOption('');await page.getByLabel('Content language').selectOption('ar');
  await expect(page.getByRole('textbox',{name:field,exact:true})).toHaveValue('نص مترجم');
  expect(writes).toEqual([`/api/v1/admin/languages/ar/translations/${kind}/${id}`]);
  await page.screenshot({path:`/tmp/${kind}-inline-translation.png`,fullPage:true});
 });
}
test('protects source and translation drafts when switching language',async({page})=>{
 await setup(page);await page.goto(`/catalog/products/${id}`);await page.getByRole('textbox',{name:'Product name',exact:true}).fill('Unsaved apples');
 await page.getByLabel('Content language').selectOption('ar');await page.getByRole('button',{name:'Keep editing',exact:true}).click();await expect(page.getByLabel('Content language')).toHaveValue('');
 await page.getByLabel('Content language').selectOption('ar');await page.getByRole('button',{name:'Discard and switch',exact:true}).click();
 await page.getByRole('checkbox',{name:'Use source value for product name',exact:true}).uncheck();await page.getByRole('textbox',{name:'Product name · Arabic',exact:true}).fill('تفاح');
 await expect(page.getByText('Unsaved changes',{exact:true})).toBeVisible();
 await page.getByLabel('Content language').selectOption('fr');await page.getByRole('button',{name:'Keep editing',exact:true}).click();await expect(page.getByLabel('Content language')).toHaveValue('ar');
 await page.getByLabel('Content language').selectOption('');await page.getByRole('button',{name:'Discard and switch',exact:true}).click();await expect(page.getByRole('textbox',{name:'Product name',exact:true})).toHaveValue('Apples');
});
test('read-only translations and mobile category layout',async({page})=>{
 await setup(page,['catalog.read','languages.read']);await page.goto(`/catalog/categories/${id}`);await page.getByLabel('Content language').selectOption('ar');
 await expect(page.getByText('View-only translation.',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'Save translation draft'})).toHaveCount(0);
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
test('conflicts keep drafts until explicit reload',async({page})=>{
 await setup(page);await page.route('**/translations/category/*',async route=>{if(route.request().method()==='PUT')await route.fulfill({status:409,json:{error:'conflict'}});else await route.fallback();});
 await page.goto(`/catalog/categories/${id}`);await page.getByLabel('Content language').selectOption('ar');await page.getByRole('checkbox',{name:'Use source value for category name',exact:true}).uncheck();await page.getByRole('textbox',{name:'Category name · Arabic',exact:true}).fill('فواكه');await page.getByRole('button',{name:'Save translation draft'}).click();
 await expect(page.getByRole('alert').filter({hasText:'another session'})).toBeVisible();await expect(page.getByRole('textbox',{name:'Category name · Arabic',exact:true})).toHaveValue('فواكه');await expect(page.getByRole('button',{name:'Save translation draft'})).toBeDisabled();
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Reload saved translation'}).click();await expect(page.getByRole('textbox',{name:'Category name · Arabic',exact:true})).toHaveValue('Fruit');
});

for (const width of [1440, 390]) {
 test(`Arabic form geometry and keyboard access at ${width}px`, async ({page}) => {
  await page.setViewportSize({width,height:1000});await setup(page);
  await page.goto(`/catalog/products/${id}`);await page.getByLabel('Content language').selectOption('ar');
  const name=page.getByRole('textbox',{name:'Product name · Arabic',exact:true});
  const inherit=page.getByRole('checkbox',{name:'Use source value for product name',exact:true});
  await expect(name).toBeDisabled();await expect(name).toHaveAttribute('dir','auto');
  expect(await inherit.evaluate(el=>{
   const box=el.getBoundingClientRect(),text=el.closest('label')!.querySelector('span')!.getBoundingClientRect();
   return {width:box.width,height:box.height,sameRow:Math.abs(box.top-text.top)<4};
  })).toEqual({width:16,height:16,sameRow:true});
  if(width===1440){
   const translated=await name.boundingBox(),source=await page.getByRole('textbox',{name:'SKU',exact:true}).boundingBox();
   expect(Math.abs(translated!.y-source!.y)).toBeLessThan(2);
  }
  await inherit.focus();await page.keyboard.press('Space');await expect(inherit).not.toBeChecked();
  await expect(name).toBeEnabled();await expect(name).toHaveAttribute('dir','rtl');await expect(name).toHaveAttribute('lang','ar');
  await name.fill('تفاح طازج 123');expect(await name.evaluate(el=>getComputedStyle(el).textAlign)).toBe('start');
  await page.getByText('Use source value for description',{exact:true}).click();
  await page.getByRole('textbox',{name:'Description · Arabic',exact:true}).fill('وصف عربي طويل لاختبار تنسيق الحقول');
  const review=page.getByRole('checkbox',{name:'I reviewed this translation against the current source'});
  await expect(review).toBeEnabled();await review.focus();await page.keyboard.press('Space');await expect(review).toBeChecked();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`/tmp/admin-arabic-controls-${width}.png`,fullPage:true});
 });
}
