import { test, expect, type Page } from '@playwright/test';

const product='00000000-0000-0000-0000-000000000002';
const definition='00000000-0000-0000-0000-000000000003';
const id='00000000-0000-0000-0000-000000000004';
async function fixture(page:Page,{readOnly=false,stale=false,filled=false,outsideSet=false,attributeOnly=false}={}) {
 let status='pending',generated=false,discoveryEnabled=false;
 const suggestion=()=>({id,product_id:product,definition_id:definition,value:'casual',source:'DERIVED',confidence:1,model_version:'labelled-description-v1',status,created_at:'2026-09-28T12:00:00Z',reviewed_at:status==='pending'?null:'2026-09-28T13:00:00Z',reviewed_by:status==='pending'?null:id,evidence:{field:'description',quote:'Style: Casual'}});
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url()),path=url.pathname;
  if(path.endsWith('/admin/me'))return route.fulfill({json:{user:{id,name:'Catalog reviewer',email:'reviewer@example.test',active:true,role_id:id,created_at:'2026-09-28T12:00:00Z'},permissions:attributeOnly?(readOnly?['attributes.read']:['attributes.read','attributes.write']):readOnly?['catalog.read','attributes.read']:['catalog.read','catalog.write','attributes.read','attributes.write']}});
  if(path.endsWith('/catalog/discovery')) {
   if(route.request().method()==='PUT') discoveryEnabled=route.request().postDataJSON().enabled;
   return route.fulfill({json:{products_evaluated:1,enabled:discoveryEnabled,bounded:false,pending_relationships:0,categories:[{category_id:id,category_name:'Clothing',products:1,present_values:1,expected_values:2,factual_values:1,fresh_values:1,mean_confidence:1,confidence_known:1,invalid_values:0,missing:{style:1}}],rankings:[]}});
  }
  if(path.endsWith('/attribute-definitions'))return route.fulfill({json:[{id:definition,label:'Style',attribute_code:'style',input_type:'single_select',options:[{value:'casual',label:'Casual'}],used_for_configurations:false,metadata:{ai_enrichable:true,source_policy:'semantic',status:'active'}}]});
  if(path.endsWith('/attribute-sets'))return route.fulfill({json:outsideSet?[{id,name:'Other set',members:[]}]:[]});
  if(path.endsWith(`/catalog/products/${product}`))return route.fulfill({json:{id:product,name:'Casual shirt',sku:'SHIRT-1',description:'Style: Casual',active:false,attributes:filled?{style:'casual'}:{},attribute_set_id:outsideSet?id:null}});
  if(path.endsWith('/operations/products'))return route.fulfill({json:{items:[{id:product,name:'Casual shirt',sku:'SHIRT-1'}],total:1}});
  if(path.endsWith(`/products/${product}/enrichment`)){generated=true;return route.fulfill({json:[suggestion()]});}
  if(path.endsWith(`/enrichment/${id}`)){
   if(stale)return route.fulfill({status:400,json:{error:'Suggestion is stale. Reject it and generate a new suggestion.'}});
   status=route.request().postDataJSON().approve?'approved':'rejected';return route.fulfill({json:suggestion()});
  }
  if(path.endsWith('/catalog/enrichment'))return route.fulfill({json:generated&&(!url.searchParams.get('status')||url.searchParams.get('status')===status)?[suggestion()]:[]});
  return route.fulfill({status:404,json:{error:'Unexpected test endpoint'}});
 });
 await page.goto('/catalog/enrichment');
 await expect(page.getByRole('heading',{name:'Catalog enrichment',exact:true})).toBeVisible();
}

for(const width of [1440,390]){
 test(`generate and explicitly approve with visible evidence at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:1000});await fixture(page);
  await page.getByRole('combobox',{name:'Product',exact:true}).selectOption(product);
  await page.getByRole('button',{name:'Generate for selected product'}).click();
  await expect(page.locator('tbody blockquote')).toHaveText('Style: Casual');
  await expect(page.getByRole('table',{name:'Enrichment suggestions'}).locator('tbody')).toContainText('Casual shirt');
  await expect(page.locator('tbody .enrichment-proposed strong')).toHaveText('Casual');
  await page.getByRole('button',{name:`Actions for suggestion ${id}`}).click();
  await page.getByRole('menuitem',{name:'Approve',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Approve this suggestion?'})).toBeVisible();
  await page.getByRole('button',{name:'Confirm review'}).click();
  await expect(page.getByText('Suggestion approved and product updated.',{exact:true})).toBeVisible();
  await page.getByRole('combobox',{name:'Review status',exact:true}).selectOption('approved');
  await expect(page.getByRole('table',{name:'Enrichment suggestions'}).locator('tbody')).toContainText('Approved');
  await expect(page.getByRole('table',{name:'Enrichment suggestions'}).locator('tbody')).toContainText('Reviewed');
  await page.screenshot({path:`test-results/enrichment/review-${width}.png`,fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 });
}
test('stale approval reports an error without a success message',async({page})=>{
 await fixture(page,{stale:true});
 await page.getByRole('combobox',{name:'Product',exact:true}).selectOption(product);
 await page.getByRole('button',{name:'Generate for selected product'}).click();
 await page.getByRole('button',{name:`Actions for suggestion ${id}`}).click();
 await page.getByRole('menuitem',{name:'Approve',exact:true}).click();
 await page.getByRole('button',{name:'Confirm review'}).click();
 await expect(page.getByText('Suggestion is stale. Reject it and generate a new suggestion.',{exact:true})).toBeVisible();
 await expect(page.getByText('Suggestion approved and product updated.',{exact:true})).toHaveCount(0);
});
test('read-only role cannot generate or approve',async({page})=>{
 await fixture(page,{readOnly:true});
 await expect(page.getByText(/You have read-only access/)).toBeVisible();
 await expect(page.getByRole('button',{name:'Generate for selected product'})).toHaveCount(0);
});

test('reject preserves its decision on regeneration and shows readable history',async({page})=>{
 await fixture(page);
 await page.getByRole('combobox',{name:'Product',exact:true}).selectOption(product);
 await page.getByRole('button',{name:'Generate for selected product'}).click();
 await page.getByRole('button',{name:`Actions for suggestion ${id}`}).click();
 await page.getByRole('menuitem',{name:'Reject',exact:true}).click();
 await expect(page.getByRole('dialog')).toContainText('Casual shirt');
 await page.getByRole('button',{name:'Confirm review'}).click();
 await expect(page.getByText('Suggestion rejected.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Generate for selected product'}).click();
 await expect(page.getByText(/0 pending suggestions available/)).toBeVisible();
 await page.getByRole('combobox',{name:'Review status',exact:true}).selectOption('rejected');
 await expect(page.getByRole('table',{name:'Enrichment suggestions'}).locator('tbody')).toContainText('Rejected');
 await expect(page.getByRole('table',{name:'Enrichment suggestions'}).locator('tbody')).toContainText('Reviewed');
});
for (const scenario of ['filled','outsideSet'] as const) {
 test(`cannot generate when eligible attribute is ${scenario}`,async({page})=>{
  await fixture(page,{[scenario]:true});
  await page.getByRole('combobox',{name:'Product',exact:true}).selectOption(product);
  await expect(page.getByText('No missing supported attributes in this product’s attribute set.')).toBeVisible();
  await expect(page.getByRole('button',{name:'Generate for selected product'})).toBeDisabled();
 });
}
test('review dialog can be dismissed with Escape without writing a decision',async({page})=>{
 await fixture(page);
 await page.getByRole('combobox',{name:'Product',exact:true}).selectOption(product);
 await page.getByRole('button',{name:'Generate for selected product'}).click();
 await page.getByRole('button',{name:`Actions for suggestion ${id}`}).click();
 await page.getByRole('menuitem',{name:'Approve',exact:true}).click();
 await expect(page.getByRole('dialog')).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(page.getByRole('table',{name:'Enrichment suggestions'}).locator('tbody')).toContainText('Pending');
});

for (const width of [1440,390]) test(`discovery controls move to enrichment with attribute-only access at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:1000});
 await fixture(page,{attributeOnly:true});
 const coverage=page.getByRole('region',{name:'AI discoverability coverage'});
 await expect(coverage.getByText('Clothing',{exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Generate suggestions'})).toHaveCount(0);
 await coverage.getByRole('button',{name:'Enable discovery ranking',exact:true}).click();
 await expect(coverage.getByRole('button',{name:'Disable discovery ranking',exact:true})).toBeVisible();
 await coverage.getByRole('button',{name:'Refresh coverage'}).click();
 await expect(coverage.getByRole('button',{name:'Disable discovery ranking',exact:true})).toBeVisible();
 await coverage.getByRole('button',{name:'Disable discovery ranking',exact:true}).click();
 await expect(coverage.getByRole('button',{name:'Enable discovery ranking',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.screenshot({path:`test-results/enrichment/coverage-${width}.png`,fullPage:true});
});

test('attribute readers retain coverage access without ranking mutation controls',async({page})=>{
 await fixture(page,{attributeOnly:true,readOnly:true});
 const coverage=page.getByRole('region',{name:'AI discoverability coverage'});
 await expect(coverage.getByText('Clothing',{exact:true})).toBeVisible();
 await expect(coverage.getByRole('button',{name:'Enable discovery ranking'})).toHaveCount(0);
 await expect(page.getByRole('link',{name:'Catalog setup',exact:true})).toHaveAttribute('href','/system/configuration/industry');
});
