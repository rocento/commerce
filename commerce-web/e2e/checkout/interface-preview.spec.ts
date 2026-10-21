import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const theme = JSON.parse(readFileSync(new URL('../../packages/api-client/src/theme-contract.json', import.meta.url), 'utf8')).default;
const customer = { id: '11111111-1111-4111-8111-111111111111', email: 'sarah@example.test', mobile_number: null, primary_identifier: 'email', verified: true };
const address = { id: '22222222-2222-4222-8222-222222222222', label: 'home', custom_label: '', latitude: 30.03, longitude: 31.47, formatted_address: '24 Garden Street', building: '24', floor: '2', apartment: '5', delivery_instructions: 'Ring the doorbell, please.', is_default: true, updated_at: '2026-09-17T10:00:00Z', geography: { country_code: 'EG', state_code: '11', state_name: 'Cairo', city_id: '7799991', city_name: 'New Cairo' }, location_method: 'neighborhood' };
const product = '33333333-3333-4333-8333-333333333333';
const imageId = '77777777-7777-4777-8777-777777777777';
const item = { product_id: product, name: 'Everyday Essentials Collection', sku: 'ESS-01', unit: 'set', price: '85.00', currency: 'USD', quantity: 2, reserved_quantity: 2, available: 10, line_total: '170.00', discount_amount: '0', discount_snapshot: [] };
const cart = { id: '44444444-4444-4444-8444-444444444444', customer_id: customer.id, items: [item], subtotal: '170.00', currency: 'USD', fully_reserved: true, discount_amount: '0', discount_snapshot: [], coupon_code: null, coupon_error: null };
function makeQuote(n = 1, gift = '', expiry = 300000) { return { id: `55555555-5555-4555-8555-${String(n).padStart(12, '0')}`, expires_at: new Date(Date.now() + expiry).toISOString(), snapshot: { items: [item], location: address, contact: customer, subtotal: '170.00', discount_amount: '0', discount_snapshot: [], delivery_fee: '5.00', tax_amount: '0.00', tax_snapshot: { name: 'Tax', amount: '0.00' }, total: '175.00', currency: 'USD', payment_method: 'cod', gift_message: gift } }; }
async function setup(page: Page, options: { scheduled?: boolean; guest?: boolean; empty?: boolean; unreserved?: boolean; expiry?: number; failPlace?: number; delayQuote?: number; delayCoupon?: number; store?: string } = {}) {
  let heldLocation = "";
  const slot = {schedule_id: "99999999-9999-4999-8999-999999999999",source_id: "00000000-0000-0000-0000-000000000001",method: "scheduled_delivery",timezone: "Africa/Cairo",starts_at: "2026-09-25T06:00:00Z",ends_at: "2026-09-25T07:00:00Z",availability: "AVAILABLE"};
  let quotes = 0; const submissions: { quote_id: string; idempotency_key: string }[] = [];
  const configuration = options.store ? JSON.parse(readFileSync(new URL(`../../../commerce-demo/${options.store}/theme.json`, import.meta.url), 'utf8'), (_key, value) => typeof value !== 'string' ? value : value.startsWith('asset:') ? imageId : value.startsWith('category-link:') ? '/categories/' + product : value.startsWith('category:') ? product : value) : theme;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/theme/')) return route.fulfill({ json: { configuration, cities: [] } });
    if (path.endsWith('/auth/refresh')) return route.fulfill(options.guest ? { status: 401, json: { error: 'Sign in' } } : { json: { customer, access_token: 'test-token' } });
    if (path.endsWith('/customer/me')) return route.fulfill({ json: customer });
    if (path.endsWith('/customer/locations')) return route.fulfill({ json: [address, { ...address, id: '88888888-8888-4888-8888-888888888888', formatted_address: 'Office Avenue', is_default: false }] });
    if (path.endsWith('/fulfillment/availability')) return route.fulfill({status:404,json:{error:'Legacy API'}});
    if (path.endsWith('/fulfillment/delivery-options')) return route.fulfill({json:{enabled:!!options.scheduled,slots:options.scheduled?[slot]:[]}});
    if (path.endsWith('/fulfillment/reservations')) { heldLocation=route.request().postDataJSON().location_id; return route.fulfill({json:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',...slot,status:'HELD',expires_at:new Date(Date.now()+600000).toISOString()}}); }
    if (path.endsWith('/checkout/quote')) { const n = ++quotes; const input = route.request().postDataJSON(); if(options.scheduled && heldLocation!==input.location_id) return route.fulfill({status:400,json:{code:'SLOT_SELECTION_REQUIRED',error:'Choose a delivery window.'}}); if (options.delayQuote) await new Promise(resolve => setTimeout(resolve, options.delayQuote)); const quote=makeQuote(n,input.gift_message,options.expiry); return route.fulfill({ json: options.scheduled ? {...quote,snapshot:{...quote.snapshot,scheduled_delivery:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',...slot,requirement:{orders:1}}}} : quote }); }
    if (path.endsWith('/checkout/place')) { submissions.push(route.request().postDataJSON()); if (options.failPlace) return route.fulfill({ status: options.failPlace, json: { error: 'Connection interrupted. Please retry.' } }); await new Promise(resolve => setTimeout(resolve, 100)); return route.fulfill({ json: { order: { id: '66666666-6666-4666-8666-666666666666' } } }); }
    if (path.endsWith('/customer/orders/66666666-6666-4666-8666-666666666666')) return route.fulfill({ json: { order: { ...makeQuote().snapshot, id: '66666666-6666-4666-8666-666666666666', number: 1001, status: 'placed' }, items: [item], history: [], payment: { collected_at: null }, refunds: [], shipments: [], dispatch: null } });
    if (path.endsWith('/cart/coupon')) { if (options.delayCoupon) await new Promise(resolve => setTimeout(resolve, options.delayCoupon)); return route.fulfill({ json: cart }); }
    if (path.includes('/catalog/products/')) return route.fulfill({ json: { media_ids: [imageId] } });
    if (path.includes('/catalog/media/')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#f5efe3"/><rect x="35" y="35" width="58" height="68" rx="6" fill="#bbc8b7"/><path d="M49 36V25h30v11" fill="none" stroke="#42634a" stroke-width="5"/></svg>' });
    if (path.includes('/cart')) return route.fulfill({ json: { ...cart, items: options.empty ? [] : cart.items, fully_reserved: !options.unreserved } });
    if (path.endsWith('/search')) return route.fulfill({ json: { hits: [], total: 0, facets: {} } });
    if (path.includes('/content/')) return route.fulfill({ json: null });
    return route.fulfill({ json: [] });
  });
  return { submissions, quotes: () => quotes };
}

const registry=JSON.parse(readFileSync(new URL('../../../commerce-api/interface-messages.json',import.meta.url),'utf8'));
const bundle={revision:1,catalog_version:'test',messages:registry.messages.map((m:Record<string,unknown>)=>({plural:null,...m})),overrides:[]};
test('Arabic checkout preview preserves state and cannot place orders',async({page})=>{
 const calls=await setup(page);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/language-preview-host',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<html><body><iframe style="width:100%;height:1000px;border:0" src="/checkout?interface_preview=ar&interface_parent=http%3A%2F%2F127.0.0.1%3A5273&interface_channel=test"></iframe><script>window.addEventListener('message',e=>{if(e.data?.type==='rocento:interface-preview-ready')e.source.postMessage({type:'rocento:interface-preview-bundle',channel:'test',bundle:${JSON.stringify(bundle)}},e.origin)});</script></body></html>`}));
 await page.goto('/language-preview-host');const frame=page.frameLocator('iframe');
 await expect(frame.locator('html')).toHaveAttribute('dir','rtl');await expect(frame.locator('html')).toHaveAttribute('lang','ar');
 await expect(frame.getByRole('heading',{name:'عنوان التوصيل',exact:true})).toBeVisible();
 await expect(frame.getByText('Everyday Essentials Collection',{exact:true})).toBeVisible();
 await expect(frame.getByRole('button',{name:/إرسال الطلب|تأكيد الطلب|Place order/}).last()).toBeDisabled();
 await frame.getByRole('checkbox',{name:/أوافق على دفع/}).check();
 await frame.getByLabel('Preview language').selectOption('en');
 await expect(frame.locator('html')).toHaveAttribute('dir','ltr');
 await expect(frame.getByRole('checkbox',{name:/I confirm payment/})).toBeChecked();
 await expect(frame.getByRole('button',{name:'Place order · $175.00',exact:true})).toBeDisabled();
 await expect(frame.getByText('24 Garden Street, New Cairo, Cairo, Egypt',{exact:true}).last()).toBeVisible();
 await frame.getByLabel('Preview language').selectOption('ar');await page.setViewportSize({width:390,height:844});
 expect(await frame.locator('html').evaluate(el=>el.scrollWidth<=window.innerWidth)).toBe(true);
 await page.screenshot({path:'test-results/interface-preview-mobile.png',fullPage:true});
 await frame.getByRole('link',{name:'العودة إلى السلة',exact:true}).first().click();
 await expect(frame.getByRole('heading',{name:'سلة التسوق',exact:true,level:1})).toBeVisible();
 await expect(frame.getByText('Everyday Essentials Collection',{exact:true})).toBeVisible();
 await frame.getByLabel('Preview language').selectOption('en');
 await expect(frame.getByRole('heading',{name:'Shopping cart',exact:true})).toBeVisible();
 expect(calls.submissions).toEqual([]);expect(errors).toEqual([]);
});
test('a standalone draft URL requires the admin bridge',async({page})=>{
 await setup(page);await page.goto('/checkout?interface_preview=ar');
 await expect(page.getByRole('heading',{name:'Preview unavailable'})).toBeVisible();
 await expect(page.getByRole('button',{name:/Place order/})).toHaveCount(0);
});

test('admin language editor transfers saved drafts to its paired storefront frame',async({page})=>{
 await setup(page);
 await page.route('**/api/v1/admin/**',route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/admin/me'))return route.fulfill({json:{user:{id:'test',name:'Language manager',email:'test@example.test',role_id:'test',active:true},permissions:['languages.read','languages.write']}});
  if(path.endsWith('/languages/interface'))return route.fulfill({json:bundle});
  if(path.endsWith('/languages'))return route.fulfill({json:{source_locale:'en',languages:[],publication_available:false}});
  return route.fulfill({status:404,json:{error:'Not configured'}});
 });
 await page.goto('http://127.0.0.1:5274/settings/languages');
 await page.getByRole('button',{name:'Shopping interface',exact:true}).click();
 await page.getByRole('button',{name:'Preview storefront',exact:true}).click();
 const frame=page.frameLocator('iframe[title="Storefront interface preview"]');
 await expect(frame.getByLabel('Preview language')).toHaveValue('ar');
 await expect(frame.locator('html')).toHaveAttribute('dir','rtl');
 await page.getByRole('button',{name:'Mobile size',exact:true}).click();
 await expect(page.locator('iframe')).toHaveClass(/mobile/);
 await page.getByRole('button',{name:'Close preview',exact:true}).click();
 await expect(page.getByRole('button',{name:'Preview storefront',exact:true})).toBeVisible();
});

async function openJourneyPreview(page:Page,path:string) {
 const target=path+(path.includes('?')?'&':'?')+'interface_preview=ar&interface_parent=http%3A%2F%2F127.0.0.1%3A5273&interface_channel=journey';
 await page.route('**/journey-preview-host',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><iframe style="width:100%;height:100vh;border:0" src="${target.replaceAll('&','&amp;')}"></iframe><script>window.addEventListener('message',e=>{if(e.data?.type==='rocento:interface-preview-ready')e.source.postMessage({type:'rocento:interface-preview-bundle',channel:'journey',bundle:${JSON.stringify(bundle)}},e.origin)});</script></body></html>`}));
 await page.goto('/journey-preview-host');const frame=page.frameLocator('iframe');
 await expect(frame.getByLabel('Preview language')).toHaveValue('ar');return frame;
}
for(const width of [1440,390])test(`Arabic search to cart to checkout at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:1000});const calls=await setup(page,{store:'grocery'});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const fullProduct={id:product,name:item.name,sku:item.sku,slug:'everyday-essentials',description:'Merchant product description',price:'85.00',currency:'USD',unit:'set',active:true,in_stock:true,product_type:'simple',category_ids:[],media_ids:[imageId],attributes:{},variant_attributes:{},original_price:null};
 await page.route('**/api/v1/search?**',route=>route.fulfill({json:{hits:[fullProduct],total:1,offset:0,limit:24,facets:{}}}));
 await page.route('**/api/v1/catalog/products/'+product,route=>route.fulfill({json:fullProduct}));
 await page.route('**/api/v1/inventory/'+product,route=>route.fulfill({json:{product_id:product,available:10,on_hand:12,reserved:2}}));
 let currentQuantity=2;const savedQuantities:number[]=[];
 await page.route('**/api/v1/cart**',route=>{
  if(route.request().method()==='PUT'&&new URL(route.request().url()).pathname.endsWith('/items/'+product)){currentQuantity=route.request().postDataJSON().quantity;savedQuantities.push(currentQuantity);}
  return route.fulfill({json:{...cart,subtotal:String(currentQuantity*85),items:[{...item,quantity:currentQuantity,reserved_quantity:currentQuantity,line_total:String(currentQuantity*85)}]}});
 });
 const frame=await openJourneyPreview(page,'/search');
 if(width===390)await frame.locator('.store-header').getByRole('button',{name:'بحث',exact:true}).click();
 const search=frame.getByRole('combobox',{name:'البحث عن المنتجات',exact:true});
 await search.fill('حليب');await expect(frame.getByRole('option').filter({hasText:item.name})).toBeVisible();
 await frame.getByLabel('Preview language').selectOption('en');await expect(frame.getByRole('combobox',{name:'Search products',exact:true})).toHaveValue('حليب');
 await frame.getByLabel('Preview language').selectOption('ar');await search.press('Enter');
 await expect(frame.getByText('نتائج البحث عن «حليب»',{exact:true})).toBeVisible();
 await expect(frame.getByLabel('ترتيب المنتجات')).toBeVisible();
 await frame.getByLabel('ترتيب المنتجات').selectOption('price:asc');
 if(width===390)await frame.getByRole('button',{name:'عرض الفلاتر',exact:true}).click();
 await expect(frame.getByLabel('الحد الأدنى للسعر',{exact:true})).toBeVisible();
 await frame.getByLabel('الحد الأدنى للسعر',{exact:true}).fill('12');
 await frame.getByLabel('Preview language').selectOption('en');await expect(frame.getByLabel('Minimum price',{exact:true})).toHaveValue('12');
 await frame.getByLabel('Preview language').selectOption('ar');
 expect(await frame.locator('html').evaluate(el=>el.scrollWidth<=innerWidth)).toBe(true);
 await frame.locator('.browse-main').screenshot({path:`test-results/arabic-search-${width}.png`});
 await frame.locator('.product-grid .grocery-product-title').click();
 await expect(frame.getByRole('heading',{name:item.name,exact:true,level:1})).toBeVisible();
 await frame.getByRole('button',{name:'زيادة الكمية',exact:true}).first().click();
 await expect.poll(()=>savedQuantities).toEqual([3]);
 await expect(frame.getByLabel('الكمية في السلة',{exact:true}).first()).toHaveText('3');
 const overflow=await frame.locator('html').evaluate(el=>({width:el.scrollWidth,viewport:innerWidth,offenders:[...document.querySelectorAll('*')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.right>innerWidth+1||r.left< -1);}).slice(0,15).map(e=>({tag:e.tagName,cls:e.className,width:e.getBoundingClientRect().width,left:e.getBoundingClientRect().left}))}));
 expect(overflow.width,JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport);
 await frame.locator(width < 768 ? '.mobile-bottom-nav .cart-link' : '.store-header .cart-link').click();
 const drawer=frame.getByRole('dialog');await expect(drawer).toBeVisible();
 await drawer.getByRole('link',{name:'عرض السلة كاملة',exact:true}).click();
 await expect(frame.getByRole('heading',{name:'سلة التسوق',exact:true,level:1})).toBeVisible();
 await expect(frame.getByText('الحجز قيد الانتظار',{exact:true})).toBeVisible();
 await frame.getByRole('link',{name:'إتمام الشراء',exact:true}).click();
 await expect(frame.getByRole('heading',{name:'عنوان التوصيل',exact:true})).toBeVisible();
 await expect(frame.locator('.checkout-submit')).toBeDisabled();
 await frame.locator('.checkout-flow').screenshot({path:`test-results/arabic-checkout-${width}.png`});expect(calls.submissions).toEqual([]);expect(errors).toEqual([]);
});

test('Arabic address errors and quantity constraints translate without changing submitted values',async({page})=>{
 await setup(page);const frame=await openJourneyPreview(page,'/checkout');
 await frame.getByRole('button',{name:'تعديل العنوان المحدد',exact:true}).click();
 const street=frame.getByLabel('عنوان الشارع',{exact:true});await street.fill('');
 await frame.getByRole('button',{name:'استخدام هذا العنوان',exact:true}).click();
 expect(await street.evaluate((el:HTMLInputElement)=>el.validationMessage)).toBe('هذا الحقل مطلوب');
 await frame.getByLabel('Preview language').selectOption('en');
 expect(await frame.getByLabel('Street address',{exact:true}).evaluate((el:HTMLInputElement)=>el.validity.customError)).toBe(false);
 await frame.getByRole('link',{name:'Return to cart',exact:true}).first().click();
 await frame.getByLabel('Preview language').selectOption('ar');
 const quantity=frame.locator('.cart-quantity input');await quantity.fill('0');await frame.getByRole('button',{name:'تحديث',exact:true}).click();
 expect(await quantity.evaluate((el:HTMLInputElement)=>el.validationMessage)).toContain('لا تقل عن');
 await quantity.fill('2');expect(await quantity.evaluate((el:HTMLInputElement)=>el.validity.valid)).toBe(true);
});

test('known cart failures change language and remain recoverable',async({page})=>{
 await setup(page);
 await page.route('**/api/v1/cart/items/'+product,route=>route.fulfill({status:400,json:{error:'Quantity is invalid'}}));
 const frame=await openJourneyPreview(page,'/cart');
 await frame.locator('.cart-quantity input').fill('3');await frame.getByRole('button',{name:'تحديث',exact:true}).click();
 await expect(frame.getByRole('alert')).toContainText('الكمية غير صحيحة');
 await frame.getByLabel('Preview language').selectOption('en');await expect(frame.getByRole('alert')).toContainText('Quantity is invalid');
 await expect(frame.locator('.cart-quantity input')).toHaveValue('3');
});
test('Arabic scheduled delivery preserves slot identity and quote totals',async({page})=>{
 const calls=await setup(page,{scheduled:true});const frame=await openJourneyPreview(page,'/checkout');
 const section=frame.locator('section').filter({has:frame.getByRole('heading',{name:'فترة التوصيل',exact:true})});
 await section.getByRole('button').filter({hasText:'توصيل في موعد محدد'}).click();
 await expect(frame.getByText('توصيل في موعد محدد',{exact:true}).first()).toBeVisible();
 await expect(frame.locator('.checkout-grand-total')).toContainText('$175.00');
 await expect(frame.locator('.checkout-submit')).toBeDisabled();expect(calls.submissions).toEqual([]);
});
