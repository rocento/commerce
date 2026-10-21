import {test,expect} from '@playwright/test';
const source='00000000-0000-0000-0000-000000000001';
const c={delivery_enabled:true,pickup_enabled:false,scheduled_delivery_enabled:false,asap_delivery_enabled:true,capacity_management_enabled:false,checkout_capacity_holds_enabled:false,geo_fencing_enabled:false,multi_source_fulfillment_enabled:false,split_order_scheduling_enabled:false,automatic_source_routing_enabled:true,customer_delivery_slot_selection_enabled:false,admin_manual_scheduling_enabled:true,pickup_scheduling_enabled:false,split_delivery_mode:'same_window_required',delivery_city_ids:[]};
for(const mode of ['pickup','delivery','restricted','no-pickup']) test(mode+' branch setup',async({page})=>{
 const limited=mode==='restricted';
 const requests:Record<string, unknown>[]=[]; const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',route=>{
 const path=new URL(route.request().url()).pathname;
 if(path.endsWith('/admin/me'))return route.fulfill({json:{user:{id:source,name:'Operator',email:'operator@example.test'},permissions:limited?['fulfillment.settings.view','fulfillment.settings.manage']:mode==='no-pickup'?['fulfillment.settings.view','fulfillment.settings.manage','inventory.write']:['*']}});
 if(path.endsWith('/fulfillment/capabilities'))return route.fulfill({json:{system:{},stores:[{id:source,name:'Main store',overrides:{},resolved:c}],locations:[],sources:[]}});
 if(path.endsWith('/inventory/stocks'))return route.fulfill({json:[{id:source,name:'Main stock',code:'default',is_default:true,sources:[]}]});
 if(path.endsWith('/fulfillment/stores')){requests.push(route.request().postDataJSON());return requests.length===1?route.fulfill({status:503,json:{error:'Temporary connection failure'}}):route.fulfill({json:{status:'ok'}});}
 return route.fulfill({json:{}});
 });
 await page.goto('/settings/fulfillment');await page.getByRole('button',{name:'+ Add store or branch'}).click();
 if(limited){await expect(page.getByLabel('Holds inventory')).toBeDisabled();return;}
 await page.getByLabel('Store name',{exact:true}).fill('Ismailia branch');await page.getByLabel('Change reason',{exact:true}).selectOption('__other');await page.getByLabel('Custom reason',{exact:true}).fill('Open branch');await page.getByLabel('Holds inventory').check();
 if(mode==='no-pickup'){await expect(page.getByLabel('Offers pickup')).toBeDisabled();await expect(page.getByLabel('Fulfills delivery')).toBeEnabled();return;}
 const save=page.getByRole('button',{name:'Create branch and inventory location'});await expect(save).toBeDisabled();
 await page.getByLabel('Branch address').fill('Ismailia');await page.getByLabel('Fulfills delivery').uncheck();await expect(save).toBeDisabled();if(mode==='pickup')await page.getByLabel('Offers pickup').check();else await page.getByLabel('Fulfills delivery').check();await page.getByLabel('Stock pool',{exact:true}).selectOption(source);
 await page.screenshot({path:'test-results/branch/desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/branch/mobile.png',fullPage:true});
 await save.click();await expect(page.getByText('Temporary connection failure')).toBeVisible();await save.click();await expect(page.getByText(/Branch created and connected/)).toBeVisible();expect(requests).toHaveLength(2);expect(requests[1]).toEqual(requests[0]);expect(requests[0].branch).toEqual({address:'Ismailia',delivery_enabled:mode==='delivery',pickup_enabled:mode==='pickup',stock_id:source});expect(errors).toEqual([]);
});
