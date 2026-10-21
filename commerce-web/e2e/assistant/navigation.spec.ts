import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const theme = JSON.parse(readFileSync(new URL('../../packages/api-client/src/theme-contract.json', import.meta.url), 'utf8')).default;
const customer = { id: '00000000-0000-4000-8000-000000000001', email: 'shopper@example.test', verified: true, created_at: '2026-09-15T12:00:00Z' };
const turns = [
  { conversation_id: '00000000-0000-4000-8000-000000000002', request_id: '00000000-0000-4000-8000-000000000003', question: 'Find fresh apples', answer: 'Here are the orchard products.', created_at: '2026-09-22T12:00:00Z', blocks: [], helpful: null },
  { conversation_id: '00000000-0000-4000-8000-000000000004', request_id: '00000000-0000-4000-8000-000000000005', question: 'Plan a family dinner', answer: 'Let’s plan your dinner.', created_at: '2026-09-21T12:00:00Z', blocks: [], helpful: null },
];
test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
  await page.route('**/api/v1/theme/*', route => route.fulfill({ json: { configuration: theme, cities: [] } }));
  await page.route('**/api/v1/customer/auth/refresh', route => route.fulfill({ json: { access_token: 'fixture', customer } }));
  await page.route('**/api/v1/customer/me', route => route.fulfill({ json: customer }));
  await page.route('**/api/v1/delivery-area*', route => route.fulfill({ json: { configured: false, deliverable: true } }));
  await page.route('**/api/v1/cart', route => route.fulfill({ json: { id: customer.id, items: [], subtotal: '0.00', currency: 'USD' } }));
  await page.route('**/api/v1/search?*', route => route.fulfill({ json: { hits: [], total: 0, offset: 0, limit: 24, facets: {} } }));
  await page.route('**/api/v1/assistant/history*', route => route.fulfill({ json: turns }));
});

test('icon rail opens searchable history, restores chats and starts a new conversation', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/assistant');
  const rail = page.getByRole('navigation', { name: 'Assistant navigation' });
  await expect(rail).toBeVisible();
  expect((await rail.boundingBox())!.width).toBeLessThanOrEqual(80);
  expect((await rail.boundingBox())!.x).toBe(0);
  await expect(rail.locator('img')).toHaveAttribute('src', '/brand/favicon-32.png');
  await expect(rail.getByRole('button', { name: 'My orders', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('assistant-icon-rail.png') });
  const trigger = rail.getByRole('button', { name: 'Open conversations' });
  await trigger.click();
  const history = page.getByRole('dialog', { name: 'Conversation navigation' });
  await expect(history.getByRole('button', { name: /Find fresh apples/ })).toBeVisible();
  await history.getByRole('searchbox').fill('orchard');
  await expect(history.locator('.assistant-history-item')).toHaveCount(1);
  await history.getByRole('searchbox').fill('not found');
  await expect(history.getByRole('status')).toHaveText('No conversations match your search.');
  await history.getByRole('searchbox').fill('');
  await page.screenshot({ path: info.outputPath('assistant-history.png') });
  expect(await history.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(history).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await history.getByRole('button', { name: /Find fresh apples/ }).click();
  await expect(page).toHaveURL(new RegExp(`conversation=${turns[0].conversation_id}`));
  await expect(page.locator('.assistant-messages')).toContainText('Here are the orchard products.');
  await expect(history).not.toBeVisible();
  await rail.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page).toHaveURL(/\/assistant$/);
  await expect(page.locator('.assistant-message')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('guest history explains sign-in without requesting private conversations', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/v1/customer/auth/refresh', route => route.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
  await page.route('**/api/v1/assistant/history*', route => { requests++; return route.fulfill({ json: [] }); });
  await page.goto('/assistant');
  await page.getByRole('button', { name: 'Open conversations' }).click();
  await expect(page.getByRole('dialog', { name: 'Conversation navigation' }).getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect(requests).toBe(0);
});
