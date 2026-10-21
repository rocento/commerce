import { test, expect } from './fixtures';

const customer = {
  id: '11111111-1111-4111-8111-111111111111', first_name: 'Regression', last_name: 'Customer',
  email: 'regression@example.test', mobile_number: null, primary_identifier: 'email',
  verified: true, customer_group: 'VIP', created_at: '2026-01-01T00:00:00Z',
};

test('customer grid opens a profile, custom attributes, refresh and back', async ({ page }) => {
  await page.route('**/api/v1/admin/grids/customers?*', route => route.fulfill({ json: { items: [customer], next_cursor: null } }));
  await page.route(`**/api/v1/admin/customers/${customer.id}/profile`, route => route.fulfill({ json: { ...customer, account: customer, locations: [], attributes: { loyalty_tier: 'Gold' } } }));
  await page.goto('/customers/profiles');
  await page.getByRole('link', { name: 'Regression Customer', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Regression Customer');
  await page.getByRole('button', { name: 'Attributes', exact: true }).click();
  await expect(page.getByText('Gold', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Attributes', exact: true }).click();
  await expect(page.getByText('Gold', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '← Customer profiles' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Customer profiles');
});

test('customer empty state and failed request can be retried', async ({ page }) => {
  let failing = true;
  await page.route('**/api/v1/admin/grids/customers?*', route => route.fulfill(failing
    ? { status: 503, json: { error: 'Customer service unavailable' } }
    : { json: { items: [], next_cursor: null } }));
  await page.goto('/customers/profiles');
  await expect(page.getByRole('region', { name: 'customers pagination' }).getByRole('alert')).toContainText('Customer service unavailable');
  failing = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('No customers match these filters.')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('customer grid sends search, sort, page size and cursor and resets paging', async ({ page }) => {
  await page.route('**/api/v1/admin/grids/customers/sorts', route => route.fulfill({ json: ['id', 'email'] }));
  await page.route('**/api/v1/admin/grids/customers?*', route => route.fulfill({ json: { items: [customer], next_cursor: 'next-page' } }));
  await page.goto('/customers/profiles');
  const grid = page.getByRole('region', { name: 'customers pagination' });
  await expect(grid.getByRole('button', { name: 'Previous' })).toBeDisabled();
  await grid.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(grid).toContainText('Page 2');
  const request = page.waitForRequest(r => r.url().includes('grids/customers?') && new URL(r.url()).searchParams.get('q') === 'Regression');
  await grid.getByRole('searchbox', { name: 'Search' }).fill('Regression');
  expect(new URL((await request).url()).searchParams.has('cursor')).toBe(false);
  await expect(grid).toContainText('Page 1');
  await grid.getByLabel('Rows').selectOption('25');
  await grid.getByLabel('Sort column').selectOption('email');
  const sorted = page.waitForRequest(r => r.url().includes('grids/customers?') && new URL(r.url()).searchParams.get('descending') === 'true');
  await grid.getByLabel('Direction').selectOption('true');
  const params = new URL((await sorted).url()).searchParams;
  expect(params.get('sort')).toBe('email');
  expect(params.get('limit')).toBe('25');
});

// Segment mutations now run against the disposable API in e2e/improvements/segments.spec.ts.

test('customer attribute creation permits segment eligibility', async ({ page }) => {
  await page.goto('/customers/attributes');
  await page.getByRole('button', { name: 'Add Attribute', exact: true }).click();
  await expect(page).toHaveURL(/\/customers\/attributes\/definitions\/new$/);
  await expect(page.getByRole('heading', { name: 'New customer attribute', level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Use in segments' })).toBeEnabled();
  await page.getByRole('checkbox', { name: 'Use in segments' }).check();
  await page.getByRole('combobox', { name: 'Input type', exact: true }).selectOption('integer');
  await expect(page.getByRole('checkbox', { name: 'Use in segments' })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Use in segments' })).not.toBeChecked();
});

test('read-only customer user cannot save segments or access system users', async ({ page }) => {
  await page.route('**/api/v1/admin/me', async route => {
    const response = await route.fetch();
    const identity = await response.json();
    await route.fulfill({ json: { ...identity, permissions: ['customers.read', 'attributes.read'] } });
  });
  await page.goto('/customers/segments');
  await expect(page.getByRole('heading', { name: 'Customer Segments', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Segment' })).toHaveCount(0);
  await page.goto('/customers/segments/new');
  await expect(page.getByRole('button', { name: 'Save Segment' })).toHaveCount(0);
  await page.goto('/system/users');
  await expect(page.getByRole('heading', { name: 'This page isn’t available' })).toBeVisible();
});
