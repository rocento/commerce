import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const theme = JSON.parse(readFileSync(new URL('../../packages/api-client/src/theme-contract.json', import.meta.url), 'utf8')).default;
const id = '11111111-1111-4111-8111-111111111111';
const customer = { id, email: 'shopper@example.test', verified: true, primary_identifier: 'email' };
const address = { id, label: 'home', custom_label: '', latitude: 30.03, longitude: 31.47, formatted_address: '24 Garden Street', building: '24', floor: '2', apartment: '5', delivery_instructions: 'Ring the doorbell', is_default: true, updated_at: '2026-09-30T10:00:00Z', geography: { country_code: 'EG', state_code: '11', state_name: 'Cairo', city_id: '7799991', city_name: 'New Cairo' }, location_method: 'neighborhood' };
const product = { id, name: 'Bananas', sku: 'BAN-01', price: '3.00', currency: 'USD', unit: 'each', in_stock: true, media_ids: [], active: true, product_type: 'simple', attributes: {} };
const item = { product_id: id, name: product.name, sku: product.sku, price: '3.00', currency: 'USD', unit: 'each', quantity: 2, reserved_quantity: 2, available: 10, line_total: '6.00', discount_amount: '0', discount_snapshot: [] };

for (const mode of ['local', 'rag', 'engine', 'text-only', 'error', 'interrupted'] as const) {
 test(`checkout handoff: ${mode}`, async ({ page }) => {
  let chatCalls = 0;
  const submissions: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
   const path = new URL(route.request().url()).pathname;
   if (path.includes('/theme/')) return route.fulfill({json: {configuration: theme, cities: []}});
   if (path.endsWith('/auth/refresh')) return route.fulfill({json: {customer, access_token: 'fixture'}});
   if (path.endsWith('/customer/me')) return route.fulfill({json: customer});
   if (path.endsWith('/customer/locations')) return route.fulfill({json: [address]});
   if (path.includes('/catalog/products/')) return route.fulfill({json: product});
   if (path.endsWith('/cart')) return route.fulfill({json: {id, items: [item], subtotal: '6.00', currency: 'USD', fully_reserved: true, discount_amount: '0', discount_snapshot: [], coupon_code: null}});
   if (path.includes('/delivery-area')) return route.fulfill({json: {configured: false, deliverable: true}});
   if (path.endsWith('/fulfillment/availability')) return route.fulfill({status: 404, json: {error: 'Legacy API'}});
   if (path.endsWith('/fulfillment/delivery-options')) return route.fulfill({json: {enabled: false, slots: []}});
   if (path.endsWith('/checkout/quote')) return route.fulfill({json: {id, expires_at: new Date(Date.now() + 300000).toISOString(), snapshot: {items: [item], location: address, contact: customer, subtotal: '6.00', discount_amount: '0', discount_snapshot: [], delivery_fee: '5.00', tax_amount: '0.00', total: '11.00', currency: 'USD', payment_method: 'cod', gift_message: ''}}});
   if (path.endsWith('/checkout/place') || (path.endsWith('/cart/items') && route.request().method() !== 'GET')) {
    submissions.push(path);
    return route.fulfill({status: 500, json: {error: 'Unexpected write'}});
   }
   if (path.endsWith('/assistant/chat')) {
    chatCalls++;
    const input = route.request().postDataJSON();
    expect(input.message).toBe('pleas checkout');
    const events: Record<string, unknown>[] = [{type: 'message.delta', text: '[Continue to checkout](/checkout) to confirm delivery, payment and place your order.', ...(mode === 'text-only' ? {} : {code: 'open_checkout'})}];
    if (mode === 'error') events.push({type: 'error', code: 'unavailable', text: 'Checkout is unavailable.'});
    if (mode !== 'interrupted') events.push({type: 'done'});
    return route.fulfill({contentType: 'text/event-stream', body: events.map((event, sequence) => `data: ${JSON.stringify({version: '1', request_id: input.request_id, sequence, response_source: mode === 'engine' ? 'R' : 'L', ...event})}\n\n`).join('')});
   }
   return route.fulfill({json: []});
  });
  await page.addInitScript(({id}) => sessionStorage.setItem(`commerce-active-location:${id}`, id), {id});
  await page.goto('/assistant');
  await expect(page.getByRole('button', {name: 'Send message', exact: true})).toBeVisible();
  const message = mode === 'local' ? 'please checkout' : 'pleas checkout';
  await page.getByPlaceholder('Ask about an order, or tell us what you need…').fill(message);
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  const checkout = page.getByRole('region', {name: 'Checkout conversation', exact: true});
  if (mode === 'local' || mode === 'rag' || mode === 'engine') {
   await expect(checkout).toBeVisible();
   await expect(checkout.getByRole('heading', {name: 'Delivery method', exact: true})).toBeVisible();
   await expect(checkout.getByRole('button', {name: 'Continue to payment', exact: true})).toBeEnabled();
   await expect(page.getByText(message, {exact: true})).toHaveCount(1);
   await page.getByRole('button', {name: 'Pause checkout', exact: true}).click();
   await expect(checkout).toBeHidden();
  } else {
   await expect(page.getByRole('button', {name: 'Continue to checkout', exact: true})).toBeVisible();
   await expect(page.getByRole('button', {name: 'Send message', exact: true})).toBeDisabled();
   await expect(page.getByRole('button', {name: 'Stop response', exact: true})).toHaveCount(0);
   await expect(checkout).toBeHidden();
  }
  expect(chatCalls).toBe(mode === 'local' ? 0 : 1);
  expect(submissions).toEqual([]);
  expect(errors).toEqual([]);
 });
}
