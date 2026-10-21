import { test, expect } from '@playwright/test';
const customer = { id: '11111111-1111-4111-8111-111111111111', first_name: 'Alex', last_name: 'Morgan', email: 'alex@example.test', customer_group: 'General', created_at: '2026-01-01T00:00:00Z' };
test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
  await page.route('**/api/v1/admin/languages', route => route.fulfill({ json: { source_locale: 'en', languages: [], publication_available: true } }));
  await page.route('**/api/v1/admin/markets', route => route.fulfill({ json: { items: [], live: { region: 'EG', currency: 'EGP' }, locales: ['en'], activation_available: false } }));
  await page.route('**/api/v1/admin/me', route => route.fulfill({ json: { user: { id: customer.id, name: 'Test Admin', email: 'admin@example.test' }, permissions: ['*'] } }));
  await page.route('**/api/v1/admin/grids/*/sorts', route => route.fulfill({ json: ['id', 'name', 'created_at'] }));
  await page.route('**/api/v1/admin/grids/*?*', route => route.fulfill({ json: { items: [], next_cursor: null, total_count: 0 } }));
});

for (const [path, name] of [['/customers/profiles', 'customers'], ['/sales/orders', 'orders'], ['/system/audit', 'audit'], ['/catalog/attributes', 'attribute-definitions']]) {
  test(`${name} shares accessible controls and fits mobile`, async ({ page }) => {
    await page.goto(path);
    const grid = page.getByRole('region', { name: `${name} pagination`, exact: true });
    await expect(grid.getByLabel('Sort column')).toBeVisible();
    await expect(grid.getByLabel('Direction')).toBeVisible();
    await expect(grid.getByLabel('Rows', { exact: true })).toBeVisible();
    await expect(grid.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
    await expect(grid.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(grid).toBeVisible();
    expect(await grid.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await expect(grid.getByLabel('Direction')).toBeVisible();
  });
}

test('search is debounced; filters, sort and page size reset the cursor', async ({ page }, info) => {
  await page.route('**/api/v1/admin/grids/customers/sorts', route => route.fulfill({ json: ['id', 'email'] }));
  const requests: URL[] = [];
  await page.route('**/api/v1/admin/grids/customers?*', route => { requests.push(new URL(route.request().url())); return route.fulfill({ json: { items: [customer], next_cursor: 'next-page' } }); });
  await page.goto('/customers/profiles');
  const grid = page.getByRole('region', { name: 'customers pagination' });
  await grid.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(grid).toContainText('Page 2');
  const search = grid.getByRole('searchbox', { name: 'Search', exact: true });
  await search.fill('Alex');
  await expect.poll(() => requests.at(-1)?.searchParams.get('q')).toBe('Alex');
  expect(requests.at(-1)?.searchParams.has('cursor')).toBe(false);
  await expect(grid).toContainText('Page 1');
  await grid.getByLabel('Rows', { exact: true }).selectOption('25');
  await grid.getByLabel('Sort column').selectOption('email');
  await grid.getByLabel('Direction').selectOption('true');
  await expect.poll(() => requests.at(-1)?.searchParams.get('descending')).toBe('true');
  expect(requests.at(-1)?.searchParams.get('sort')).toBe('email');
  expect(requests.at(-1)?.searchParams.get('limit')).toBe('25');
  await grid.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect.poll(() => requests.at(-1)?.searchParams.has('q')).toBe(false);
  await expect(search).toHaveValue('');
  await expect(grid.getByLabel('Sort column')).toHaveValue('email');
  await page.screenshot({ path: info.outputPath('desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('mobile.png'), fullPage: true });
});

test('status chips can be removed and sort failures have separate recovery', async ({ page }) => {
  let failSorts = true;
  const requests: URL[] = [];
  await page.route('**/api/v1/admin/grids/orders/sorts', route => route.fulfill(failSorts ? { status: 503, json: { error: 'Temporarily unavailable' } } : { json: ['id', 'created_at'] }));
  await page.route('**/api/v1/admin/grids/orders?*', route => { requests.push(new URL(route.request().url())); return route.fulfill({ json: { items: [], next_cursor: null, total_count: 0 } }); });
  await page.goto('/sales/orders');
  const grid = page.getByRole('region', { name: 'orders pagination' });
  await grid.getByLabel('Status', { exact: true }).selectOption('delivery_failed');
  await expect.poll(() => requests.at(-1)?.searchParams.get('status')).toBe('delivery_failed');
  await grid.getByRole('button', { name: 'Remove Status: Delivery failed' }).click();
  await expect.poll(() => requests.at(-1)?.searchParams.has('status')).toBe(false);
  await expect(grid.getByRole('alert')).toContainText('Sort options could not be loaded');
  failSorts = false;
  await grid.getByRole('button', { name: 'Retry sort options' }).click();
  await expect(grid.getByRole('alert')).toHaveCount(0);
  await expect(grid.getByLabel('Sort column').locator('option')).toHaveCount(2);
});

test('empty and failed grids remain usable', async ({ page }) => {
  let failing = true;
  await page.route('**/api/v1/admin/grids/customers?*', route => route.fulfill(failing ? { status: 503, json: { error: 'Customer service unavailable' } } : { json: { items: [], next_cursor: null, total_count: 0 } }));
  await page.goto('/customers/profiles');
  const grid = page.getByRole('region', { name: 'customers pagination' });
  await expect(grid.getByRole('alert')).toContainText('Customer service unavailable');
  failing = false;
  await grid.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(grid.getByRole('alert')).toHaveCount(0);
  await expect(grid.getByRole('status')).toHaveText('0 itemsNo items to display');
  await expect(grid.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
});

test('complete local collections sort before paginating', async ({ page }) => {
  const themes = Array.from({ length: 60 }, (_, i) => ({ id: String(i), name: `Theme ${String(i + 1).padStart(2, '0')}`, owner_channel: 'web', revision: i, updated_at: '2026-01-01T00:00:00Z' }));
  await page.route('**/api/v1/admin/themes', route => route.fulfill({ json: themes }));
  await page.goto('/content/themes');
  const grid = page.getByRole('region', { name: 'themes pagination' });
  await expect(grid.getByRole('status')).toContainText('60 items');
  await grid.getByLabel('Rows', { exact: true }).selectOption('25');
  await grid.getByLabel('Direction').selectOption('true');
  await expect(page.locator('tbody tr').first()).toContainText('Theme 60');
  await grid.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('tbody tr').first()).toContainText('Theme 35');
  await grid.getByRole('searchbox', { name: 'Search', exact: true }).fill('Theme 01');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(grid.getByRole('status')).toContainText('1 item');
  await expect(grid).toContainText('Page 1');
});

test('product filters share the toolbar and clear without losing sort preferences', async ({ page }) => {
  const category = { id: customer.id, name: 'Produce', slug: 'produce', parent_id: null };
  await page.route('**/api/v1/catalog/categories', route => route.fulfill({ json: [category] }));
  await page.route('**/api/v1/admin/catalog/categories', route => route.fulfill({ json: [category] }));
  const requests: URL[] = [];
  await page.route('**/api/v1/admin/grids/catalog?*', route => { requests.push(new URL(route.request().url())); return route.fulfill({ json: { items: [], next_cursor: null, total_count: 0 } }); });
  await page.goto('/catalog/products');
  const grid = page.getByRole('region', { name: 'catalog pagination' });
  await grid.getByLabel('Search name or SKU').fill('apples');
  await grid.getByLabel('Category').selectOption(category.id);
  await grid.getByLabel('Status').selectOption('false');
  await grid.getByRole('button', { name: 'Apply filters' }).click();
  await expect.poll(() => requests.at(-1)?.searchParams.get('q')).toBe('apples');
  expect(requests.at(-1)?.searchParams.get('active')).toBe('false');
  expect(requests.at(-1)?.searchParams.get('category_id')).toBe(category.id);
  await grid.getByLabel('Direction').selectOption('true');
  await grid.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect.poll(() => requests.at(-1)?.searchParams.has('category_id')).toBe(false);
  expect(requests.at(-1)?.searchParams.has('active')).toBe(false);
  expect(requests.at(-1)?.searchParams.has('q')).toBe(false);
  await expect(grid.getByLabel('Direction')).toHaveValue('true');
});

// Categories now use a hierarchy editor rather than the shared paginated grid.
test('category tree controls remain accessible on mobile', async ({ page }) => {
  await page.route('**/api/v1/admin/catalog/categories', route => route.fulfill({ json: [{ id: 'category-one', name: 'Tea', slug: 'tea', parent_id: null }] }));
  await page.goto('/catalog/categories');
  await expect(page.getByRole('tree', { name: 'Categories', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('searchbox', { name: 'Search categories', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand all', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
