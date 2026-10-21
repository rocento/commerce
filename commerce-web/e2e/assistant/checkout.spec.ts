import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const theme = JSON.parse(readFileSync(new URL('../../packages/api-client/src/theme-contract.json', import.meta.url), 'utf8')).default;
const id = '11111111-1111-4111-8111-111111111111';
const customer = { id, email: 'shopper@example.test', verified: true, primary_identifier: 'email' };
const address = { id, label: 'home', custom_label: '', latitude: 30.03, longitude: 31.47, formatted_address: '24 Garden Street', building: '24', floor: '2', apartment: '5', delivery_instructions: 'Ring the doorbell', is_default: true, updated_at: '2026-09-30T10:00:00Z', geography: { country_code: 'EG', state_code: '11', state_name: 'Cairo', city_id: '7799991', city_name: 'New Cairo' }, location_method: 'neighborhood' };
const product = { id, name: 'Bananas', sku: 'BAN-01', price: '3.00', currency: 'USD', unit: 'each', in_stock: true, media_ids: [], active: true, product_type: 'simple', attributes: {} };
const item = { product_id: id, name: product.name, sku: product.sku, price: '3.00', currency: 'USD', unit: 'each', quantity: 2, reserved_quantity: 2, available: 10, line_total: '6.00', discount_amount: '0', discount_snapshot: [] };
for (const controls of ['buttons', 'replies', 'expired', 'retry'] as const) test(`complete a product order using ${controls} with explicit payment confirmation`, async ({ page }, info) => {
 if (controls === 'expired') await page.clock.install();
 let added = false;
 let cartWrites = 0;
 const reply = async (text: string) => {
  await page.getByPlaceholder('Ask about an order, or tell us what you need…').fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
 };
 const submissions: unknown[] = [], errors: string[] = [];
 page.on('pageerror', error => errors.push(error.message));
 const cart = () => ({ id, items: added ? [item] : [], subtotal: added ? '6.00' : '0.00', currency: 'USD', fully_reserved: true, discount_amount: '0', discount_snapshot: [], coupon_code: null });
 await page.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  if (path.includes('/theme/')) return route.fulfill({ json: { configuration: theme, cities: [] } });
  if (path.endsWith('/auth/refresh')) return route.fulfill({ json: { customer, access_token: 'fixture' } });
  if (path.endsWith('/customer/me')) return route.fulfill({ json: customer });
  if (path.endsWith('/customer/locations')) return route.fulfill({ json: [address] });
  if (path.includes('/inventory/')) return route.fulfill({json:{available:10}});
  if (path.endsWith(`/cart/items/${id}`) && route.request().method() === 'PUT') {
   expect(route.request().postDataJSON()).toEqual({quantity:2});
   cartWrites++; added = true; return route.fulfill({json:cart()});
  }
  if (path.endsWith('/cart')) return route.fulfill({ json: cart() });
  if (path.endsWith('/search')) return route.fulfill({ json: { hits: [product], total: 1, facets: {} } });
  if (path.includes('/catalog/products/')) return route.fulfill({ json: product });
  if (path.includes('/delivery-area')) return route.fulfill({ json: { configured: false, deliverable: true } });
  if (path.endsWith('/fulfillment/availability')) return route.fulfill({ status: 404, json: { error: 'Legacy API' } });
  if (path.endsWith('/fulfillment/delivery-options')) return route.fulfill({ json: { enabled: false, slots: [] } });
  if (path.endsWith('/checkout/quote')) return route.fulfill({ json: { id, expires_at: new Date(Date.now() + 300000).toISOString(), snapshot: { items: [item], location: address, contact: customer, subtotal: '6.00', discount_amount: '0', discount_snapshot: [], delivery_fee: '5.00', tax_amount: '0.00', total: '11.00', currency: 'USD', payment_method: 'cod', gift_message: '' } } });
  if (path.endsWith('/checkout/place')) { submissions.push(route.request().postDataJSON()); if (controls === 'retry' && submissions.length === 1) return route.fulfill({status:503,json:{error:'Connection interrupted'}}); return route.fulfill({ json: { order: { id } } }); }
  if (path.endsWith('/assistant/chat')) {
   const input = route.request().postDataJSON();
   let events;
   if (input.product_id) {
    expect(input.product_id).toBe(id); expect(input.message).toBe('Add 2 of this to my cart'); added = true;
    events = [{ type: 'message.delta', text: 'Added 2 bananas. [Continue to checkout](/checkout)' }];
   } else {
    expect(input.message).toBe('create order 2 bananas');
    events = [{ type: 'content.blocks', blocks: [{ kind: 'product_prompt', product_prompt: { query: 'bananas', quantity: 2, action: 'cart' } }] }];
   }
   return route.fulfill({ contentType: 'text/event-stream', body: [...events, { type: 'done' }].map((event, sequence) => `data: ${JSON.stringify({ version: '1', request_id: input.request_id, sequence, ...event })}\n\n`).join('') });
  }
  return route.fulfill({ json: [] });
 });
 await page.goto('/assistant');
 await page.getByPlaceholder('Ask about an order, or tell us what you need…').fill('create order 2 bananas');
 await page.getByRole('button', { name: 'Send message', exact: true }).click();
 await expect(page.getByRole('spinbutton')).toHaveValue('2');
 await page.getByRole('button', { name: 'Add 2 to cart', exact: true }).click();
 await expect.poll(() => cartWrites).toBe(1);
 await page.getByRole('button', { name: 'Checkout', exact: true }).click();
 const checkout = page.getByRole('region', { name: 'Checkout conversation', exact: true });
 await expect(checkout).toBeVisible();
 await expect(checkout.getByRole('heading', { name: 'Where should we deliver your order?', exact: true })).toBeVisible();
 await expect(checkout.getByText('Cash on delivery', { exact: true })).toHaveCount(0);
 expect(submissions).toHaveLength(0);
 await checkout.screenshot({ path: info.outputPath('delivery-step.png') });
 if (controls !== 'buttons') {
  await reply('use my home address');
  await expect(page.getByText(/Selected 24 Garden Street/)).toBeVisible();
  await expect(checkout.getByRole('button', { name: 'Continue to payment', exact: true })).toBeEnabled();
  await reply('yes');
 } else {
  await checkout.getByRole('button', {name:'Use this address',exact:true}).click();
  await checkout.getByRole('button', {name:'Continue to payment',exact:true}).click();
 }
 await expect(checkout.getByRole('heading', {name:'How would you like to pay?', exact:true})).toBeVisible();
 await expect(checkout.getByRole('article', {name:'Confirmed delivery', exact:true})).toContainText('24 Garden Street');
 const place = checkout.getByRole('button', { name: 'Place order · $11.00', exact: true });
 await expect(place).toHaveCount(0); expect(submissions).toHaveLength(0);
 if (controls !== 'buttons') await reply('cash');
 else await checkout.getByRole('button', {name:'Continue to review', exact:true}).click();
 if (controls !== 'buttons') await reply('back');
 else await checkout.getByRole('button', { name: 'Change delivery', exact: true }).click();
 await expect(checkout.getByRole('heading', { name: 'Payment', exact: true })).toHaveCount(0);
 await checkout.getByRole('button', { name: 'Continue to payment', exact: true }).click();
 await expect(place).toHaveCount(0);
 await checkout.getByRole('button', {name:'Continue to review', exact:true}).click();
 await expect(checkout.getByRole('heading', {name:'Review your order', exact:true})).toBeVisible();
 await expect(checkout.getByRole('article', {name:'Confirmed payment', exact:true})).toContainText('Cash on delivery');
 await page.getByRole('button', { name: 'Pause checkout', exact: true }).click();
 await page.getByRole('button', { name: 'Resume checkout', exact: true }).click();
 await expect(place).toBeEnabled();
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await checkout.screenshot({ path: info.outputPath('checkout-in-conversation.png') });
 if (controls !== 'buttons') {
  await reply('confirm my order');
  expect(submissions).toHaveLength(0);
  await expect(place).toBeEnabled();
 }
 if (controls === 'expired') {
  await page.clock.fastForward(301000);
  await reply('cash');
  await expect(place).toBeDisabled();
  await expect(page.getByText(/The current total is not ready or has expired/)).toBeVisible();
  expect(submissions).toHaveLength(0);
  return;
 }
 await place.scrollIntoViewIfNeeded();
 await page.screenshot({ path: info.outputPath('payment-review.png') });
 await place.click();
 if (controls === 'retry') {
  await expect(checkout.getByRole('alert')).toContainText('Connection interrupted');
  await checkout.getByRole('button', {name:'Retry order confirmation', exact:true}).click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1]).toEqual(submissions[0]);
 }
 await expect(checkout.getByRole('heading', { name: 'Your order is confirmed' })).toBeVisible();
 expect(submissions).toHaveLength(controls === 'retry' ? 2 : 1); expect(submissions[0]).toMatchObject({ quote_id: id });
 await expect(page).toHaveURL(/\/assistant$/); expect(errors).toEqual([]);
});
