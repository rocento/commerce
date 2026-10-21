import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const theme = JSON.parse(readFileSync(new URL('../../packages/api-client/src/theme-contract.json', import.meta.url), 'utf8')).default;
const id = '00000000-0000-4000-8000-000000000006';
const customer = { id, email: 'shopper@example.test', verified: true, created_at: '2026-09-15T12:00:00Z' };
const product = { id, name: 'Red apples', price: '3.00', currency: 'USD', unit: 'each', in_stock: true, media_ids: [] };
const order = { id, number: 106, status: 'shipped', total: '11.00', currency: 'USD', created_at: '2026-09-15T12:00:00Z' };

async function reply(route: import('@playwright/test').Route, events: unknown[]) {
  const input = route.request().postDataJSON();
  await route.fulfill({ contentType: 'text/event-stream', body: [...events, { type: 'done' }].map((event, sequence) => `data: ${JSON.stringify({ version: '1', request_id: input.request_id, sequence, ...(event as object) })}\n\n`).join('') });
}
async function browse(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/assistant/chat', route => reply(route, [{ type: 'content.blocks', blocks: [{ kind: 'product_list', title: 'Matching products', sources: [{kind: 'catalog', product_id: id, route: `/products/${id}`}], products: [{ id, name: product.name, price: product.price, currency: product.currency, in_stock: true, image_id: null, route: `/products/${id}`, attributes: [], reasons: [], unmet: [] }] }] }]));
  await page.getByRole('textbox', { name: 'Your message' }).fill('Show me apples');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
  await page.route('**/api/v1/theme/*', route => route.fulfill({ json: { configuration: theme, cities: [] } }));
  await page.route('**/api/v1/customer/auth/refresh', route => route.fulfill({ json: { access_token: 'fixture', customer } }));
  await page.route('**/api/v1/customer/me', route => route.fulfill({ json: customer }));
  await page.route('**/api/v1/delivery-area*', route => route.fulfill({ json: { configured: false, deliverable: true } }));
  await page.route('**/api/v1/search?*', route => route.fulfill({ json: { hits: [product], total: 1, offset: 0, limit: 20, facets: {} } }));
  await page.route(`**/api/v1/catalog/products/${id}`, route => route.fulfill({ json: { ...product, attributes: {}, description: 'Fresh apples' } }));
  await page.route('**/api/v1/inventory/*', route => route.fulfill({ json: { available: 10 } }));
  await page.route('**/api/v1/cart', route => route.fulfill({ json: { id, items: [], subtotal: '0.00', currency: 'USD' } }));
  await page.route('**/api/v1/customer/orders?*', route => route.fulfill({ json: [order] }));
});

test('assistant adds a catalog item from chat and updates the cart count', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      if (this.classList.contains('assistant-cart-flight')) {
        document.documentElement.dataset.cartFlights = String(Number(document.documentElement.dataset.cartFlights ?? 0) + 1);
      }
      return animate.apply(this, args);
    };
  });
  let update: unknown;
  let quantity = 0;
  // Missing image metadata must not crash the inline quantity controls.
  await page.route(`**/api/v1/catalog/products/${id}`, route => route.fulfill({ json: { ...product, media_ids: undefined } }));
  const cart = () => ({ id, items: quantity ? [{ product_id: id, name: product.name, price: product.price, currency: product.currency, quantity, reserved_quantity: quantity }] : [], subtotal: '6.00', currency: 'USD' });
  await page.route('**/api/v1/cart', route => route.fulfill({ json: cart() }));
  await page.route(`**/api/v1/cart/items/${id}`, async route => {
    update = route.request().postDataJSON();
    quantity = route.request().postDataJSON().quantity;
    await route.fulfill({ json: cart() });
  });
  await page.goto('/assistant');
  await browse(page);
  await page.getByRole('button', { name: 'Add Red apples to cart' }).click();
  await expect.poll(() => quantity).toBe(1);
  expect(update).toEqual({ quantity: 1 });
  await expect(page.getByRole('button', { name: 'Cart 1', exact: true })).toBeVisible();
  const confirmation = page.getByRole('group', { name: 'Cart quantity for Red apples' });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole('status', { name: 'Quantity in cart' })).toHaveText('1');
  await expect(page.locator('html')).not.toHaveAttribute('data-cart-flights', /[1-9]/);
  await expect(confirmation.getByRole('status', { name: 'Quantity in cart' })).toHaveText('1');
  await page.getByRole('button', { name: 'Increase quantity', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cart 2', exact: true })).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-cart-flights', /[1-9]/);
  await expect.poll(() => quantity).toBe(2);
  await expect(confirmation.getByRole('status', { name: 'Quantity in cart' })).toHaveText('2');
  expect(errors).toEqual([]);
  await expect(page).toHaveURL(/\/assistant$/);
  await expect(page.locator('.assistant-brand, .assistant-mobile-brand')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('catalog-cart.png'), animations: 'disabled' });
});

test('assistant updates inline cart quantity without animation when reduced motion is enabled', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let quantity = 0;
  const cart = () => ({ id, items: quantity ? [{ product_id: id, name: product.name, quantity, reserved_quantity: quantity }] : [], subtotal: '3.00', currency: 'USD' });
  await page.route('**/api/v1/cart', route => route.fulfill({ json: cart() }));
  await page.route(`**/api/v1/cart/items/${id}`, async route => {
    quantity = route.request().postDataJSON().quantity;
    await route.fulfill({ json: cart() });
  });
  await page.goto('/assistant');
  await browse(page);
  await expect(page.getByRole('group', { name: 'Cart quantity for Red apples' }).getByRole('status', {name:'Quantity in cart'})).toHaveText('0');
  await page.getByRole('button', { name: 'Add Red apples to cart' }).click();
  const confirmation = page.getByRole('group', { name: 'Cart quantity for Red apples' });
  await expect.poll(() => quantity).toBe(1);
  await expect(confirmation.getByRole('status', { name: 'Quantity in cart' })).toHaveText('1');
  await expect(confirmation).toBeVisible();
  await expect(page.locator('.assistant-cart-flight')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('assistant does not confirm a failed cart addition', async ({ page }) => {
  await page.route(`**/api/v1/cart/items/${id}`, route => route.fulfill({ status: 409, json: { error: 'Not enough stock' } }));
  await page.goto('/assistant');
  await browse(page);
  await page.getByRole('button', { name: 'Add Red apples to cart' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cart 0', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Cart quantity for Red apples' }).getByRole('status', {name:'Quantity in cart'})).toHaveText('0');
});

test('order shortcut displays orders and verified tracking inside chat', async ({ page }, info) => {
  let chatRequests = 0;
  let detailRequests = 0;
  await page.route(`**/api/v1/customer/orders/${id}`, async route => {
    detailRequests++;
    if (detailRequests === 1) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
    await route.fulfill({ json: {
      order: { ...order, location: { formatted_address: '12 Garden Street, Alexandria', building: '12', floor: '2', apartment: '4', delivery_instructions: 'Ring the bell' } },
      items: [{ product_id: id, name: 'Red apples', quantity: 2, price: '3.00', line_total: '6.00', discount_amount: '0.00' }],
      shipments: [{ shipment: { id, status: 'shipped', method: 'delivery', tracking_reference: 'TRACK-106' } }],
      fulfillment_plan: null,
    } });
  });
  await page.route('**/api/v1/assistant/chat', async route => {
    const input = route.request().postDataJSON();
    chatRequests++;
    const events = [
      { type: 'card.order', order: { ...order, created_at: undefined, subtotal: '6.00', discount_amount: '0.00', tax_amount: '0.00', delivery_fee: '5.00', cancellation_available: false, shipments: [{ status: 'shipped', tracking_reference: 'TRACK-106' }] } },
      { type: 'message.delta', text: 'Your order has shipped.' },
      { type: 'done' },
    ];
    await route.fulfill({ contentType: 'text/event-stream', body: events.map((event, sequence) => `data: ${JSON.stringify({ version: '1', request_id: input.request_id, sequence, ...event })}\n\n`).join('') });
  });
  await page.goto('/assistant');
  await page.getByRole('textbox', { name: 'Your message' }).fill('Where is my order #106?');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Shipment: shipped · Tracking: TRACK-106')).toBeHidden();
  const breakdown = page.locator('.assistant-order-card dl');
  await expect(breakdown).toBeHidden();
  const detailsButton = page.getByRole('button', { name: 'View details for order #106 in chat' });
  await expect(detailsButton).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await detailsButton.click();
  await expect(breakdown).toBeVisible();
  const details = page.getByRole('region', { name: 'Details for order #106' });
  await expect(details.getByRole('alert')).toContainText('couldn’t load');
  await details.getByRole('button', { name: 'Try again' }).click();
  await expect(details.getByText('Red apples', { exact: true })).toBeVisible();
  await expect(details).toContainText('2 × 3.00 USD');
  await expect(details).toContainText('12 Garden Street, Alexandria');
  await expect(details).toContainText('Ring the bell');
  await expect(details).toContainText('TRACK-106');
  expect(chatRequests).toBe(1);
  await expect(page.getByRole('button', { name: 'Hide details for order #106 in chat' })).toHaveAttribute('aria-expanded', 'true');
  await expect(page).toHaveURL(/\/assistant$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('order-tracking.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Hide details for order #106 in chat' }).click();
  await expect(details).toBeHidden();
  await expect(breakdown).toBeHidden();
});

test('guests get an in-chat sign-in prompt without requesting private orders', async ({ page }) => {
  let orderRequests = 0;
  await page.route('**/api/v1/customer/auth/refresh', route => route.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
  await page.route('**/api/v1/customer/orders?*', route => { orderRequests++; return route.fulfill({ json: [] }); });
  await page.route('**/api/v1/assistant/chat', route => reply(route, [{ type: 'message.delta', text: 'Sign in to view your orders.' }]));
  await page.goto('/assistant');
  await page.getByRole('button', { name: 'Orders', exact: true }).click();
  await expect(page.getByText('Sign in to view your orders.', { exact: true })).toBeVisible();
  expect(orderRequests).toBe(0);
  await expect(page).toHaveURL(/\/assistant$/);
});

test('order shortcut response failures can be retried and empty orders stay in chat', async ({ page }) => {
  let fail = true;
  await page.route('**/api/v1/assistant/chat', route => {
    expect(route.request().postDataJSON().message).toBe('Show my orders');
    return fail ? route.fulfill({ status: 503, json: { error: 'Unavailable' } })
      : reply(route, [{ type: 'message.delta', text: 'You haven’t placed any orders yet.' }]);
  });
  await page.goto('/assistant');
  await expect(page.getByRole('textbox', { name: 'Your message' })).toBeVisible();
  await page.getByRole('button', { name: 'Orders', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Assistant request could not be completed');
  fail = false;
  await page.getByRole('button', { name: 'Retry response', exact: true }).click();
  await expect(page.getByText('You haven’t placed any orders yet.')).toBeVisible();
  await expect(page).toHaveURL(/\/assistant$/);
});

test('wishlist removal requires an explicit click and a failed removal can be retried', async ({ page }) => {
  let saved = [id];
  let deletes = 0;
  await page.route('**/api/v1/customer/wishlist', route => route.fulfill({ json: saved }));
  await page.route(`**/api/v1/customer/wishlist/${id}`, async route => {
    expect(route.request().method()).toBe('DELETE');
    deletes++;
    if (deletes === 1) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
    saved = [];
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/v1/assistant/chat', async route => {
    const input = route.request().postDataJSON();
    expect(input.message).toBe('Show my wishlist');
    const events = [{ type: 'content.blocks', blocks: [{ kind: 'wishlist_manage', title: 'Saved products', sources: [{kind: 'catalog', product_id: id, route: `/products/${id}`}], products: [{ id, name: product.name, price: product.price, currency: product.currency, in_stock: true, image_id: null, route: `/products/${id}`, attributes: [], reasons: [], unmet: [] }] }] }, { type: 'done' }];
    await route.fulfill({ contentType: 'text/event-stream', body: events.map((event, sequence) => `data: ${JSON.stringify({ version: '1', request_id: input.request_id, sequence, ...event })}\n\n`).join('') });
  });
  await page.goto('/assistant');
  await page.getByRole('button', { name: 'Wishlist', exact: true }).click();
  const remove = page.getByRole('button', { name: 'Confirm removal of Red apples from wishlist', exact: true });
  await expect(remove).toBeEnabled();
  expect(deletes).toBe(0);
  await remove.click();
  await expect(page.getByRole('alert')).toContainText('That item could not be removed');
  expect(saved).toEqual([id]);
  await remove.click();
  await expect(page.getByRole('button', { name: 'Removed from wishlist', exact: true })).toBeDisabled();
  expect(deletes).toBe(2);
  expect(saved).toEqual([]);
  await expect(page).toHaveURL(/\/assistant$/);
});
