import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { SupportDetail, SupportInput } from '../../packages/api-client/src';

const theme = JSON.parse(readFileSync(new URL('../../packages/api-client/src/theme-contract.json', import.meta.url), 'utf8')).default;
const id = '00000000-0000-4000-8000-000000000001';
const customer = { id, email: 'shopper@example.test', verified: true, created_at: '2026-09-15T12:00:00Z' };
const detail: SupportDetail = {
  ticket: { id, number: 12, subject: 'Missing apples', category: 'order_issue', status: 'open', priority: 'normal', order_id: null, created_at: '2026-10-02T10:00:00Z' },
  messages: [], contact: null, contact_name: null,
};

async function setup(page: Page, { guest = false, failFirst = false } = {}) {
  const writes: SupportInput[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
  await page.route('**/api/v1/theme/*', route => route.fulfill({ json: { configuration: theme, cities: [] } }));
  await page.route('**/api/v1/languages', route => route.fulfill({ json: { source_locale: 'en', languages: [] } }));
  await page.route('**/api/v1/customer/auth/refresh', route => route.fulfill(guest ? { status: 401, json: { error: 'unauthorized' } } : { json: { access_token: 'fixture', customer } }));
  await page.route('**/api/v1/customer/me', route => route.fulfill(guest ? { status: 401, json: { error: 'unauthorized' } } : { json: customer }));
  await page.route('**/api/v1/delivery-area*', route => route.fulfill({ json: { configured: false, deliverable: true } }));
  await page.route('**/api/v1/cart', route => route.fulfill({ json: { id, items: [], subtotal: '0.00', currency: 'USD' } }));
  await page.route('**/api/v1/support/session', route => route.fulfill({ json: {} }));
  await page.route(`**/api/v1/customer/support/tickets/${id}`, route => route.fulfill({ json: detail }));
  await page.route('**/api/v1/support/tickets', route => {
    writes.push(route.request().postDataJSON());
    return route.fulfill(failFirst && writes.length === 1 ? { status: 503, json: { error: 'Try again' } } : { json: detail });
  });
  await page.goto('/assistant');
  await expect(page.getByRole('textbox', { name: 'Your message' })).toBeVisible();
  return { writes, errors };
}

async function reply(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Your message' }).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
}

async function draft(page: Page) {
  await reply(page, 'I need to open a ticket');
  await reply(page, 'Missing apples');
  await page.getByRole('group', { name: 'Ticket category' }).getByRole('button', { name: 'order issue', exact: true }).click();
  await reply(page, 'My delivery arrived without the apples.');
}

test('signed-in ticket waits for confirmation before creating the request', async ({ page }) => {
  const { writes, errors } = await setup(page);
  await draft(page);
  const intake = page.getByRole('region', { name: 'Support ticket conversation' });
  await expect(intake.getByRole('button', { name: 'Open ticket', exact: true })).toBeVisible();
  expect(writes).toHaveLength(0);
  await reply(page, 'yes');
  await expect(intake).not.toBeVisible();
  await expect(page.getByText('Your ticket is open. Our team will follow up here.', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ subject: 'Missing apples', category: 'order_issue', body: 'My delivery arrived without the apples.' });
  expect(errors).toEqual([]);
});

test('failed submission retries the same request ID and draft', async ({ page }) => {
  const { writes, errors } = await setup(page, { failFirst: true });
  await draft(page);
  const intake = page.getByRole('region', { name: 'Support ticket conversation' });
  await intake.getByRole('button', { name: 'Open ticket', exact: true }).click();
  await expect(intake.getByRole('alert')).toContainText('Your request is saved for retry.');
  await expect(intake.getByRole('button', { name: 'Cancel ticket', exact: true })).toHaveCount(0);
  await intake.getByRole('button', { name: 'Retry saved ticket', exact: true }).click();
  await expect(intake).not.toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(errors).toEqual([]);
});

test('guest ticket collects contact details and validates them before confirmation', async ({ page }) => {
  const { writes, errors } = await setup(page, { guest: true });
  await draft(page);
  await reply(page, 'Guest shopper');
  await reply(page, 'invalid contact');
  await expect(page.getByText('Please enter a valid email address or mobile number, including your country code.', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(0);
  await reply(page, 'guest@example.test');
  await page.getByRole('region', { name: 'Support ticket conversation' }).getByRole('button', { name: 'Open ticket', exact: true }).click();
  await expect(page.getByText('Your ticket is open. Our team will follow up here.', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ contact_name: 'Guest shopper', contact: 'guest@example.test' });
  expect(errors).toEqual([]);
});

test('cancelling an unsubmitted ticket makes no support request', async ({ page }) => {
  const { writes, errors } = await setup(page);
  await reply(page, 'I need to open a ticket');
  await reply(page, 'cancel');
  await expect(page.getByRole('region', { name: 'Support ticket conversation' })).not.toBeVisible();
  await expect(page.getByText('Ticket request cancelled. What else can I help with?', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(0);
  expect(errors).toEqual([]);
});
