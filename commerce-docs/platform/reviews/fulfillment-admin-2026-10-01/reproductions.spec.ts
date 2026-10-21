import {test,expect} from '@playwright/test';
const id='00000000-0000-4000-8000-000000000001';
const caps={delivery_enabled:true,pickup_enabled:false,scheduled_delivery_enabled:true,asap_delivery_enabled:true,capacity_management_enabled:true,checkout_capacity_holds_enabled:true,geo_fencing_enabled:false,multi_source_fulfillment_enabled:false,split_order_scheduling_enabled:false,automatic_source_routing_enabled:true,customer_delivery_slot_selection_enabled:true,admin_manual_scheduling_enabled:true,pickup_scheduling_enabled:false,split_delivery_mode:'same_window_required',delivery_city_ids:[]};
const shared={id,overrides_rule_id:null,source_id:null,area_id:null,method:null,timezone:'Africa/Cairo',local_start:null,period:'slot',limits:{orders:30},overflow_percent:0,starts_on:null,ends_on:null,enabled:true};
test.beforeEach(async({page})=>{
 await page.route('**/api/**',route=>{const p=new URL(route.request().url()).pathname;
 if(p.endsWith('/admin/me'))return route.fulfill({json:{user:{id,name:'Review operator',email:'review@example.test'},permissions:['*']}});
 if(p.endsWith('/fulfillment/capabilities'))return route.fulfill({json:{system:{},stores:[{id,name:'Cairo store',overrides:{},resolved:caps}],locations:[{id,name:'Cairo warehouse'}],sources:[]}});
 if(p.endsWith('/fulfillment/configuration'))return route.fulfill({json:{enabled:true,legacy_controls:false,sources:[[id,'Cairo warehouse']],areas:[],schedules:[],rules:[shared]}});
 if(p.endsWith('/fulfillment/capacity'))return route.fulfill({json:{slots:[{slot:{schedule_id:id,source_id:id,method:'scheduled_delivery',timezone:'Africa/Cairo',starts_at:'2026-10-02T06:00:00Z',ends_at:'2026-10-02T07:00:00Z'},area_id:null,reserved:0,confirmed:0,utilization:0,status:'Available',caps:[{rule_id:id,period:'slot',dimension:'orders',remaining:30}]}]}});
 return route.fulfill({json:{}});
 });
});
test('review reproduction: row Block retains all-location shared scope',async({page})=>{
 await page.goto('/fulfillment/capacity');await page.getByRole('button',{name:'Block',exact:true}).click();
 await expect(page.getByRole('combobox',{name:'Location',exact:true})).toHaveValue('');
 await expect(page.getByLabel('Method (blank = all)',{exact:true})).toHaveValue('');
 await expect(page.getByLabel('orders (blank = unlimited)',{exact:true})).toHaveValue('0');
});
test('review reproduction: sidebar navigation discards policy draft without confirmation',async({page})=>{
 let dialogs=0;page.on('dialog',async d=>{dialogs++;await d.dismiss();});
 await page.goto('/settings/fulfillment');await page.getByRole('switch',{name:'Store pickup',exact:true}).check();
 await expect(page.getByText(/unsaved setting/)).toBeVisible();
 await page.locator('summary').filter({hasText:'Fulfillment'}).click();
 await page.getByRole('link',{name:'Capacity & scheduling',exact:true}).click();
 await page.goBack();await expect(page.getByRole('switch',{name:'Store pickup',exact:true})).not.toBeChecked();expect(dialogs).toBe(0);
 await page.screenshot({path:'test-results/review-settings-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/review-settings-mobile.png',fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('review reproduction: pickup suggestions omit backend pickup method',async({page})=>{
 await page.goto('/fulfillment/new-schedule');await expect(page.getByLabel('Delivery method',{exact:true})).toBeVisible();
 const methods=await page.locator('#delivery-methods option').allTextContents();expect(methods).toContain('store_pickup');expect(methods).not.toContain('pickup');
});
