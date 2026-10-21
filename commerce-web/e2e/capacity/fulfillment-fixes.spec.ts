import {test,expect,type Page} from '@playwright/test';
const id='00000000-0000-4000-8000-000000000001';
const caps={delivery_enabled:true,pickup_enabled:false,scheduled_delivery_enabled:true,asap_delivery_enabled:true,capacity_management_enabled:true,checkout_capacity_holds_enabled:true,geo_fencing_enabled:false,multi_source_fulfillment_enabled:false,split_order_scheduling_enabled:false,automatic_source_routing_enabled:true,customer_delivery_slot_selection_enabled:true,admin_manual_scheduling_enabled:true,pickup_scheduling_enabled:false,split_delivery_mode:'same_window_required',delivery_city_ids:[]};
const shared={id,overrides_rule_id:null,source_id:null,area_id:null,method:null,timezone:'Africa/Cairo',local_start:null,period:'slot',limits:{orders:30},overflow_percent:0,starts_on:null,ends_on:null,enabled:true};
const schedule={id,source_id:id,area_id:null,method:'scheduled_delivery',enabled:true,timezone:'Africa/Cairo',config:{windows:[{weekday:0,start:'09:00:00',end:'18:00:00',cutoff:null}],duration_minutes:60,spacing_minutes:0,lead_minutes:120,cutoff:null,min_days:0,max_days:14,ttl_minutes:10,release_before:'fulfilling',exceptions:[]}};
async function mock(page:Page,failOverview=false){
 let pickupSource={store_id:id,source_id:id,pickup_enabled:true,pickup_instructions:'Front desk',preparation_minutes:30};
 const writes:{path:string;body:Record<string, unknown>}[]=[];
 await page.route('**/api/**',route=>{const p=new URL(route.request().url()).pathname;
 if(route.request().method()==='POST'){const body=route.request().postDataJSON();writes.push({path:p,body});if(p.endsWith('/store-sources'))pickupSource={...pickupSource,...body};return route.fulfill({json:{status:'ok'}});}
 if(p.endsWith('/inventory/sources'))return route.fulfill({json:[{id,code:'cairo',name:'Cairo warehouse',is_enabled:true,address:'Cairo',latitude:null,longitude:null,contact_name:'',contact_phone:'',priority:0}]});
 if(p.endsWith('/admin/me'))return route.fulfill({json:{user:{id,name:'Test operator',email:'review@example.test'},permissions:['*']}});
 if(p.endsWith('/fulfillment/capabilities'))return route.fulfill({json:{system:{},stores:[{id,name:'Cairo store',overrides:{},resolved:caps}],locations:[{id,name:'Cairo warehouse'}],sources:[pickupSource]}});
 if(p.endsWith('/fulfillment/configuration'))return route.fulfill({json:{enabled:true,legacy_controls:false,sources:[[id,'Cairo warehouse']],areas:[],schedules:[schedule],rules:[shared]}});
 if(p.endsWith('/fulfillment/capacity'))return failOverview ? route.fulfill({status:503,json:{error:'Capacity connection failed'}}) : route.fulfill({json:{slots:[{slot:{schedule_id:id,source_id:id,method:'scheduled_delivery',timezone:'Africa/Cairo',starts_at:'2026-10-02T06:00:00Z',ends_at:'2026-10-02T07:00:00Z'},area_id:null,reserved:0,confirmed:0,utilization:0,status:'Available',caps:[{rule_id:id,period:'slot',dimension:'orders',remaining:30}]}]}});
 return route.fulfill({json:{}});
 });return writes;
}
test('Block creates an independent location-specific zero rule',async({page})=>{
 const writes=await mock(page);await page.goto('/fulfillment/capacity');await page.getByRole('button',{name:'Block',exact:true}).click();
 await expect(page.getByRole('combobox',{name:'Location',exact:true})).toHaveValue(id);
 await page.getByRole('combobox',{name:'Change reason',exact:true}).selectOption('__other');await page.getByLabel('Custom reason',{exact:true}).fill('Maintenance');await page.getByRole('button',{name:'Save capacity rule',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Scheduling & capacity',exact:true})).toBeVisible();
 expect(writes.at(-1)?.body.rule).toMatchObject({source_id:id,method:'scheduled_delivery',overrides_rule_id:null,limits:{orders:0},starts_on:'2026-10-02',ends_on:'2026-10-02'});
});
test('pickup uses the canonical method and immutable scope is locked on edit',async({page})=>{
 const writes=await mock(page);await page.goto('/fulfillment/new-schedule');await page.getByRole('combobox',{name:'Location',exact:true}).selectOption(id);
 await page.getByRole('combobox',{name:'Fulfillment method',exact:true}).selectOption('pickup');await page.getByRole('combobox',{name:'Change reason',exact:true}).selectOption('__other');await page.getByLabel('Custom reason',{exact:true}).fill('Offer scheduled pickup');
 await page.getByRole('button',{name:'Save schedule',exact:true}).click();await expect(page.getByRole('heading',{name:'Scheduling & capacity',exact:true})).toBeVisible();expect(writes.at(-1)?.body.schedule).toMatchObject({method:'pickup'});
 await page.getByRole('button',{name:'Edit schedule'}).click();await expect(page.getByRole('combobox',{name:'Location',exact:true})).toBeDisabled();await expect(page.getByRole('combobox',{name:'Fulfillment method',exact:true})).toBeDisabled();
});
test('policy draft is protected on sidebar navigation and browser back',async({page})=>{
 await mock(page);await page.goto('/fulfillment/capacity');await page.getByRole('link',{name:'Configure capacity controls',exact:false}).click();
 await expect(page).toHaveURL(/system\/configuration\/capacity$/);
 const configuration=page.getByRole('navigation',{name:'Configuration sections',exact:true});
 await configuration.getByRole('link',{name:'Delivery & pickup',exact:true}).click();
 await page.getByRole('switch',{name:'Store pickup',exact:true}).check();
 page.once('dialog',dialog=>dialog.dismiss());await configuration.getByRole('link',{name:'Capacity activation',exact:false}).click();await expect(page).toHaveURL(/system\/configuration\/fulfillment$/);await expect(page.getByRole('switch',{name:'Store pickup',exact:true})).toBeChecked();
 page.once('dialog',dialog=>dialog.dismiss());await page.goBack();await expect(page).toHaveURL(/system\/configuration\/fulfillment$/);
 page.once('dialog',dialog=>dialog.accept());await configuration.getByRole('link',{name:'Capacity activation',exact:false}).click();await expect(page).toHaveURL(/system\/configuration\/capacity$/);
});
test('a new edit is protected after a successful save',async({page})=>{
 await mock(page);await page.goto('/fulfillment/capacity');await page.getByRole('button',{name:'Edit schedule'}).click();await page.getByLabel('Preparation lead time (minutes)').fill('180');await page.getByRole('combobox',{name:'Change reason',exact:true}).selectOption('__other');await page.getByLabel('Custom reason',{exact:true}).fill('More preparation');await page.getByRole('button',{name:'Save schedule',exact:true}).click();
 await page.getByRole('button',{name:'Edit schedule'}).click();await page.getByLabel('Preparation lead time (minutes)').fill('240');page.once('dialog',d=>d.dismiss());await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByLabel('Preparation lead time (minutes)')).toHaveValue('240');
});
for(const width of [390,768,1024])test(`navigation remains usable at ${width}px`,async({page})=>{
 await mock(page);await page.setViewportSize({width,height:900});await page.goto('/settings/fulfillment');await expect(page).toHaveURL(/system\/configuration\/fulfillment$/);if(width<=780){await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.locator('.nav-group > summary').filter({hasText:/^Delivery/ }).click();}else await page.getByRole('button',{name:'Delivery',exact:true}).click();await page.screenshot({path:`test-results/fulfillment-navigation-${width}.png`});await page.getByRole('link',{name:'Scheduling & capacity',exact:true}).click();await expect(page.getByRole('heading',{name:'Scheduling & capacity',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:width<=780?'Open navigation':'Delivery',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('failed capacity loads show unavailable metrics and a retry',async({page})=>{
 await mock(page,true);await page.goto('/fulfillment/capacity');await expect(page.getByRole('button',{name:'Retry capacity'})).toBeVisible();await expect(page.getByText('No capacity alerts',{exact:true})).toHaveCount(0);await expect(page.getByRole('region',{name:'Capacity summary'}).locator('strong')).toHaveText(['—','—','—','—']);
});
test('location instruction edits preserve configured pickup while store pickup is off',async({page})=>{
 const writes=await mock(page);await page.goto('/settings/fulfillment');await page.getByRole('button',{name:/04 Store locations/}).click();await page.getByRole('link',{name:'Manage location',exact:true}).click();await page.getByRole('textbox',{name:/^Pickup instructions/}).fill('Use side entrance');await page.getByLabel('Location change reason',{exact:true}).selectOption('__other');await page.getByLabel('Custom reason',{exact:true}).fill('Entrance moved');await page.getByRole('button',{name:'Save pickup settings',exact:true}).click();await expect(page.getByText('Pickup settings saved for Cairo store.')).toBeVisible();expect(writes.at(-1)?.body.pickup_enabled).toBe(true);
});
test('invalid scheduling limits and overlaps cannot be saved',async({page})=>{
 const writes=await mock(page);await page.goto('/fulfillment/new-schedule');await page.getByRole('combobox',{name:'Location',exact:true}).selectOption(id);await page.getByRole('combobox',{name:'Change reason',exact:true}).selectOption('__other');await page.getByLabel('Custom reason',{exact:true}).fill('Test constraints');await page.getByLabel('Hold duration (minutes)').fill('31');await expect(page.getByRole('button',{name:'Save schedule',exact:true})).toBeDisabled();await page.getByLabel('Hold duration (minutes)').fill('10');await page.getByLabel('Minimum days ahead').fill('15');await expect(page.getByText('Maximum days ahead must be at least minimum days ahead.')).toBeVisible();await expect(page.getByRole('button',{name:'Save schedule',exact:true})).toBeDisabled();expect(writes).toEqual([]);
});
test('replenishment rejects invalid numeric values before making a request',async({page})=>{
 await mock(page);let saves=0;
 await page.route('**/api/v1/admin/replenishment**',route=>{
  if(route.request().method()==='PUT'){saves++;return route.fulfill({json:{status:'ok'}});}
  return route.fulfill({json:[{product_id:id,product:'Test product',sku:'TEST',supplier:'Supplier',planning_group:'Stock',lead_time_days:2,target_cover_days:7,safety_stock_days:1,minimum_order_qty:1,order_multiple:1,enabled:true,replenishment_qty:0,sales_velocity:1,days_of_stock:10,saleable_qty:10,recommended_date:null}]});
 });
 await page.goto(`/fulfillment/replenishment/${id}`);await page.getByRole('spinbutton',{name:'Order multiple',exact:true}).fill('0');await page.getByRole('button',{name:'Save policy',exact:true}).click();expect(saves).toBe(0);expect(await page.getByRole('spinbutton',{name:'Order multiple',exact:true}).evaluate((el:HTMLInputElement)=>el.checkValidity())).toBe(false);
 await page.getByRole('spinbutton',{name:'Order multiple',exact:true}).fill('2');await page.getByRole('button',{name:'Save policy',exact:true}).click();await expect.poll(()=>saves).toBe(1);await expect(page).toHaveURL(/fulfillment\/replenishment$/);
});
