import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { components } from '../../packages/api-client/src/schema';

type Proposal = components['schemas']['BasketProposal'];
type Draft = Proposal['draft'];
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const theme = JSON.parse(readFileSync(new URL('../../packages/api-client/src/theme-contract.json', import.meta.url), 'utf8')).default;
const customer = { id: uuid(1), email: 'basket@example.test', mobile_number: null, primary_identifier: 'email', verified: true };
const address = { id: uuid(2), label: 'home', custom_label: '', latitude: 30, longitude: 31, formatted_address: 'Synthetic delivery address', is_default: true, updated_at: '2026-09-21T00:00:00Z', geography: null, location_method: 'map' };
const product: components['schemas']['Product'] = { id: uuid(3), entity_id: 3, name: 'Breakfast oats', sku: 'OATS', slug: 'oats', description: '', product_type: 'simple', parent_id: null, variant_attributes: {}, attribute_set_id: null, price: '6.00', currency: 'USD', unit: 'pack', category_id: uuid(4), attributes: { pack_size: '500g' }, media_ids: [], active: true, in_stock: true, updated_at: '2026-09-21T00:00:00Z' };
const goal: Draft['goal'] = { purpose: 'Breakfast basket', budget: '50', currency: 'USD', all_inclusive: true, budget_exclusive: false, people: 4, locked_products: [], excluded_products: [], locked_brands: [], allow_substitutions: true, delivery_date: null, assumptions: ['Two packs are suggested; serving sizes are not verified.'], unresolved: [], saving_target: null };
const totals = { subtotal: '12.00', discount: '0.00', merchandise_total: '12.00', tax: '0.00', delivery: '5.00', payable: '17.00', currency: 'USD', promotions: [] };

async function fixture(page: Page, mode: Draft['mode'], interrupt = false) {
  let proposal: Proposal | undefined;
  let writes = 0, placements = 0, requotes = 0;
  const original = { product_id: uuid(8), name: 'Original oats', sku: 'OLD', unit: 'pack', price: '10.00', currency: 'USD', quantity: 2, reserved_quantity: 2, available: 20, line_total: '20.00', discount_amount: '0', discount_snapshot: [] };
  let items = mode === 'optimize' ? [original] : [] as typeof original[];
  const cart = () => ({ id: uuid(5), customer_id: customer.id, items, subtotal: items.reduce((sum,i)=>sum+Number(i.line_total),0).toFixed(2), currency: 'USD', fully_reserved: true, discount_amount: '0.00', discount_snapshot: [], coupon_code: null, coupon_error: null });
  const context = () => ({ cart: cart(), source_revision: writes, task_revision: proposal?.draft.task_revision ?? 0, draft: proposal?.draft ?? null, cancelled: false, locations: [{ id: address.id, label: 'home', is_default: true }], proposal_id: proposal?.id ?? null, proposed_items: [], supported_payment_methods: ['cod'], delivery_slots_available: false });
  function create(input?: Draft): Proposal {
    const selection = { product_id: product.id, quantity: 2, replaces: mode === 'optimize' ? uuid(8) : null, required_attributes: {}, reason: 'Verified catalog pack size and current price.' };
    const draft: Draft = input ?? { task_id: uuid(6), task_revision: 0, source_revision: writes, mode, auto_select: false, goal, location_id: address.id, order_id: mode === 'buy_again' ? uuid(7) : null, selections: [selection] };
    if (!draft.selections.length && draft.auto_select) draft.selections = [selection];
    draft.task_revision++;
    const amount = draft.selections.reduce((sum,s)=>sum+s.quantity*6,0);
    return { id: uuid(100 + requotes), draft: { ...draft, auto_select: false }, expires_at: new Date(Date.now() + 300000).toISOString(), lines: draft.selections.map(s => ({ selection: s, product, previous: mode === 'optimize' ? { ...product, id: uuid(8), name: 'Original oats', price: '10.00' } : null, historical_price: mode === 'buy_again' ? '5.00' : null, available: 20 })), current_items: items.map(i => ({...i,variant_attributes:{}})), resulting_items: draft.selections.map(s => ({product_id:s.product_id,name:product.name,sku:product.sku,unit:product.unit,quantity:s.quantity,price:product.price,currency:product.currency,line_total:String(s.quantity*6),variant_attributes:{}})), before: { ...totals, subtotal: '20.00', merchandise_total: '20.00', payable: '25.00' }, after: { ...totals, subtotal: amount.toFixed(2), merchandise_total: amount.toFixed(2), payable: (amount+5).toFixed(2) }, savings: mode === 'optimize' ? '8.00' : null, issues: [], notes: ['Proposed basket only. No stock is reserved until you apply.'], can_apply: true, applied: false };
  }
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/theme/')) return route.fulfill({ json: { configuration: theme, cities: [] } });
    if (path.endsWith('/auth/refresh')) return route.fulfill({ json: { customer, access_token: 'synthetic' } });
    if (path.endsWith('/customer/me')) return route.fulfill({ json: customer });
    if (path.endsWith('/customer/locations')) return route.fulfill({ json: [address] });
    if (path.endsWith('/customer/orders')) return route.fulfill({ json: [{ id: uuid(7), number: 107, status: 'delivered', created_at: '2026-09-20T00:00:00Z', total: '10.00', currency: 'USD' }] });
    if (path.includes('/cart/shopping/')) return route.fulfill({ json: context() });
    if (path.endsWith('/assistant/chat')) {
      const input = route.request().postDataJSON();
      expect(input).not.toHaveProperty('shopping_mode');
      proposal = create();
      const events = [{ type: 'content.blocks', blocks: [{ kind: 'basket_proposal', proposal_id: proposal.id }] }, { type: 'done' }];
      return route.fulfill({ contentType: 'text/event-stream', body: events.map((event, sequence) => `data: ${JSON.stringify({ version: '1', request_id: input.request_id, sequence, ...event })}\n\n`).join('') });
    }
    if (path.endsWith('/cart/proposals')) { requotes++; proposal = create(route.request().postDataJSON()); return route.fulfill({ json: proposal }); }
    if (path.endsWith('/apply')) {
      expect(route.request().postDataJSON()).toEqual({ idempotency_key: proposal!.id });
      if (!proposal!.applied) { writes++; items = [{ ...original, product_id: product.id, name: product.name, price: '6.00', quantity: proposal!.draft.selections[0].quantity, line_total: proposal!.after.subtotal }]; proposal!.applied = true; }
      if (interrupt) { interrupt = false; return route.abort('connectionreset'); }
      return route.fulfill({ json: cart() });
    }
    if (path.includes('/cart/proposals/')) return route.fulfill({ json: proposal });
    if (path.endsWith('/cart')) return route.fulfill({ json: cart() });
    if (path.endsWith('/delivery-area')) return route.fulfill({ json: { configured: false, deliverable: true } });
    if (path.endsWith('/fulfillment/delivery-options')) return route.fulfill({ json: { enabled: false, slots: [] } });
    if (path.endsWith('/fulfillment/availability')) return route.fulfill({ status: 404, json: { error: 'Legacy checkout fixture' } });
    if (path.endsWith('/checkout/quote')) return route.fulfill({ json: { id: uuid(9), expires_at: new Date(Date.now() + 300000).toISOString(), snapshot: { items, location: address, contact: customer, subtotal: proposal!.after.subtotal, discount_amount: '0', discount_snapshot: [], delivery_fee: '5.00', tax_amount: '0.00', tax_snapshot: { name: 'Tax', amount: '0.00' }, total: proposal!.after.payable, currency: 'USD', payment_method: 'cod' } } });
    if (path.endsWith('/checkout/place')) { placements++; return route.fulfill({ status: 503, json: { error: 'Synthetic timeout' } }); }
    if (path.includes('/catalog/products/')) return route.fulfill({ json: product });
    return route.fulfill({ json: [] });
  });
  return { writes: () => writes, placements: () => placements, requotes: () => requotes };
}

for (const mode of ['shop', 'optimize', 'buy_again'] as const) test(`${mode}: review, edit, requote, approve, then trusted checkout`, async ({ page }, info) => {
  const state = await fixture(page, mode);
  await page.goto(`/assistant?shopping=${mode}&task=${uuid(6)}`);
  await expect(page).toHaveURL(/\/assistant$/);
  await expect(page.getByRole('navigation', { name: 'Shopping tools' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Shopping task', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Your message' }).fill('Build a breakfast basket for four');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Proposed basket', exact: true });
  await expect(panel).toBeVisible();
  expect(state.writes()).toBe(0); expect(state.placements()).toBe(0);
  if (mode === 'optimize') {
    await expect(page.getByRole('spinbutton', { name: 'Proposed quantity for Breakfast oats' })).toBeDisabled();
    const checkbox = panel.getByRole('checkbox', { name: 'Accept replacement' });
    await checkbox.uncheck(); await checkbox.check();
  } else await panel.getByRole('spinbutton', { name: 'Proposed quantity for Breakfast oats' }).fill('3');
  await expect(panel.getByRole('button', { name: 'Approve and apply to cart' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Requote selected changes' }).click();
  await expect(panel.getByRole('button', { name: 'Approve and apply to cart' })).toBeEnabled();
  expect(state.requotes()).toBeGreaterThan(0);
  await panel.getByRole('heading', { level: 3 }).scrollIntoViewIfNeeded();
  await expect(panel.getByRole('heading', { level: 3 })).toBeInViewport();
  const intro = await panel.locator('header > p').boundingBox();
  const controls = await panel.locator('fieldset').boundingBox();
  expect(controls!.y).toBeGreaterThanOrEqual(intro!.y + intro!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`${mode}-proposal.png`), animations: 'disabled' });
  await panel.getByRole('button', { name: 'Approve and apply to cart' }).click();
  await expect(panel.getByText('Verified cart update', { exact: true })).toBeVisible();
  expect(state.writes()).toBe(1); expect(state.placements()).toBe(0);
  await page.getByRole('link', { name: 'Continue to checkout review' }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  const place = page.getByRole('button', { name: mode === 'optimize' ? 'Place order · $17.00' : 'Place order · $23.00', exact: true });
  await expect(place).toBeDisabled();
  expect(state.placements()).toBe(0);
  await page.getByRole('checkbox', { name: /I confirm payment/ }).check();
  await expect(place).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('lost cart-update response reconciles committed status without duplicating items', async ({ page }) => {
  const state = await fixture(page, 'buy_again', true);
  await page.goto(`/assistant?shopping=buy_again&task=${uuid(6)}`);
  await expect(page).toHaveURL(/\/assistant$/);
  await page.getByRole('textbox', { name: 'Your message' }).fill('Buy my breakfast again');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Approve and apply to cart' }).click();
  await expect(page.getByText('Verified cart update', { exact: true })).toBeVisible();
  expect(state.writes()).toBe(1); expect(state.placements()).toBe(0);
});

test('proposal selection and requote are operable from the keyboard', async ({ page }) => {
  const state = await fixture(page, 'buy_again');
  await page.goto(`/assistant?shopping=buy_again&task=${uuid(6)}`);
  await expect(page).toHaveURL(/\/assistant$/);
  await page.getByRole('textbox', { name: 'Your message' }).fill('Buy my breakfast again');
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await send.focus(); await send.press('Enter');
  const checkbox = page.getByRole('checkbox', { name: 'Accept item', exact: true });
  await checkbox.focus(); await checkbox.press('Space');
  await expect(checkbox).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Approve and apply to cart' })).toBeDisabled();
  await checkbox.press('Space');
  await expect(checkbox).toBeChecked();
  const requote = page.getByRole('button', { name: 'Requote selected changes' });
  await requote.focus(); await requote.press('Enter');
  await expect(page.getByRole('button', { name: 'Approve and apply to cart' })).toBeEnabled();
  expect(state.writes()).toBe(0); expect(state.placements()).toBe(0);
});
