import { test, expect, type Page } from '@playwright/test';

const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const report = () => ({
  from: day(-6), to: day(0),
  run: { generation: 'overview-test', started_at: new Date().toISOString(), completed_at: new Date().toISOString(), age_seconds: 45 },
  sales: [1240, 1860, 1480, 2490, 2140, 3280, 2940].map((net, index) => ({ day: day(index - 6), currency: 'USD', orders: [18, 24, 21, 32, 28, 42, 36][index], cancelled: 1, gross: String(net + 20), net: String(net), refunds: '20' })),
  products: [], funnel: { visitors: 2840, carts: 426, checkouts: 268, purchases: 201 }, traffic: [], cohorts: [], ltv: [],
});

async function setup(page: Page, options: { permissions?: string[]; empty?: boolean; fail?: boolean; mixed?: boolean; delayed?: boolean } = {}) {
  const reportRequests: URL[] = [];
  let queries = 0;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/admin/me')) return route.fulfill({ json: { user: { id: 'admin', name: 'Store administrator', email: 'info@rocento.com' }, permissions: options.permissions ?? ['*'] } });
    if (path.endsWith('/reports/dashboard')) {
      reportRequests.push(new URL(route.request().url()));
      if (options.fail) return route.fulfill({ status: 503, json: { error: 'Reporting service unavailable' } });
      const data = report();
      if (options.empty) { data.sales = []; data.funnel = { visitors: 0, carts: 0, checkouts: 0, purchases: 0 }; }
      if (options.mixed) data.sales.push({ ...data.sales[0], currency: 'EGP', net: '900000', orders: 99 });
      if (options.delayed) data.run.age_seconds = 7200;
      return route.fulfill({ json: data });
    }
    if (path.endsWith('/assistant/query')) { queries++; return route.fulfill({ status: 400, json: { error: 'No query expected during overview navigation' } }); }
    return route.fulfill({ json: [] });
  });
  return { reportRequests, queries: () => queries };
}

for (const width of [1440, 1024, 390]) test(`overview is readable and usable at ${width}px`, async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await setup(page);
  await page.setViewportSize({ width, height: 1050 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Business overview', exact: true })).toBeVisible();
  await expect(page.locator('.ov-metric-primary')).toContainText('$15,430.00');
  await expect(page.locator('.ov-journey')).toContainText('7.1% visitor-to-purchase');
  await expect(page.locator('.ov-workspace-card')).toHaveCount(6);
  await expect(page.locator('.sidebar .ai-launcher')).toHaveCount(0);
  await expect(page.locator('.ov-ai-panel')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.getByRole('button', { name: 'Ask Rocento AI' })).toHaveCSS('background-color', 'rgb(237, 243, 250)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`overview-${width}.png`), fullPage: true });
  await page.getByText('View daily figures', { exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  expect(errors).toEqual([]);
});

test('periods and currencies use separate data and trigger the requested date range', async ({ page }) => {
  const state = await setup(page, { mixed: true });
  await page.goto('/');
  await page.getByLabel('Report currency').selectOption('USD');
  await expect(page.locator('.ov-metric-primary')).toContainText('$15,430.00');
  await page.getByLabel('Report currency').selectOption('EGP');
  await expect(page.locator('.ov-metric-primary')).toContainText('900,000.00');
  await page.getByLabel('Reporting period').selectOption('30');
  await expect.poll(() => state.reportRequests.at(-1)?.searchParams.get('from')).toBe(day(-29));
  await expect(page.locator('.ov-metric-primary')).toContainText('900,000.00');
});

test('AI shortcuts prefill the supported question without submitting it', async ({ page }) => {
  const state = await setup(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Show low-stock products', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Show low-stock products', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByLabel('Maximum available stock')).toHaveValue('5');
  expect(state.queries()).toBe(0);
  await dialog.getByRole('button', { name: 'Close assistant' }).click();
  await expect(page.getByRole('button', { name: 'Show low-stock products', exact: true })).toBeFocused();
});

test('restricted roles see permitted actions without fetching financial data', async ({ page }) => {
  const state = await setup(page, { permissions: ['inventory.read'] });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Business overview' })).toBeVisible();
  await expect(page.locator('.ov-workspace-card')).toHaveCount(1);
  await expect(page.locator('.ov-workspace-card')).toContainText('Inventory network');
  await expect(page.locator('.ov-operation')).toHaveCount(1);
  await expect(page.locator('.ov-metrics, .ov-ai-panel')).toHaveCount(0);
  expect(state.reportRequests).toHaveLength(0);
});

test('empty, unavailable and delayed data have explicit states', async ({ page }) => {
  await setup(page, { empty: true });
  await page.goto('/');
  await expect(page.getByText('Recorded orders will bring this chart to life.')).toBeVisible();
  await expect(page.locator('.ov-journey')).toContainText('No tracked visits yet');
  await expect(page.locator('.ov-metric').nth(2)).toContainText('—');
  await page.unroute('**/api/**');
  await setup(page, { fail: true });
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Performance data couldn’t refresh');
  await expect(page.getByRole('button', { name: 'Refresh performance' })).toBeEnabled();
  await page.unroute('**/api/**');
  await setup(page, { delayed: true });
  await page.reload();
  await expect(page.getByText(/More than an hour old/)).toBeVisible();
});
