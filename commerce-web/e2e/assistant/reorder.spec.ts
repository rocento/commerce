import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const theme = JSON.parse(readFileSync(new URL('../../packages/api-client/src/theme-contract.json',import.meta.url),'utf8')).default;
const id='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
const address={id,label:'home',custom_label:'',formatted_address:'Garden Street',latitude:30,longitude:31,building:'2',floor:'1',apartment:'4',delivery_instructions:'',is_default:true,updated_at:'2026-10-01T00:00:00Z'};
const customer={id,email:'shopper@example.test',verified:true};
const order={id,number:106,status:'delivered',total:'6.00',currency:'USD',location:address,created_at:'2026-09-01T00:00:00Z'};
for(const scenario of ['empty','keep','replace','changed-address','retry','changed-cart','clear-failure','unavailable'] as const) test(`reorder ${scenario}`,async({page})=>{
 let qty=scenario==='empty'||scenario==='changed-address'||scenario==='retry'||scenario==='unavailable'?0:1;
 let applies=0,removes=0,orders=0,confirmed=0,applied=false;
 let proposal: Record<string, unknown>;
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const cart=()=>({id,customer_id:id,items:qty?[{product_id:id,name:'Apples',sku:'APP',quantity:qty,price:'3.00',line_total:String(qty*3),currency:'USD',unit:'each',discount_amount:'0',reserved_quantity:qty,available:20}]:[],subtotal:String(qty*3),discount_amount:'0',currency:'USD',fully_reserved:true});
 await page.route('**/api/**',async route=>{
 const path=new URL(route.request().url()).pathname;
 if(path.includes('/theme/'))return route.fulfill({json:{configuration:theme,cities:[]}});
 if(path.endsWith('/auth/refresh'))return route.fulfill({json:{customer,access_token:'fixture'}});
 if(path.endsWith('/customer/me'))return route.fulfill({json:customer});
 if(path.endsWith('/customer/locations'))return route.fulfill({json:scenario==='changed-address'?[{...address,id:other,building:'99'}]:[address]});
 if(path.endsWith('/cart'))return route.fulfill({json:cart()});
 if(path.includes('/cart/items/')&&route.request().method()==='DELETE'){removes++;qty=0;if(scenario==='clear-failure')return route.fulfill({status:503,json:{error:'Interrupted'}});return route.fulfill({json:cart()});}
 if(path.endsWith('/customer/orders/'+id))return route.fulfill({json:{order,items:[],shipments:[],history:[],payment:{},refunds:[],dispatch:{}}});
 if(path.includes('/cart/shopping/'))return route.fulfill({json:{task_revision:0,source_revision:1,proposal_id:null,locations:[address]}});
 if(path.endsWith('/cart/proposals')){proposal={id:other,draft:route.request().postDataJSON(),can_apply:scenario!=='unavailable',applied:false,execution:null,expires_at:new Date(Date.now()+600000).toISOString(),lines:[],resulting_items:[],current_items:[],after:{subtotal:'0',discount:'0',tax:null,delivery:null,payable:null,merchandise_total:'0',currency:'USD',promotions:[]},issues:['Apples are unavailable'],notes:[]};return route.fulfill({json:proposal});}
 if(path.endsWith('/cart/proposals/'+other))return route.fulfill({json:{...proposal,applied}});
 if(path.endsWith('/trust/confirm')){confirmed++;return route.fulfill({json:{}});}
 if(path.endsWith('/apply')){applies++;qty+=2;applied=true;if(scenario==='retry')return route.fulfill({status:503,json:{error:'Response lost'}});return route.fulfill({json:cart()});}
 if(path.endsWith('/checkout/place')){orders++;return route.fulfill({status:500,json:{error:'Unexpected order'}});}
 if(path.includes('/catalog/products/'))return route.fulfill({json:{id,name:'Apples',media_ids:[],attributes:{},price:'3',currency:'USD',unit:'each',in_stock:true}});
 if(path.includes('/delivery-area'))return route.fulfill({json:{configured:false,deliverable:true}});
 if(path.endsWith('/assistant/chat')){const input=route.request().postDataJSON();return route.fulfill({contentType:'text/event-stream',body:[{type:'card.order',order:{id:order.id,number:order.number,status:order.status,total:order.total,currency:order.currency,subtotal:'6',discount_amount:'0',tax_amount:'0',delivery_fee:'0',cancellation_available:false,shipments:[]}},{type:'done'}].map((event,sequence)=>`data: ${JSON.stringify({version:'1',request_id:input.request_id,sequence,...event})}\n\n`).join('')});}
 return route.fulfill({json:[]});
 });
 await page.goto('/assistant');
 await page.getByRole('button',{name:'Orders',exact:true}).click();
 await page.getByRole('button',{name:'Reorder',exact:true}).click();
 const reply = page.locator('.assistant-message.assistant').last();
 await expect(reply).toContainText('Let’s reorder #106.');
 await expect(reply.locator('.assistant-order-reorder')).toHaveCount(1);
 await expect(page.locator('.assistant-order-card .assistant-cart-card')).toHaveCount(0);
 if(['keep','replace','changed-cart','clear-failure'].includes(scenario)){
 await expect(page.getByRole('heading',{name:'Keep your cart or start fresh?'})).toBeVisible();
 expect(applies).toBe(0);expect(removes).toBe(0);
 if(scenario==='changed-cart')qty=3;
 await page.getByRole('button',{name:['keep','changed-cart'].includes(scenario)?'Keep cart and add order items':'Empty cart and rebuild this order',exact:true}).click();
 if(scenario==='changed-cart') { await expect(page.getByRole('alert')).toContainText('Your cart changed');expect(applies).toBe(0);expect(removes).toBe(0);return; }
 if(scenario==='clear-failure') { await expect(page.getByRole('alert')).toContainText('Clearing stopped');expect(applies).toBe(0);await page.getByRole('button',{name:'Keep cart and add order items',exact:true}).click(); }

 }
 if(scenario==='changed-address'){
 await expect(page.getByRole('heading',{name:'Confirm your delivery address'})).toBeVisible();expect(applies).toBe(0);
 await page.getByRole('button',{name:'Use this address',exact:true}).click();
 }
 if(scenario==='unavailable'){await expect(page.getByText('Apples are unavailable',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Requote selected changes'})).toBeVisible();await expect(page.getByRole('button',{name:'Approve and apply to cart'})).toBeDisabled();expect(applies).toBe(0);expect(orders).toBe(0);expect(errors).toEqual([]);return;}
 if(scenario==='retry')await page.getByRole('button',{name:'Check and finish cart update',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Your reorder cart is ready'})).toBeVisible();
 await expect(reply.getByRole('button', { name: 'Your cart', exact: true })).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
 await expect(reply.getByRole('button', { name: 'Apples', exact: true })).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
 expect(qty).toBe(scenario==='keep'?3:2);expect(applies).toBe(1);expect(confirmed).toBe(1);expect(removes).toBe(['replace','clear-failure'].includes(scenario)?1:0);expect(orders).toBe(0);
 await expect(page.getByRole('button',{name:'Continue to checkout',exact:true})).toBeVisible();
 if(scenario==='retry') {
 await page.reload(); await page.getByRole('button',{name:'Orders',exact:true}).click(); await page.getByRole('button',{name:'Reorder',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Your reorder cart is ready'})).toBeVisible(); expect(applies).toBe(1);expect(qty).toBe(2);
 }
 expect(errors).toEqual([]);
});
