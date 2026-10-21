import { test, expect, type Page } from '@playwright/test';
const base='/api/v1/admin/catalog/relationship-rules';
const rule={id:'10000000-0000-4000-8000-000000000001',name:'Camera accessories',kind:'related',active:true,priority:1,starts_at:null,ends_at:null,result_limit:4,stop_processing:false,source:{any:false,conditions:[]},target:{any:false,conditions:[]},manual_ids:[],segment_ids:[],revision:1,updated_at:'2026-10-05T09:00:00Z'};
async function setup(page:Page,permissions=['*']){
 const writes:Record<string,unknown>[]=[];const state={conflict:false};let rules=[rule];
 await page.route('**/api/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname;
 if(path.endsWith('/admin/me'))return route.fulfill({json:{user:{id:'a',name:'Merchandiser',email:'merchandiser@example.test'},permissions}});
 if(path===`${base}/attributes`)return route.fulfill({json:[{attribute_code:'brand',label:'Brand'}]});
 if(path===base&&req.method()==='GET')return route.fulfill({json:rules});
 if(path.startsWith(base)){
  if(state.conflict)return route.fulfill({status:409,json:{error:'Record changed. Reload the rule.'}});
  if(req.method()==='DELETE'){rules=[];return route.fulfill({status:204});}
  const body=req.postDataJSON();writes.push(body);const saved={...body,id:rule.id,updated_at:rule.updated_at,revision:body.revision+1};rules=[saved];return route.fulfill({json:saved});
 }
 if(path.endsWith('/catalog/products'))return route.fulfill({json:[{id:'20000000-0000-4000-8000-000000000001',sku:'CAM-1',name:'Camera',active:true,parent_id:null}]});
 if(path.includes('/catalog/products/'))return route.fulfill({json:{id:'20000000-0000-4000-8000-000000000001',sku:'CAM-1',name:'Camera'}});
 if(path.endsWith('/catalog/categories'))return route.fulfill({json:[{id:'30000000-0000-4000-8000-000000000001',name:'Electronics'}]});
 if(path.endsWith('/customer-segments'))return route.fulfill({json:[]});
 return route.fulfill({json:[]});});return {writes,state};
}
test('merchant creates a disabled rule using match/display conditions and manual selections',async({page})=>{
 const {writes}=await setup(page);await page.goto('/catalog/relationships');await page.getByRole('button',{name:'Add rule'}).click();
 await page.getByLabel('Name',{exact:true}).fill('Premium camera accessories');
 const source=page.getByRole('group',{name:'Products to match',exact:true});await source.getByRole('button',{name:'Add condition'}).click();
 await page.getByLabel('Products to match value 1').fill('CAM-1');
 const target=page.getByRole('group',{name:'Products to display',exact:true});await target.getByRole('button',{name:'Add condition'}).click();
 await page.getByLabel('Products to display field 1').selectOption('attribute');await page.getByLabel('Products to display attribute 1').selectOption('brand');await page.getByLabel('Products to display value 1').fill('Acme');
 await page.getByLabel('Add manual product').selectOption('20000000-0000-4000-8000-000000000001');
 await page.screenshot({path:'test-results/product-relationships/editor-desktop.png',fullPage:true});
 await page.getByRole('button',{name:'Save rule',exact:true}).click();await expect(page.getByRole('cell',{name:'Premium camera accessories'})).toBeVisible();
 expect(writes[0]).toMatchObject({active:false,revision:0,manual_ids:['20000000-0000-4000-8000-000000000001'],target:{conditions:[{field:'attribute',attribute_code:'brand',operator:'eq',value:'Acme'}]}});
});
test('conflicting save preserves edits and deletion requires explicit confirmation',async({page})=>{
 const {state}=await setup(page);await page.goto('/catalog/relationships');await page.getByRole('button',{name:'Edit',exact:true}).click();await page.getByLabel('Name',{exact:true}).fill('Keep my changes');state.conflict=true;await page.getByRole('button',{name:'Save rule',exact:true}).click();await expect(page.getByText('Record changed. Reload the rule.',{exact:false})).toBeVisible();await expect(page.getByLabel('Name',{exact:true})).toHaveValue('Keep my changes');state.conflict=false;
 await page.getByRole('button',{name:'Delete rule',exact:true}).click();await expect(page.getByRole('button',{name:'Confirm delete'})).toBeVisible();await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByLabel('Name',{exact:true})).toHaveValue('Keep my changes');
});
test('read-only users cannot save or create; mobile editor stays within viewport',async({page})=>{
 await setup(page,['catalog.read']);await page.setViewportSize({width:390,height:844});await page.goto('/catalog/relationships');await expect(page.getByRole('button',{name:'Add rule'})).toBeDisabled();await page.getByRole('button',{name:'View',exact:true}).click();await expect(page.getByRole('button',{name:'Save rule',exact:true})).toBeDisabled();await expect(page.getByLabel('Name',{exact:true})).toBeDisabled();await page.screenshot({path:'test-results/product-relationships/editor-mobile.png',fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
});
