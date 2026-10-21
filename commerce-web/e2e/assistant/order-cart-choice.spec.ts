import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const theme = JSON.parse(readFileSync(new URL('../../packages/api-client/src/theme-contract.json', import.meta.url), 'utf8')).default;
const id = '11111111-1111-4111-8111-111111111111';
const customer = { id, email: 'shopper@example.test', verified: true, primary_identifier: 'email' };
const address = { id, label: 'home', custom_label: '', latitude: 30.03, longitude: 31.47, formatted_address: '24 Garden Street', building: '24', floor: '2', apartment: '5', delivery_instructions: 'Ring the doorbell', is_default: true, updated_at: '2026-09-30T10:00:00Z', geography: { country_code: 'EG', state_code: '11', state_name: 'Cairo', city_id: '7799991', city_name: 'New Cairo' }, location_method: 'neighborhood' };
const product = { id, name: 'Bananas', sku: 'BAN-01', price: '3.00', currency: 'USD', unit: 'each', in_stock: true, media_ids: [], active: true, product_type: 'simple', attributes: {} };
const item = { product_id: id, name: product.name, sku: product.sku, price: '3.00', currency: 'USD', unit: 'each', quantity: 2, reserved_quantity: 2, available: 10, line_total: '6.00', discount_amount: '0', discount_snapshot: [] };
const requested = ['banans', 'apples', 'baladi'];
const products = requested.map((name, index) => ({ ...product, id: `22222222-2222-4222-8222-22222222222${index}`, name: index === 0 ? 'Bananas' : name, sku: `SKU-${index}` }));
const quantities = [2, 3, 2];
for (const policy of ['keep', 'clear', 'failed', 'changed'] as const) test(`multi-product order with existing cart: ${policy}`, async ({ page }, info) => {
 let items = [{ ...item, name: 'Existing milk' }];
 const removed: string[] = [], additions: number[] = [];

 const cart = () => ({ id, items, subtotal: '6.00', currency: 'USD', fully_reserved: true, discount_amount: '0', discount_snapshot: [] });
 await page.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  if (path.includes('/theme/')) return route.fulfill({ json: { configuration: theme, cities: [] } });
  if (path.endsWith('/auth/refresh')) return route.fulfill({ json: { customer, access_token: 'fixture' } });
  if (path.endsWith('/customer/me')) return route.fulfill({ json: customer });
  if (path.endsWith('/customer/locations')) return route.fulfill({ json: [address] });
  if (path.endsWith('/cart')) {
   return route.fulfill({ json: cart() });
  }
  if (path.includes('/cart/items/') && route.request().method() === 'DELETE') {
   removed.push(path.split('/').at(-1)!);
   if (policy === 'failed') return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
   items = items.filter(value => value.product_id !== removed.at(-1));
   return route.fulfill({ json: cart() });
  }
  if (path.includes('/inventory/')) return route.fulfill({ json: { available: 10 } });
  if (path.includes('/cart/items/') && route.request().method() === 'PUT') {
   const index = products.findIndex(p => path.endsWith(p.id));
   expect(index).toBeGreaterThanOrEqual(0);
   expect(route.request().postDataJSON()).toEqual({ quantity: quantities[index] });
   additions.push(index);
   items.push({ ...item, product_id: products[index].id, name: products[index].name, quantity: quantities[index] });
   return route.fulfill({ json: cart() });
  }
  if (path.endsWith('/search')) {
   const q = new URL(route.request().url()).searchParams.get('q');
   return route.fulfill({ json: { hits: [products[requested.indexOf(q ?? '')] ?? products[0]], total: 1, facets: {} } });
  }
  if (path.includes('/catalog/products/')) return route.fulfill({ json: products.find(p => path.endsWith(p.id)) ?? product });
  if (path.includes('/delivery-area')) return route.fulfill({ json: { configured: false, deliverable: true } });
  if (path.endsWith('/assistant/chat')) {
   const input = route.request().postDataJSON();
   expect(input.product_id).toBeUndefined();
   const events = [{ type: 'content.blocks', blocks: requested.map((query, index) => ({ kind: 'product_prompt', product_prompt: { query, quantity: quantities[index], action: 'cart' } })) }];
   return route.fulfill({ contentType: 'text/event-stream', body: [...events, { type: 'done' }].map((event, sequence) => `data: ${JSON.stringify({ version: '1', request_id: input.request_id, sequence, ...event })}\n\n`).join('') });
  }
  return route.fulfill({ json: [] });
 });
 await page.goto('/assistant');
 await page.getByPlaceholder('Ask about an order, or tell us what you need…').fill('please create order 2 banans 3 apples 2 baladi');
 await page.getByRole('button', { name: 'Send message', exact: true }).click();
 const guides = page.locator('.assistant-order-product');
 const decision = page.getByRole('article', { name: 'Choose what to do with your cart', exact: true });
 await expect(decision.getByText('2 × Existing milk', { exact: true })).toBeVisible();
 await expect(guides).toHaveCount(0);
 expect(additions).toEqual([]); expect(removed).toEqual([]);
 if (policy === 'changed') items = [{ ...items[0], quantity: 4 }];
 await decision.getByRole('button', { name: policy === 'keep' ? 'Keep current cart and add products' : 'Clear cart and start this order', exact: true }).click();
 if (policy === 'failed' || policy === 'changed') {
  await expect(decision.getByRole('alert')).toContainText('Could not finish clearing');
  await expect(guides).toHaveCount(0);
  expect(additions).toEqual([]);
  expect(removed).toHaveLength(policy === 'failed' ? 1 : 0);
  return;
 }
 const plan = page.getByRole('region', { name: 'Plan your order', exact: true });
 await expect(guides).toHaveCount(3);
 for (let index = 0; index < 3; index++) {
  await expect(plan.getByRole('spinbutton', { name: `Quantity for product ${index + 1}`, exact: true })).toHaveValue(String(quantities[index]));
 }
 expect(additions).toEqual([]);
 if (policy === 'keep') {
  await plan.getByRole('textbox', {name:'Search product 1', exact:true}).fill('bananas');
  await expect(plan.getByText('Select Find products to update the matching cards.', {exact:true})).toBeVisible();
  await expect(guides.first().getByRole('button', {name:'Add 2 to cart', exact:true})).toBeDisabled();
  await plan.getByRole('button', {name:'Find products', exact:true}).click();
  await expect(guides.first().getByText('For “bananas” · 2 requested', {exact:true})).toBeVisible();
 }
 await plan.screenshot({path:info.outputPath('unified-order-builder.png')});
 for (let index = 0; index < 3; index++) {
  await guides.nth(index).getByRole('button', { name: `Add ${quantities[index]} to cart`, exact: true }).click();
  await expect.poll(() => additions.length).toBe(index + 1);
  if (policy === 'keep' && index === 0) {
   await plan.getByRole('textbox', {name:'Search product 2', exact:true}).fill('apples ');
   await plan.getByRole('button', {name:'Find products', exact:true}).click();
   await expect(guides.first().getByRole('button', {name:'Add 2 to cart', exact:true})).toBeEnabled();
   expect(items.find(value => value.product_id === products[0].id)?.quantity).toBe(2);
   expect(additions).toEqual([0]);
   await expect(guides).toHaveCount(3);
  }

 }
 expect(removed).toEqual(policy === 'clear' ? [id] : []);
 expect(items.map(value => [value.name, value.quantity])).toEqual([...(policy === 'keep' ? [['Existing milk', 2]] : []), ['Bananas', 2], ['apples', 3], ['baladi', 2]]);
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
