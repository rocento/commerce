import { test, expect, type Page } from '@playwright/test';

const address = { id: 'address-1', latitude: 30.0444, longitude: 31.2357, formatted_address: 'Cairo delivery address', label: 'home', custom_label: '', is_default: true };
const customer = { id: 'customer-1', email: 'sarah@example.test', mobile_number: null, created_at: '2026-10-01T12:00:00Z' };
const order = { id: 'order-1', number: 1001, customer_id: customer.id, status: 'delivered', created_at: customer.created_at, location: address, contact: customer, total: '70', currency: 'EGP' };
const items = [{ product_id: 'apple', sku: 'AP-1', name: 'Apple', quantity: 2, unit: 'each', line_total: '50', discount_amount: '5' }, { product_id: 'pear', sku: 'PE-1', name: 'Pear', quantity: 1, unit: 'each', line_total: '20', discount_amount: '0' }];

async function fixture(page: Page, permissions = ['*'], failed = false) {
  await page.route('**/tile.openstreetmap.org/**', route => route.abort());
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path.endsWith('/admin/me')) return route.fulfill({ json: { user: { id: 'admin', name: 'Map reviewer', email: 'admin@example.test', active: true }, permissions } });
    if (path.endsWith('/admin/orders/sales')) return route.fulfill({ json: [{ order, items }, { order: { ...order, id: 'cancelled', status: 'cancelled' }, items }] });
    if (path.endsWith('/admin/orders')) return route.fulfill({ json: [order, { ...order, id: 'cancelled', status: 'cancelled' }] });
    if (path.endsWith('/admin/orders/order-1')) return route.fulfill({ json: { order, items } });
    if (path.endsWith('/admin/orders/cancelled')) return route.fulfill({ json: { order: { ...order, id: 'cancelled', status: 'cancelled' }, items } });
    if (path.endsWith('/grids/customers')) return route.fulfill({ json: { items: [customer], next_cursor: url.searchParams.has('cursor') ? null : 'next' } });
    if (path.endsWith('/customers/customer-1/profile')) return route.fulfill(failed ? { status: 503, json: { error: 'Customer addresses unavailable' } } : { json: { account: customer, first_name: 'Sarah', last_name: 'Ali', customer_group: 'VIP', locations: [address, { ...address, id: 'address-2', latitude: 31, longitude: 30, is_default: false, formatted_address: 'Alexandria office' }], attributes: {} } });
    return route.fulfill({ status: 404, json: { error: 'Unexpected test endpoint' } });
  });
}

test('catalog geography does not require unrelated payment records', async ({ page }) => {
  await fixture(page);
  let fullDetailRequests = 0;
  await page.route('**/api/v1/admin/orders/order-1', route => {
    fullDetailRequests++;
    return route.fulfill({ status: 500, json: { error: 'Internal service error' } });
  });
  await page.goto('/catalog/geography');
  await expect(page.locator('.order-geo-summary')).toContainText('65.00 EGP');
  await expect(page.locator('.leaflet-marker-icon')).toHaveCount(1);
  await expect(page.getByText('Internal service error', { exact: true })).toHaveCount(0);
  expect(fullDetailRequests).toBe(0);
});

for (const width of [1440, 390]) {
  test(`catalog map filters sales and selects pins at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await fixture(page);
    await page.goto('/catalog/geography');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Catalog geography');
    await expect(page.locator('.order-geo-summary')).toContainText('65.00 EGP');
    await expect(page.locator('.leaflet-marker-icon')).toHaveCount(1);
    await page.locator('.leaflet-marker-icon').click();
    await expect(page.getByRole('heading', { name: 'Selected location' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Product', exact: true }).selectOption('apple');
    await expect(page.locator('.order-geo-summary')).toContainText('45.00 EGP');
    await expect(page.getByRole('complementary', { name: 'Products by location' })).not.toContainText('Pear');
    await page.getByRole('searchbox', { name: 'Search' }).fill('missing');
    await expect(page.getByText('No product sales with valid coordinates match this view.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.locator('.leaflet-marker-icon')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/geography/catalog-${width}.png`, fullPage: true });
  });

  test(`customer map defaults to default addresses without order permissions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await fixture(page, ['customers.read']);
    await page.goto('/customers/geography');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Customer geography');
    await expect(page.getByRole('combobox', { name: 'Addresses', exact: true })).toHaveValue('default');
    await expect(page.locator('.leaflet-marker-icon')).toHaveCount(1);
    await page.getByRole('combobox', { name: 'Addresses', exact: true }).selectOption('all');
    await expect(page.locator('.leaflet-marker-icon')).toHaveCount(2);
    await expect(page.locator('.order-geo-summary')).toContainText('1 mapped customers');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByRole('combobox', { name: 'Addresses', exact: true })).toHaveValue('default');
    await expect(page.locator('.leaflet-marker-icon')).toHaveCount(1);
    await page.locator('.leaflet-marker-icon').click();
    await expect(page.getByRole('heading', { name: 'Selected location' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sarah Ali' })).toHaveAttribute('href', '/customers/profiles/customer-1');
    await page.getByRole('button', { name: 'Load more customers' }).click();
    await expect(page.getByRole('button', { name: 'Load more customers' })).toHaveCount(0);
    await expect(page.locator('.order-geo-summary')).toContainText('1 saved addresses');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/geography/customer-${width}.png`, fullPage: true });
  });
}

test('geography routes enforce source permissions', async ({ page }) => {
  await fixture(page, ['catalog.read']);
  await page.goto('/catalog/geography');
  await expect(page.getByRole('heading', { name: 'This page isn’t available' })).toBeVisible();
  await page.goto('/customers/geography');
  await expect(page.getByRole('heading', { name: 'This page isn’t available' })).toBeVisible();
});

test('shared map preserves order geography', async ({ page }) => {
  await fixture(page);
  await page.goto('/sales/order-geography');
  await expect(page.locator('.leaflet-marker-icon')).toHaveCount(1);
  await page.locator('.leaflet-marker-icon').click();
  await expect(page.getByRole('heading', { name: 'Selected location' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Orders by location' })).toContainText('#1001');
});

test('failed customer details show a retryable error', async ({ page }) => {
  await fixture(page, ['customers.read'], true);
  await page.goto('/customers/geography');
  await expect(page.getByRole('alert')).toContainText('Customer addresses unavailable', { timeout: 15000 });
  await fixture(page, ['customers.read']);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.leaflet-marker-icon')).toHaveCount(1);
});
