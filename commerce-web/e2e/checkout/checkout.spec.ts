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
async function setup(page: Page, options: { scheduled?: boolean; guest?: boolean; noAddresses?: boolean; empty?: boolean; unreserved?: boolean; expiry?: number; failPlace?: number; delayQuote?: number; delayCoupon?: number; store?: string } = {}) {
  let heldLocation = "";
  const slot = {schedule_id: "99999999-9999-4999-8999-999999999999",source_id: "00000000-0000-0000-0000-000000000001",method: "scheduled_delivery",timezone: "Africa/Cairo",starts_at: "2026-09-25T06:00:00Z",ends_at: "2026-09-25T07:00:00Z",availability: "AVAILABLE"};
  let quotes = 0; const submissions: { quote_id: string; idempotency_key: string }[] = [];
  const configuration = options.store ? JSON.parse(readFileSync(new URL(`../../../commerce-demo/${options.store}/theme.json`, import.meta.url), 'utf8'), (_key, value) => typeof value !== 'string' ? value : value.startsWith('asset:') ? imageId : value.startsWith('category-link:') ? '/categories/' + product : value.startsWith('category:') ? product : value) : theme;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/theme/')) return route.fulfill({ json: { configuration, cities: [] } });
    if (path.endsWith('/auth/refresh')) return route.fulfill(options.guest ? { status: 401, json: { error: 'Sign in' } } : { json: { customer, access_token: 'test-token' } });
    if (path.endsWith('/customer/me')) return route.fulfill({ json: customer });
    if (path.endsWith('/customer/locations')) return route.fulfill({ json: options.noAddresses ? [] : [address, { ...address, id: '88888888-8888-4888-8888-888888888888', formatted_address: 'Office Avenue', is_default: false }] });
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
for (const store of ['grocery', 'jewelry', 'electronics']) {
  test(`${store}: focused single-page checkout, exact total and no storefront chrome`, async ({ page }, info) => {
    await setup(page, { store });
    await page.goto('/checkout');
    await expect(page.locator('.store-header, .theme-global-top, .theme-global-bottom, footer')).toHaveCount(0);
    for (const name of ['Contact', 'Delivery address', 'Delivery method', 'Payment']) await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Place order · $175.00', exact: true })).toBeDisabled();
    await expect(page.getByText('Everyday Essentials Collection', { exact: true })).toBeVisible();
    await expect(page.getByText('24 Garden Street, New Cairo, Cairo, Egypt', { exact: true }).last()).toBeVisible();
    await page.getByRole('checkbox', { name: /I confirm payment/ }).check();
    await expect(page.getByRole('button', { name: 'Place order · $175.00', exact: true })).toBeEnabled();
    await page.screenshot({ path: info.outputPath(`${store}-checkout-desktop.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const toggle = page.getByRole('button', { name: /Show order summary/ });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByRole('heading', { name: 'Order summary', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${store}-checkout-mobile.png`), fullPage: true });
  });
}
test('guest checkout and sign-in continuation have no store header or footer', async ({ page }) => {
  await setup(page, { guest: true }); await page.goto('/checkout');
  await expect(page.getByRole('link', { name: 'Sign in to checkout' })).toBeVisible();
  await expect(page.locator('.store-header, footer')).toHaveCount(0);
  await page.getByRole('link', { name: 'Sign in to checkout' }).click();
  await expect(page).toHaveURL(/login\?next=checkout/);
  await expect(page.locator('.store-header, footer')).toHaveCount(0);
});
test('customer without an address adds delivery details inside checkout', async ({ page }) => {
  const state = await setup(page, { noAddresses: true });
  await page.goto('/checkout');
  await expect(page.getByRole('heading', { name: 'Add delivery address', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/checkout$/);
  await expect(page.getByRole('button', { name: /Place order/ })).toBeDisabled();
  expect(state.quotes()).toBe(0);
});
test('expired total must be refreshed and payment reconfirmed', async ({ page }) => {
  await setup(page, { expiry: 1800 }); await page.goto('/checkout');
  await page.getByRole('checkbox', { name: /I confirm payment/ }).check();
  await expect(page.getByRole('button', { name: 'Refresh total', exact: true })).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('button', { name: 'Place order · $175.00', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Refresh total', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /I confirm payment/ })).not.toBeChecked();
});
for (const failPlace of [503, 429]) test(`HTTP ${failPlace}: retries preserve the original submission across reloads`, async ({ page }) => {
  const state = await setup(page, { failPlace }); await page.goto('/checkout');
  await page.getByRole('checkbox', { name: /I confirm payment/ }).check();
  await page.getByRole('button', { name: 'Place order · $175.00', exact: true }).dblclick();
  await expect(page.getByRole('button', { name: 'Retry order confirmation' })).toBeEnabled();
  expect(state.submissions).toHaveLength(1);
  await page.reload();
  await page.getByRole('button', { name: 'Retry order confirmation' }).click();
  await expect.poll(() => state.submissions.length).toBe(2);
  expect(state.submissions[1]).toEqual(state.submissions[0]);
  await expect(page.getByRole('button', { name: /New address/ })).toHaveCount(0);
});
test('changing details disables submission immediately while a new quote is pending', async ({ page }) => {
  const state = await setup(page, { delayQuote: 600 }); await page.goto('/checkout');
  await page.getByRole('checkbox', { name: /I confirm payment/ }).check();
  await page.getByText('Add a gift message', { exact: false }).click();
  await page.getByLabel('Gift message', { exact: true }).fill('Happy birthday');
  await expect(page.getByRole('button', { name: /Place order/ })).toBeDisabled();
  await expect.poll(state.quotes).toBeGreaterThan(1);
  await expect(page.getByRole('checkbox', { name: /I confirm payment/ })).not.toBeChecked();
});
test('address cards refresh the quote and new addresses default to pinning', async ({ page }) => {
  const state = await setup(page, { delayQuote: 300 });
  await page.goto('/checkout');
  await page.getByRole('checkbox', { name: /I confirm payment/ }).check();
  const addresses = page.getByRole('group', { name: 'Saved addresses' });
  await expect(addresses.getByRole('radio')).toHaveCount(2);
  await expect(addresses.getByRole('radio').first()).toBeChecked();
  await addresses.getByRole('radio', { name: /Office Avenue/ }).check();
  await expect(page.getByRole('checkbox', { name: /I confirm payment/ })).not.toBeChecked();
  await expect.poll(state.quotes).toBeGreaterThan(1);
  await expect(page.getByRole('button', { name: /Place order/ })).toBeDisabled();
  await page.getByRole('button', { name: /New address/ }).click();
  await expect(page.getByRole('radio', { name: /Pin your building entrance/ })).toBeChecked();
  await expect(page.getByLabel('Delivery location map', { exact: true })).toBeVisible();
});
test('grocery plus adds immediately, changes cart quantity, and removes the last item', async ({ page }) => {
  await setup(page, { store: 'grocery' });
  let quantity = 0;
  let failUpdate = false;
  await page.route('**/api/v1/cart**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/items')) {
      if (failUpdate) return route.fulfill({ status: 503, json: { error: 'Please retry' } });
      const method = route.request().method();
      quantity = method === 'DELETE' ? 0 : method === 'POST' ? quantity + route.request().postDataJSON().quantity : route.request().postDataJSON().quantity;
    }
    return route.fulfill({ json: { ...cart, items: quantity ? [{ ...item, quantity, reserved_quantity: quantity }] : [] } });
  });
  await page.route('**/api/v1/inventory/**', route => route.fulfill({ json: { available: 3 - quantity } }));
  await page.route(`**/api/v1/catalog/products/${product}`, route => route.fulfill({ json: { id: product, name: item.name, sku: item.sku, price: item.price, currency: 'USD', unit: 'set', description: 'Everyday essentials', product_type: 'simple', media_ids: [imageId], attributes: {}, in_stock: true } }));
  await page.goto(`/products/${product}`);
  const control = page.locator('.purchase-card .grocery-add-to-cart');
  const plus = control.getByRole('button', { name: `Add ${item.name} to cart`, exact: true });
  await expect(plus).toBeVisible();
  await expect(control.getByLabel('Quantity in cart')).toHaveText('0');
  await expect(control.getByRole('button', { name: 'Decrease quantity' })).toBeDisabled();
  await plus.click();
  await expect(control.getByLabel('Quantity in cart')).toHaveText('1');
  await control.getByRole('button', { name: 'Increase quantity' }).click();
  await expect(control.getByLabel('Quantity in cart')).toHaveText('2');
  await expect(control).toHaveAttribute('data-syncing', 'false');
  expect(quantity).toBe(2);
  failUpdate = true;
  await control.getByRole('button', { name: 'Decrease quantity' }).click();
  await expect(control.getByRole('alert')).toBeVisible();
  await expect(control.getByLabel('Quantity in cart')).toHaveText('2');
  failUpdate = false;
  await control.getByRole('button', { name: 'Decrease quantity' }).click();
  await expect(control.getByLabel('Quantity in cart')).toHaveText('1');
  await expect(control).toHaveAttribute('data-syncing', 'false');
  await control.getByRole('button', { name: 'Remove from cart' }).click();
  await expect(plus).toBeVisible();
  await expect.poll(() => quantity).toBe(0);
});

for (const width of [390, 1440]) test(`grocery quantities stay responsive during slow saves at ${width}px`, async ({ page }) => {
  await setup(page, { store: 'grocery' });
  await page.setViewportSize({ width, height: 1000 });
  let quantity = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const writes: number[] = [];
  let opens = 0;
  const snapshot = () => ({ ...cart, items: quantity ? [{ ...item, quantity, reserved_quantity: quantity, available: 5, line_total: String(quantity * 85) }] : [], subtotal: String(quantity * 85) });
  await page.route('**/api/v1/cart**', async route => {
    if (new URL(route.request().url()).pathname.includes('/items')) {
      const next = route.request().method() === 'DELETE' ? 0 : route.request().postDataJSON().quantity;
      writes.push(next);
      if (writes.length === 1) await held;
      quantity = next;
    } else { opens++; }
    return route.fulfill({ json: snapshot() });
  });
  await page.route('**/api/v1/inventory/**', route => route.fulfill({ json: { available: 5 - quantity } }));
  await page.route(`**/api/v1/catalog/products/${product}`, route => route.fulfill({ json: { id: product, name: item.name, sku: item.sku, price: item.price, currency: 'USD', unit: 'set', description: 'Everyday essentials', product_type: 'simple', media_ids: [imageId], attributes: {}, in_stock: true } }));
  await page.goto(`/products/${product}`);
  const control = page.locator('.purchase-card .grocery-add-to-cart');
  await expect(control.getByRole('button', { name: `Add ${item.name} to cart`, exact: true })).toBeEnabled();
  const initialOpens = opens;
  await control.getByRole('button', { name: `Add ${item.name} to cart`, exact: true }).click();
  await expect(control.getByLabel('Quantity in cart')).toHaveText('1');
  await expect.poll(() => writes.length).toBe(1);
  await control.getByRole('button', { name: 'Increase quantity' }).click();
  await control.getByRole('button', { name: 'Increase quantity' }).click();
  await control.getByRole('button', { name: 'Increase quantity' }).click();
  await control.getByRole('button', { name: 'Increase quantity' }).click();
  await expect(control.getByLabel('Quantity in cart')).toHaveText('5');
  await expect(control.getByRole('button', { name: 'Increase quantity' })).toBeDisabled();
  await control.getByRole('button', { name: 'Decrease quantity' }).click();
  await expect(control.getByLabel('Quantity in cart')).toHaveText('4');
  await expect(page.getByRole('link', { name: 'Cart 4', exact: true }).first()).toBeVisible();
  expect(quantity).toBe(0);
  expect(writes).toEqual([1]);
  expect(opens).toBe(initialOpens);
  release();
  await expect(control).toHaveAttribute('data-syncing', 'false');
  await expect(control.getByLabel('Quantity in cart')).toHaveText('4');
  expect(writes).toEqual([1, 4]);
  expect(quantity).toBe(4);
  expect(opens).toBe(initialOpens);
});

test('grocery pending saves survive navigation and hold checkout until the final quantity is saved', async ({ page }) => {
  const state = await setup(page, { store: 'grocery' });
  let quantity = 1;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/cart', route => route.fulfill({ json: { ...cart, items: [{ ...item, quantity, reserved_quantity: quantity }] } }));
  await page.route('**/api/v1/cart/items/**', async route => {
    await held;
    quantity = route.request().postDataJSON().quantity;
    return route.fulfill({ json: { ...cart, items: [{ ...item, quantity, reserved_quantity: quantity }] } });
  });
  await page.route('**/api/v1/inventory/**', route => route.fulfill({ json: { available: 5 } }));
  await page.route(`**/api/v1/catalog/products/${product}`, route => route.fulfill({ json: { id: product, name: item.name, sku: item.sku, price: item.price, currency: 'USD', unit: 'set', description: 'Everyday essentials', product_type: 'simple', media_ids: [imageId], attributes: {}, in_stock: true } }));
  await page.goto(`/products/${product}`);
  await page.locator('.purchase-card').getByRole('button', { name: 'Increase quantity' }).click();
  await page.locator('.cart-link').first().click();
  await page.getByRole('dialog').getByRole('link', {name:'View full cart',exact:true}).click();
  await expect(page.getByText('Saving your latest quantities…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
  await page.getByRole('link', { name: 'Checkout', exact: true }).click();
  await expect(page.getByText('Saving your latest quantities…')).toBeVisible();
  await expect(page.getByRole('button', { name: /Place order/ })).toBeDisabled();
  expect(state.quotes()).toBe(0);
  release();
  await expect(page.getByRole('checkbox', { name: /I confirm payment/ })).toBeEnabled();
  expect(quantity).toBe(2);
  expect(state.quotes()).toBe(1);
});
test('empty carts and unavailable inventory never allow submission', async ({ page }) => {
  await setup(page, { empty: true }); await page.goto('/checkout');
  await expect(page.getByRole('heading', { name: 'Your cart is empty' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Place order/ })).toHaveCount(0);
  await page.unroute('**/api/**'); await setup(page, { unreserved: true }); await page.reload();
  await expect(page.getByRole('link', { name: 'Review cart availability' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Place order/ })).toBeDisabled();
});

test('successful submission opens the confirmed order and clears its saved attempt', async ({ page }) => {
  const state = await setup(page); await page.goto('/checkout');
  await page.getByRole('checkbox', { name: /I confirm payment/ }).check();
  await page.getByRole('button', { name: 'Place order · $175.00', exact: true }).dblclick();
  await expect(page.getByRole('heading', { name: 'Your order is confirmed' })).toBeVisible();
  await page.getByRole('link', { name: 'View order', exact: true }).click();
  await expect(page).toHaveURL(/account\/orders\/66666666-6666-4666-8666-666666666666\?placed=1/);
  await expect(page.getByText('Thank you. Your order has been placed.', { exact: true })).toBeVisible();
  expect(state.submissions).toHaveLength(1);
  expect(await page.evaluate(id => sessionStorage.getItem(`checkout-attempt:${id}`), customer.id)).toBeNull();
});
test('coupon changes block ordering until the updated total is reviewed', async ({ page }) => {
  const state = await setup(page, { delayCoupon: 800 }); await page.goto('/checkout');
  await page.getByRole('checkbox', { name: /I confirm payment/ }).check();
  await page.getByRole('textbox', { name: 'Coupon code' }).fill('SAVE');
  await page.getByRole('button', { name: 'Apply coupon', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Place order · $175.00', exact: true })).toBeDisabled();
  await expect.poll(state.quotes).toBeGreaterThan(1);
  await expect(page.getByRole('checkbox', { name: /I confirm payment/ })).not.toBeChecked();
  expect(state.submissions).toHaveLength(0);
});
test('blocked browser storage prevents an unsafe order submission', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('checkout-attempt:')) throw new DOMException('Storage disabled', 'SecurityError');
      original.call(this, key, value);
    };
  });
  const state = await setup(page); await page.goto('/checkout');
  await page.getByRole('checkbox', { name: /I confirm payment/ }).check();
  await page.getByRole('button', { name: 'Place order · $175.00', exact: true }).click();
  await expect(page.getByText(/No order was sent/)).toBeVisible();
  expect(state.submissions).toHaveLength(0);
});

test('scheduled delivery hold unlocks review and displays the chosen location time',async({page})=>{
  await setup(page,{scheduled:true});
  await page.goto('/checkout');
  await expect(page.getByRole('heading',{name:'Delivery window',exact:true})).toBeVisible();
  await expect(page.getByText('Choose a delivery window.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:/scheduled delivery · Africa\/Cairo/}).click();
  await expect(page.getByText(/Window reserved/)).toBeVisible();
  await expect(page.getByText(/Scheduled for/)).toBeVisible();
  await page.getByRole('checkbox',{name:/I confirm payment/}).check();
  await expect(page.getByRole('button',{name:'Place order · $175.00',exact:true})).toBeEnabled();
});
const fulfillmentCapabilities={delivery_enabled:true,pickup_enabled:true,scheduled_delivery_enabled:false,asap_delivery_enabled:true,capacity_management_enabled:false,checkout_capacity_holds_enabled:false,geo_fencing_enabled:false,multi_source_fulfillment_enabled:false,split_order_scheduling_enabled:false,automatic_source_routing_enabled:true,customer_delivery_slot_selection_enabled:false,admin_manual_scheduling_enabled:true,pickup_scheduling_enabled:false,split_delivery_mode:'same_window_required',delivery_city_ids:[]};
test('pickup checkout has no delivery address, no calendar and zero delivery fee',async({page},info)=>{
 await setup(page);const source='00000000-0000-0000-0000-000000000001';let quoteLocation:unknown='unset';
 const plan={id:crypto.randomUUID(),method:'pickup',store_id:source,location_id:null,status:'HELD',expires_at:new Date(Date.now()+600000).toISOString(),groups:[{id:crypto.randomUUID(),source_id:source,source_name:'Cairo shop',method:'pickup',schedule_id:null,starts_at:new Date().toISOString(),ends_at:new Date(Date.now()+1800000).toISOString(),timezone:'UTC',items:[{product_id:product,quantity:2}]}]};
 await page.route('**/api/v1/fulfillment/availability',route=>route.fulfill({json:{store_id:source,capabilities:fulfillmentCapabilities,methods:[{type:'delivery',scheduling:false,asap:true},{type:'pickup',scheduling:false,locations:[{id:source,name:'Cairo shop',instructions:'Collect at the front counter',preparation_minutes:30}]}]}}));
 await page.route('**/api/v1/fulfillment/plan-options',route=>route.fulfill({json:{capabilities:fulfillmentCapabilities,groups:[{...plan.groups[0],slots:[]}],common_windows:[]}}));
 await page.route('**/api/v1/fulfillment/plans',route=>{expect(route.request().postDataJSON().request).toMatchObject({method:'pickup',location_id:null,source_id:source});return route.fulfill({json:plan});});
 await page.route('**/api/v1/customer/locations',route=>route.fulfill({json:[]}));
 await page.route('**/api/v1/customer/checkout/quote',route=>{quoteLocation=route.request().postDataJSON().location_id;const q=makeQuote();return route.fulfill({json:{...q,snapshot:{...q.snapshot,fulfillment_plan:plan,location:{label:'Cairo shop',formatted_address:'Shop address',location_method:'pickup'},delivery_fee:'0.00',total:'170.00'}}});});
 await page.goto('/checkout');await page.getByRole('radio',{name:'Pickup Collect from a pickup location',exact:true}).check();
 await page.getByRole('radio',{name:/Cairo shop Collect at the front counter/}).check();
 await expect(page.getByText('Ready ASAP after preparation.')).toBeVisible();await expect(page.locator('input[type=date]')).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'Delivery',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Confirm pickup location and time',exact:true}).click();
 await expect(page.getByRole('button',{name:'Place order · $170.00',exact:true})).toBeVisible();expect(quoteLocation).toBeNull();
 await page.getByRole('checkbox',{name:/in cash at pickup/}).check();await expect(page.getByRole('button',{name:'Place order · $170.00',exact:true})).toBeEnabled();
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('pickup-mobile.png'),fullPage:true});
});
test('delivery-only capabilities omit method selector and scheduled controls',async({page})=>{
 await setup(page);await page.route('**/api/v1/fulfillment/availability',route=>route.fulfill({json:{store_id:customer.id,capabilities:{...fulfillmentCapabilities,pickup_enabled:false},methods:[{type:'delivery',scheduling:false,asap:true}]}}));
 await page.route('**/api/v1/fulfillment/plan-options',route=>route.fulfill({json:{capabilities:fulfillmentCapabilities,groups:[{source_id:customer.id,source_name:'Main warehouse',items:[{product_id:product,quantity:2}],slots:[]}],common_windows:[]}}));
 await page.goto('/checkout');await expect(page.getByRole('heading',{name:'Delivery availability'})).toBeVisible();await expect(page.getByRole('heading',{name:'How would you like to receive your order?'})).toHaveCount(0);await expect(page.locator('input[type=date]')).toHaveCount(0);
});
test('common-window checkout reserves every split group in one request',async({page})=>{
 await setup(page);const a='00000000-0000-0000-0000-000000000001',b='00000000-0000-0000-0000-000000000002';
 const capabilities={...fulfillmentCapabilities,pickup_enabled:false,scheduled_delivery_enabled:true,asap_delivery_enabled:false,multi_source_fulfillment_enabled:true,split_order_scheduling_enabled:true,customer_delivery_slot_selection_enabled:true};
 const start='2026-09-25T09:00:00Z',end='2026-09-25T10:00:00Z';const groups=[a,b].map((source_id,i)=>({source_id,source_name:`Warehouse ${i+1}`,items:[{product_id:product,quantity:1}],slots:[{source_id,schedule_id:source_id,starts_at:start,ends_at:end,timezone:'UTC',method:'delivery',availability:'AVAILABLE'}]}));let selected:{windows:{source_id:string;starts_at:string;ends_at:string}[]}|undefined;
 await page.route('**/api/v1/fulfillment/availability',r=>r.fulfill({json:{store_id:a,capabilities,methods:[{type:'delivery',scheduling:true,asap:false}]}}));
 await page.route('**/api/v1/fulfillment/plan-options',r=>r.fulfill({json:{capabilities,groups,common_windows:[[start,end]]}}));
 await page.route('**/api/v1/fulfillment/plans',r=>{selected=r.request().postDataJSON();return r.fulfill({json:{id:crypto.randomUUID(),method:'delivery',store_id:a,location_id:address.id,status:'HELD',expires_at:new Date(Date.now()+600000).toISOString(),groups:groups.map(g=>({...g,id:crypto.randomUUID(),...g.slots[0]}))}});});
 await page.goto('/checkout');const section=page.locator('section').filter({has:page.getByRole('heading',{name:'Delivery availability',exact:true})});await section.getByRole('button').first().click();await page.getByRole('button',{name:'Confirm delivery availability',exact:true}).click();
 await expect(page.getByText(/Fulfillment reserved until/)).toBeVisible();expect(selected!.windows).toHaveLength(2);expect(selected!.windows.map(w=>w.source_id)).toEqual([a,b]);expect(selected!.windows.every(w=>w.starts_at===start&&w.ends_at===end)).toBe(true);
});

for (const width of [390, 1440]) test(`checkout heading renders before theme and session resolve at ${width}px`, async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width, height: 900 });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/theme/') || path.endsWith('/auth/refresh')) await pending;
    await route.fallback();
  });
  try {
    await page.goto('/checkout', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Checkout', exact: true })).toBeVisible();
    await expect(page.getByLabel('Loading checkout', { exact: true })).toBeVisible();
    await expect(page.getByText('Loading your store', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    release();
  }
  await expect(page.getByRole('heading', { name: 'Contact', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Checkout', exact: true })).toHaveCount(1);
});

test('changing a held delivery address never quotes against the previous plan', async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const office = { ...address, id: '88888888-8888-4888-8888-888888888888', formatted_address: 'Office Avenue', is_default: false };
  const capabilities = { ...fulfillmentCapabilities, pickup_enabled: false };
  let held: ReturnType<typeof makePlan> | undefined;
  let stale = 0;
  let quotes = 0;
  function makePlan(location: string) {
    return { id: crypto.randomUUID(), method: 'delivery', store_id: customer.id, location_id: location, status: 'HELD', expires_at: new Date(Date.now() + 600000).toISOString(), groups: [] };
  }
  await page.route('**/api/v1/fulfillment/availability', route => route.fulfill({ json: { store_id: customer.id, capabilities, methods: [{ type: 'delivery', scheduling: false, asap: true }] } }));
  await page.route('**/api/v1/fulfillment/plan-options', route => route.fulfill({ json: { capabilities, groups: [{ source_id: customer.id, source_name: 'Warehouse', items: [item], slots: [] }], common_windows: [] } }));
  await page.route('**/api/v1/fulfillment/plans', route => {
    held = makePlan(route.request().postDataJSON().request.location_id);
    return route.fulfill({ json: held });
  });
  await page.route('**/api/v1/customer/checkout/quote', route => {
    const location = route.request().postDataJSON().location_id;
    quotes++;
    if (held?.location_id !== location) {
      stale++;
      return route.fulfill({ status: 400, json: { code: 'RESERVATION_STALE', error: 'Previous address plan used' } });
    }
    const q = makeQuote(quotes);
    const other = location === office.id;
    return route.fulfill({ json: { ...q, snapshot: { ...q.snapshot, location: other ? office : address, fulfillment_plan: held, delivery_fee: other ? '10.00' : '5.00', total: other ? '180.00' : '175.00' } } });
  });
  await page.goto('/checkout');
  await page.getByRole('button', { name: 'Confirm delivery availability', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Place order · $175.00', exact: true })).toBeVisible();
  for (const destination of [office, address, office]) {
    const before = quotes;
    await page.getByRole('checkbox').check();
    await page.locator('label.saved-address-option').filter({ hasText: destination.formatted_address }).getByRole('radio').check();
    await expect(page.getByRole('button', { name: /^Place order/ })).toBeDisabled();
    // Let effects and requests settle before admitting the replacement plan.
    await page.waitForTimeout(200);
    expect(stale).toBe(0);
    expect(quotes).toBe(before);
    await page.getByRole('button', { name: 'Confirm delivery availability', exact: true }).click();
    await expect(page.getByRole('button', { name: destination.id === office.id ? 'Place order · $180.00' : 'Place order · $175.00', exact: true })).toBeVisible();
    await expect(page.getByRole('checkbox')).not.toBeChecked();
  }
  expect(stale).toBe(0);
});
