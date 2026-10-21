import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const theme = JSON.parse(readFileSync(new URL('../../packages/api-client/src/theme-contract.json', import.meta.url), 'utf8')).default;
const id = '11111111-1111-4111-8111-111111111111';
const customer = { id, email: 'shopper@example.test', verified: true, primary_identifier: 'email' };
const address = { id, label: 'home', custom_label: '', latitude: 30.03, longitude: 31.47, formatted_address: '24 Garden Street', building: '24', floor: '2', apartment: '5', delivery_instructions: 'Ring the doorbell', is_default: true, updated_at: '2026-09-30T10:00:00Z', geography: { country_code: 'EG', state_code: '11', state_name: 'Cairo', city_id: '7799991', city_name: 'New Cairo' }, location_method: 'neighborhood' };
const product = { id, name: 'Bananas', sku: 'BAN-01', price: '3.00', currency: 'USD', unit: 'each', in_stock: true, media_ids: [], active: true, product_type: 'simple', attributes: {} };
const item = { product_id: id, name: product.name, sku: product.sku, price: '3.00', currency: 'USD', unit: 'each', quantity: 2, reserved_quantity: 2, available: 10, line_total: '6.00', discount_amount: '0', discount_snapshot: [] };
const controls: string = 'buttons';
for (const preselected of [false, true]) test(`address conversation with preselected address: ${preselected}`, async ({ page }, info) => {
 if (controls === 'expired') await page.clock.install();
 let added = true;
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
   if (input.order_id) {
    expect(input.order_id).toBe(id);
    expect(input.message).toBe('Show my order details');
    return route.fulfill({contentType:'text/event-stream', body:[{type:'message.delta',text:'Your order is being prepared.'},{type:'done'}].map((event,sequence)=>`data: ${JSON.stringify({version:'1',request_id:input.request_id,sequence,...event})}\n\n`).join('')});
   }
   let events;
   if (input.product_id) {
    expect(input.product_id).toBe(id); expect(input.message).toBe('Add 2 of this to my cart'); added = true;
    events = [{ type: 'message.delta', text: 'Added 2 bananas. [Continue to checkout](/checkout)' }];
   } else if (input.message === 'Show shopping suggestions') {
    events = [{type:'message.delta',text:Array.from({length:30}, (_,i)=>`Shopping suggestion ${i + 1}: Fresh fruit, vegetables and pantry essentials.`).join('\n\n')}];
   } else {
    expect(input.message).toBe('create order 2 bananas');
    events = [{ type: 'content.blocks', blocks: [{ kind: 'product_prompt', product_prompt: { query: 'bananas', quantity: 2, action: 'cart' } }] }];
   }
   return route.fulfill({ contentType: 'text/event-stream', body: [...events, { type: 'done' }].map((event, sequence) => `data: ${JSON.stringify({ version: '1', request_id: input.request_id, sequence, ...event })}\n\n`).join('') });
  }
  return route.fulfill({ json: [] });
 });
 if (preselected) await page.addInitScript(({id}) => sessionStorage.setItem(`commerce-active-location:${id}`, id), {id});
 await page.goto('/assistant');
 await reply('Show shopping suggestions');
 await expect(page.getByText('Shopping suggestion 30:', {exact:false})).toBeVisible();
 await reply('create order');
 const checkout = page.getByRole('region', { name: 'Checkout conversation', exact: true });
 await expect(checkout).toBeVisible();
 const expectFullHeightWorkspace = async () => {
  await expect.poll(() => page.evaluate(() => {
   const shell = document.querySelector('.assistant-store-shell')!;
   const rect = document.querySelector('.assistant-page')!.getBoundingClientRect();
   return {top:Math.round(rect.top),bottomGap:Math.round(innerHeight - rect.bottom),shellScrollTop:shell.scrollTop,pageScrollY:scrollY,bottomCovered:!!document.elementFromPoint(innerWidth / 2, innerHeight - 2)?.closest('.assistant-page')};
  })).toEqual({top:0,bottomGap:0,shellScrollTop:0,pageScrollY:0,bottomCovered:true});
 };
 await expectFullHeightWorkspace();
 const viewport = page.viewportSize()!;
 await page.setViewportSize({...viewport,height:viewport.height + 80});
 await expectFullHeightWorkspace();
 await page.setViewportSize(viewport);
 await expectFullHeightWorkspace();

 if (!preselected) {
 await expect(checkout.getByRole('heading', { name: 'Where should we deliver your order?', exact: true })).toBeVisible();
 await checkout.getByRole('heading', {name:'Where should we deliver your order?',exact:true}).scrollIntoViewIfNeeded();
 await expectFullHeightWorkspace();
 await page.screenshot({path:info.outputPath('checkout-workspace.png'),animations:'disabled'});
 await expect(checkout.getByText('Cash on delivery', { exact: true })).toHaveCount(0);
 expect(submissions).toHaveLength(0);
 await checkout.screenshot({ path: info.outputPath('delivery-step.png'), animations: 'disabled' });

 await expect(checkout.getByRole('navigation', {name:'Checkout progress'})).toHaveCount(0);
 await expect(checkout.getByText('Choose a saved address or add a new one.', {exact:false})).toHaveCount(0);
 const frame = checkout.locator('.checkout-address-message');
 await expect(frame).toHaveCSS('border-top-width', '0px');
 await expect(frame.getByRole('heading', {name:'Where should we deliver your order?'})).toBeVisible();
 const confirm = frame.getByRole('button', {name:'Use this address',exact:true});
 const frameBounds = await frame.boundingBox(), buttonBounds = await confirm.boundingBox();
 expect(buttonBounds!.width).toBeLessThan(frameBounds!.width * .8);
 expect(buttonBounds!.x + buttonBounds!.width).toBeGreaterThan(frameBounds!.x + frameBounds!.width * .8);
 await confirm.click();
 } else {
 await expect(checkout.getByRole('heading', {name:/^Deliver to home/i})).toBeVisible();
 await expect(checkout.getByRole('heading', {name:'Where should we deliver your order?'})).toHaveCount(0);
 }
 const receipt = checkout.getByRole('region', {name:'Selected address',exact:true});
 await expect(receipt).toContainText('24 Garden Street');
 await expect(receipt).not.toHaveClass(/checkout-chat-customer/);
 const next = checkout.getByLabel('Delivery options response', {exact:true});
 await expect(next.getByRole('heading', {name:'How would you like your delivery?'})).toHaveCount(0);
 await expect(checkout.getByText('Order updates:', {exact:false})).toHaveCount(0);
 await expect(receipt).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
 if (info.project.name === 'desktop') {
  const summary = receipt.locator('.checkout-address-summary');
  // Read all positions in one frame: the containing reply may still animate,
  // so separate boundingBox calls can compare different animation positions.
  const positions = await summary.evaluate(element => ['strong', 'span', 'small'].map(selector => element.querySelector(selector)!.getBoundingClientRect().y));
  expect(Math.abs(positions[0] - positions[1])).toBeLessThan(3);
  expect(Math.abs(positions[0] - positions[2])).toBeLessThan(5);
 }
 await expect(next.getByText('Rocento assistant', {exact:true})).toBeVisible();
 await expect(next.getByRole('region', {name:'Selected address'})).toContainText('24 Garden Street');
 await expect(next.getByText('Review your delivery options, then continue to payment.', {exact:true})).toHaveCount(0);
 if (preselected) {
 await receipt.getByRole('button', {name:'Change',exact:true}).click();
 await expect(checkout.getByRole('heading', {name:'Where should we deliver your order?'})).toBeVisible();
 await checkout.getByRole('button', {name:'Use this address',exact:true}).click();
 }
 expect(submissions).toHaveLength(0);
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await checkout.screenshot({path:info.outputPath('address-conversation.png'), animations:'disabled'});
 await next.getByRole('button', {name:'Continue to payment',exact:true}).click();
 await expect(checkout.getByRole('heading', {name:'How would you like to pay?',exact:true})).toBeVisible();
 await expectFullHeightWorkspace();
 expect(submissions).toHaveLength(0);
 await checkout.getByRole('button', {name:'Continue to review',exact:true}).click();
 const review = checkout.locator('.checkout-chat-review');
 await expect(review.getByRole('heading', {name:'Review your order',exact:true})).toBeVisible();
 await expect(review).toHaveCSS('border-top-width', '0px');
 const place = review.getByRole('button', {name:/^Place order/});
 await expect(place).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
 const reviewBounds = await review.boundingBox(), checkoutBounds = await checkout.boundingBox();
 expect(reviewBounds!.width).toBeCloseTo(checkoutBounds!.width, 0);
 const columns = await review.locator('.checkout-product-list').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
 expect(columns).toBe(info.project.name === 'desktop' ? 2 : 1);
 await checkout.screenshot({path:info.outputPath('review-step.png'), animations:'disabled'});
 expect(submissions).toHaveLength(0);
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await place.click();
 await checkout.getByRole('button', {name:'View order',exact:true}).click();
 await expect(page.getByText('Your order is being prepared.', {exact:true})).toBeVisible();
 await expect(page).toHaveURL(/\/assistant$/);
 expect(submissions).toHaveLength(1);
 expect(errors).toEqual([]);
});
