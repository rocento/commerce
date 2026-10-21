import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const theme = JSON.parse(readFileSync(new URL('../../packages/api-client/src/theme-contract.json', import.meta.url), 'utf8')).default;
const id = '00000000-0000-4000-8000-000000000006';
const customer = { id, email: 'shopper@example.test', verified: true, created_at: '2026-09-15T12:00:00Z' };
const address = { id, label: 'home', custom_label: 'Home', formatted_address: '12 Garden Street', geography: { city_name: 'Cairo', state_name: 'Cairo', country_code: 'EG' }, building: '12', floor: '3', apartment: '8', delivery_instructions: 'Ring the doorbell', is_default: true };

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
  await page.route('**/api/v1/theme/*', route => route.fulfill({ json: { configuration: theme, cities: [] } }));
  await page.route('**/api/v1/customer/auth/refresh', route => route.fulfill({ json: { access_token: 'fixture', customer } }));
  await page.route('**/api/v1/customer/me', route => route.fulfill({ json: customer }));
  await page.route('**/api/v1/delivery-area*', route => route.fulfill({ json: { configured: false, deliverable: true } }));
  await page.route('**/api/v1/cart', route => route.fulfill({ json: { id, items: [], subtotal: '0.00', currency: 'USD' } }));
  await page.route('**/api/v1/customer/locations', route => route.fulfill({ json: [address] }));
  await page.route('**/api/v1/assistant/chat', route => {
    const input = route.request().postDataJSON();
    const events = [{ type: 'message.delta', text: 'Here are your saved addresses.' }, { type: 'content.blocks', blocks: [{ kind: 'saved_addresses' }] }, { type: 'done' }];
    return route.fulfill({ contentType: 'text/event-stream', body: events.map((event, sequence) => `data: ${JSON.stringify({ version: '1', request_id: input.request_id, sequence, ...event })}\n\n`).join('') });
  });
  await page.goto('/assistant');
  await expect(page.getByRole('textbox', { name: 'Your message' })).toBeVisible();
});

async function ask(page: import('@playwright/test').Page) {
  await page.getByPlaceholder('Ask about an order, or tell us what you need…').fill('my saved adress');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  return page.getByRole('region', { name: 'Your saved addresses', exact: true });
}

test('saved address cards show the default, full address and delivery details', async ({ page }, info) => {
  const card = await ask(page);
  await expect(card.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await expect(card.getByText('Default', { exact: true })).toBeVisible();
  await expect(card.getByText('12 Garden Street, Cairo, Cairo, Egypt')).toBeVisible();
  await expect(card.getByText('Building 12 · Floor 3 · Apartment 8')).toBeVisible();
  await expect(card.getByText('Ring the doorbell')).toBeVisible();
  await expect(card.getByRole('link', { name: 'Manage addresses' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('saved-addresses.png'), animations: 'disabled' });
});

test('address failures can be retried and an empty list offers adding an address', async ({ page }) => {
  let fail = true;
  await page.route('**/api/v1/customer/locations', route => fail ? route.fulfill({ status: 503, json: { error: 'Unavailable' } }) : route.fulfill({ json: [] }));
  const card = await ask(page);
  await expect(card.getByText('Your saved addresses could not be loaded.')).toBeVisible();
  fail = false;
  await card.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(card.getByText('You haven’t saved any addresses yet. Add one to make checkout easier.')).toBeVisible();
  await expect(card.getByRole('link', { name: 'Add an address' })).toHaveAttribute('href', '/account/locations/new');
});

test('deletion requires confirmation and refreshes the remaining default address', async ({ page }) => {
  const work = { ...address, id: '00000000-0000-4000-8000-000000000007', label: 'work', custom_label: 'Work', is_default: false };
  let saved = [address, work];
  let deletions = 0;
  await page.route('**/api/v1/customer/locations', route => route.fulfill({ json: saved }));
  await page.route(`**/api/v1/customer/locations/${id}`, route => {
    expect(route.request().method()).toBe('DELETE');
    deletions++;
    saved = [{ ...work, is_default: true }];
    return route.fulfill({ json: { status: 'ok' } });
  });
  const card = await ask(page);
  await card.getByRole('button', { name: 'Delete Home address', exact: true }).click();
  await card.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(deletions).toBe(0);
  await expect(card.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Delete Home address', exact: true }).click();
  await card.getByRole('button', { name: 'Delete address', exact: true }).click();
  await expect(card.getByRole('heading', { name: 'Home', exact: true })).toHaveCount(0);
  await expect(card.getByText('1 saved', { exact: true })).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Work', exact: true })).toBeVisible();
  await expect(card.getByText('Default', { exact: true })).toBeVisible();
  expect(deletions).toBe(1);
});

test('failed deletion preserves the address and retry can delete the last address', async ({ page }) => {
  let fail = true;
  let saved = [address];
  await page.route('**/api/v1/customer/locations', route => route.fulfill({ json: saved }));
  await page.route(`**/api/v1/customer/locations/${id}`, route => {
    if (fail) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
    saved = [];
    return route.fulfill({ json: { status: 'ok' } });
  });
  const card = await ask(page);
  await card.getByRole('button', { name: 'Delete Home address', exact: true }).click();
  await card.getByRole('button', { name: 'Delete address', exact: true }).click();
  await expect(card.getByRole('alert')).toHaveText('This address could not be deleted. Please try again.');
  await expect(card.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  fail = false;
  await card.getByRole('button', { name: 'Delete address', exact: true }).click();
  await expect(card.getByText('0 saved', { exact: true })).toBeVisible();
  await expect(card.getByRole('link', { name: 'Add an address' })).toBeVisible();
});
