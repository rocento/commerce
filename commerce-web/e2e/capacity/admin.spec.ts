import { test, expect } from '@playwright/test';
const source='00000000-0000-0000-0000-000000000001';
const schedule={id:'10000000-0000-4000-8000-000000000001',source_id:source,area_id:null,method:'scheduled_delivery',enabled:true,timezone:'Africa/Cairo',config:{windows:[{weekday:0,start:'09:00:00',end:'18:00:00',cutoff:null}],duration_minutes:60,spacing_minutes:0,lead_minutes:120,cutoff:null,min_days:0,max_days:14,ttl_minutes:10,release_before:'fulfilling',exceptions:[]}};
test('capacity operations, schedule editing and responsive layout',async({page})=>{
  const errors:string[]=[]; page.on('pageerror',e=>errors.push(e.message));
  let saved:unknown;
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname.endsWith('/admin/me')) return route.fulfill({json:{user:{id:source,email:'operator@example.test',name:'Operator',role_id:source,active:true,created_at:'2026-01-01T00:00:00Z'},permissions:['*']}});
    if(url.pathname.endsWith('/fulfillment/configuration')) return route.fulfill({json:{enabled:true,sources:[[source,'Cairo East']],areas:[],schedules:[schedule],rules:[]}});
    if(url.pathname.endsWith('/fulfillment/capacity')) return route.fulfill({json:{date:'2026-09-22',slots:[{slot:{schedule_id:schedule.id,source_id:source,method:schedule.method,timezone:schedule.timezone,starts_at:'2026-09-22T06:00:00Z',ends_at:'2026-09-22T07:00:00Z',availability:'AVAILABLE'},area_id:null,reserved:4,confirmed:25,utilization:29/30,status:'Near Capacity',caps:[{rule_id:source,period:'slot',dimension:'orders',limit:30,effective:30,used:29,remaining:1}]}]}});
    if(url.pathname.endsWith('/fulfillment/schedules')){saved=route.request().postDataJSON();return route.fulfill({json:{status:'ok'}});}
    return route.fulfill({json:{}});
  });
  await page.goto('/fulfillment/capacity');
  await expect(page.getByRole('heading',{name:'Scheduling & capacity'})).toBeVisible();
  await expect(page.getByRole('table').getByText('Near Capacity',{exact:true})).toBeVisible();
  await page.screenshot({path:'../commerce-docs/platform/fulfillment/capacity-admin-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'Edit schedule'}).click();
  await page.getByLabel('Preparation lead time (minutes)').fill('180');
  await page.getByLabel('Change reason',{exact:true}).selectOption('__other');await page.getByLabel('Custom reason',{exact:true}).fill('Increase preparation time');
  await page.getByRole('button',{name:'Save schedule'}).click();
  await expect(page.getByText('Schedule saved. Existing bookings are preserved.')).toBeVisible();
  expect(saved).toMatchObject({schedule:{config:{lead_minutes:180}},reason:'Increase preparation time'});
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:'../commerce-docs/platform/fulfillment/capacity-admin-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
test('store fulfillment settings progressively hide disabled controls and save audited changes',async({page})=>{
 const c={delivery_enabled:true,pickup_enabled:false,scheduled_delivery_enabled:false,asap_delivery_enabled:true,capacity_management_enabled:false,checkout_capacity_holds_enabled:false,geo_fencing_enabled:false,multi_source_fulfillment_enabled:false,split_order_scheduling_enabled:false,automatic_source_routing_enabled:true,customer_delivery_slot_selection_enabled:false,admin_manual_scheduling_enabled:true,pickup_scheduling_enabled:false,split_delivery_mode:'same_window_required',delivery_city_ids:[]};let saved:unknown;
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;
 if(path.endsWith('/admin/me'))return route.fulfill({json:{user:{id:source,name:'Operator',email:'operator@example.test'},permissions:['*']}});
 if(path.endsWith('/fulfillment/capabilities')){if(route.request().method()==='POST'){saved=route.request().postDataJSON();return route.fulfill({json:{status:'ok'}});}return route.fulfill({json:{system:{},stores:[{id:source,name:'Simple store',overrides:{},resolved:c}],locations:[{id:source,name:'Main shop'}],sources:[]}});}return route.fulfill({json:{}});});
 await page.goto('/settings/fulfillment');await expect(page.getByRole('heading',{name:'Delivery & pickup settings',exact:true})).toBeVisible();await expect(page.getByLabel('Scheduled pickup')).toHaveCount(0);await expect(page.getByLabel('Reserve capacity at checkout')).toHaveCount(0);
 await page.getByLabel('Pickup',{exact:false}).first().check();await expect(page.getByLabel('Scheduled pickup')).toBeVisible();await page.getByRole('combobox',{name:/^Policy change reason/}).selectOption('__other');await page.getByLabel('Custom reason',{exact:true}).fill('Offer collection from our shop');await page.getByRole('button',{name:'Save fulfillment settings',exact:true}).click();await expect(page.getByText('Delivery & pickup settings saved. The updated policy is now active.')).toBeVisible();expect(saved).toMatchObject({store_id:source,capabilities:{pickup_enabled:true},reason:'Offer collection from our shop'});
});

test('global delivery coverage saves both states and restores local rules', async ({page}) => {
 let c={delivery_enabled:true,pickup_enabled:false,scheduled_delivery_enabled:false,asap_delivery_enabled:true,capacity_management_enabled:false,checkout_capacity_holds_enabled:false,geo_fencing_enabled:true,global_delivery_enabled:false,multi_source_fulfillment_enabled:false,split_order_scheduling_enabled:false,automatic_source_routing_enabled:true,customer_delivery_slot_selection_enabled:false,admin_manual_scheduling_enabled:true,pickup_scheduling_enabled:false,split_delivery_mode:'same_window_required',delivery_city_ids:['cairo']};
 const saved:unknown[]=[];
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/admin/me'))return route.fulfill({json:{user:{id:source,name:'Operator',email:'operator@example.test'},permissions:['*']}});
  if(path.endsWith('/fulfillment/capabilities')){
   if(route.request().method()==='POST'){const body=route.request().postDataJSON();saved.push(body);c=body.capabilities;return route.fulfill({json:{status:'ok'}});}
   return route.fulfill({json:{system:{},stores:[{id:source,name:'Demo store',overrides:c,resolved:c}],locations:[],sources:[]}});
  }return route.fulfill({json:{}});
 });
 await page.goto('/settings/fulfillment');
 await page.getByRole('button',{name:/Delivery coverage$/}).click();
 await expect(page.getByRole('switch',{name:'Global delivery coverage',exact:true})).not.toBeChecked();
 for(const enabled of [true,false]){
  await page.getByRole('switch',{name:'Global delivery coverage',exact:true}).setChecked(enabled);
  if(enabled)await expect(page.getByRole('switch',{name:'Match delivery area boundaries'})).toHaveCount(0);
  else await expect(page.getByRole('switch',{name:'Match delivery area boundaries'})).toBeChecked();
  await page.getByRole('combobox',{name:/^Policy change reason/}).selectOption('__other');
  await page.getByLabel('Custom reason',{exact:true}).fill(enabled?'Enable worldwide delivery':'Restore regional delivery');
  await page.getByRole('button',{name:'Save fulfillment settings',exact:true}).click();
  await expect(page.getByText('Delivery & pickup settings saved. The updated policy is now active.')).toBeVisible();
  expect(saved.at(-1)).toMatchObject({store_id:source,capabilities:{global_delivery_enabled:enabled,geo_fencing_enabled:true,delivery_city_ids:['cairo']}});
  await page.reload();
  await page.getByRole('button',{name:/Delivery coverage$/}).click();
  await expect(page.getByRole('switch',{name:'Global delivery coverage',exact:true})).toBeChecked({checked:enabled});
 }
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('capacity activation saves an audited change from configuration and preserves failed drafts', async ({page}) => {
 let enabled=false, failSave=true;
 const writes:unknown[]=[];
 await page.route('**/api/**',route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/admin/me'))return route.fulfill({json:{user:{id:source,name:'Operator',email:'operator@example.test'},permissions:['*']}});
  if(path.endsWith('/fulfillment/configuration'))return route.fulfill({json:{enabled,legacy_controls:true,sources:[],areas:[],schedules:[],rules:[]}});
  if(path.endsWith('/fulfillment/capacity'))return route.fulfill({json:{slots:[]}});
  if(path.endsWith('/fulfillment/settings')&&route.request().method()==='POST'){
   const body=route.request().postDataJSON();writes.push(body);
   if(failSave)return route.fulfill({status:503,json:{error:'Capacity settings temporarily unavailable.'}});
   enabled=body.enabled;return route.fulfill({json:{status:'ok'}});
  }
  return route.fulfill({json:{}});
 });
 await page.goto('/fulfillment/capacity');
 await expect(page.getByRole('button',{name:'Enable controls',exact:true})).toHaveCount(0);
 await page.getByRole('link',{name:'Configure capacity controls',exact:false}).click();
 await expect(page).toHaveURL(/system\/configuration\/capacity$/);
 await page.getByLabel('Reason for this change',{exact:true}).selectOption('Start capacity management');
 await page.getByRole('button',{name:'Enable controls',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('Capacity settings temporarily unavailable.');
 await expect(page.getByLabel('Reason for this change',{exact:true})).toHaveValue('Start capacity management');
 page.once('dialog',dialog=>dialog.dismiss());
 await page.getByRole('link',{name:'Scheduling & capacity',exact:false}).click();
 await expect(page).toHaveURL(/system\/configuration\/capacity$/);
 failSave=false;
 await page.getByRole('button',{name:'Enable controls',exact:true}).click();
 await expect(page.getByText('Capacity controls enabled. Existing bookings remain protected.',{exact:true})).toBeVisible();
 expect(writes).toEqual([{enabled:true,reason:'Start capacity management'},{enabled:true,reason:'Start capacity management'}]);
 await expect(page.getByRole('button',{name:'Turn off controls',exact:true})).toBeVisible();
 await expect(page.getByLabel('Reason for this change',{exact:true})).toHaveValue('');
 const dialogs:string[]=[];page.on('dialog',dialog=>{dialogs.push(dialog.message());void dialog.dismiss();});
 await page.getByRole('link',{name:'Scheduling & capacity',exact:false}).click();
 await expect(page).toHaveURL(/fulfillment\/capacity$/);
 expect(dialogs).toEqual([]);
});

test('capacity activation respects read-only access and modern store policies', async ({page}) => {
 let permissions=['fulfillment.capacity.view','fulfillment.schedule.view'], legacy=true, writes=0;
 await page.route('**/api/**',route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/admin/me'))return route.fulfill({json:{user:{id:source,name:'Reader',email:'reader@example.test'},permissions}});
  if(path.endsWith('/fulfillment/configuration'))return route.fulfill({json:{enabled:false,legacy_controls:legacy,controls:{capacity:true,scheduling:true,pickup:false,geofencing:false},sources:[],areas:[],schedules:[],rules:[]}});
  if(route.request().method()==='POST')writes++;
  return route.fulfill({json:{}});
 });
 await page.goto('/system/configuration/capacity');
 await expect(page.getByText('Read-only access. Changing capacity controls requires both scheduling and capacity management permissions.',{exact:true})).toBeVisible();
 await expect(page.getByLabel('Reason for this change',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Enable controls',exact:true})).toHaveCount(0);
 permissions=['*'];legacy=false;await page.reload();
 await expect(page.getByRole('heading',{name:'Capacity is managed per store',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Enable controls',exact:true})).toHaveCount(0);
 await expect(page.getByRole('link',{name:'Open delivery & pickup settings',exact:false})).toHaveAttribute('href','/system/configuration/fulfillment');
 expect(writes).toBe(0);
});
