import { test, expect } from '@playwright/test';
const id='11111111-1111-4111-8111-111111111111';
const ticket={id,number:1,subject:'Delivery question',category:'order_issue',status:'open',priority:'normal',created_at:'2026-09-01T12:00:00Z'};
test.beforeEach(async({page})=>{
 await page.route('**/api/**',r=>r.fulfill({json:[]}));
 await page.route('**/api/v1/admin/me',r=>r.fulfill({json:{user:{id,name:'Admin'},permissions:['*']}}));
 await page.route('**/api/v1/admin/grids/*/sorts',r=>r.fulfill({json:['id','created_at']}));
 await page.route('**/api/v1/admin/grids/support?*',r=>r.fulfill({json:{items:[ticket],total_count:1,next_cursor:null}}));
 await page.route('**/api/v1/admin/support/tickets',r=>r.fulfill({json:[ticket]}));
 await page.route(`**/api/v1/admin/support/tickets/${id}`,r=>r.fulfill({json:{ticket,messages:[]}}));
});
for(const method of ['click','Enter',' '])test(`support row opens its existing View action using ${method}`,async({page})=>{
 await page.goto('/support/tickets');
 const row=page.locator('tr[data-row-view]').filter({hasText:'Delivery question'});
 await expect(row).toHaveAttribute('tabindex','0');
 if(method==='click')await row.getByText('Delivery question',{exact:true}).click();
 else {await row.focus();await row.press(method);}
 await expect(page).toHaveURL(`/support/tickets/${id}`);
 await expect(page.getByRole('heading',{name:'Delivery question'})).toBeVisible();
});
test('action menu and text selection do not open the row',async({page})=>{
 await page.goto('/support/tickets');
 const row=page.locator('tr[data-row-view]').filter({hasText:'Delivery question'});
 await row.getByRole('button',{name:'Actions for ticket #1'}).click();
 await expect(page.getByRole('menu')).toBeVisible();
 await expect(page).toHaveURL('/support/tickets');
 await page.getByRole('menuitem',{name:'View ticket'}).press('Escape');
 await row.getByText('Delivery question',{exact:true}).evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);const s=getSelection();s?.removeAllRanges();s?.addRange(range);});
 await row.locator('td').first().dispatchEvent('click');
 await expect(page).toHaveURL('/support/tickets');
 await page.evaluate(()=>getSelection()?.removeAllRanges());
 await row.getByRole('link',{name:'View ticket: ticket #1'}).click();
 await expect(page).toHaveURL(`/support/tickets/${id}`);
});
test('catalog selection checkboxes do not open the editor',async({page})=>{
 const product={id,sku:'TEA',name:'Green tea',price:'5.00',currency:'USD',active:true,in_stock:true,category_id:id,media_ids:[],attributes:{},unit:'each',slug:'tea'};
 await page.route('**/api/v1/admin/grids/catalog?*',r=>r.fulfill({json:{items:[product],total_count:1,next_cursor:null}}));
 await page.route('**/api/v1/admin/operations/products?*',r=>r.fulfill({json:{items:[product]}}));
 await page.goto('/catalog/products');
 const row=page.locator('tr[data-row-view]').filter({hasText:'Green tea'});
 await row.getByRole('checkbox').check();
 await expect(row.getByRole('checkbox')).toBeChecked();
 await expect(page).toHaveURL('/catalog/products');
 await row.getByRole('checkbox').uncheck();
 await row.getByText('TEA',{exact:true}).click();
 await expect(page).toHaveURL(`/catalog/products/${id}`);
});
