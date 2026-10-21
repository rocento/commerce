import { test, expect } from './fixtures';

const screens = [
  ['/', 'Business overview'],
  ['/catalog/products', 'Products'], ['/catalog/categories', 'Categories'],
  ['/catalog/attributes', 'Attributes'], ['/catalog/media', /Media/],
  ['/catalog/inventory', 'Inventory'], ['/catalog/sources', 'Locations'],
  ['/catalog/stocks', 'Stock pools'], ['/catalog/delivery-areas', 'Service areas'],
  ['/settings/delivery-fee', 'Delivery fee'], ['/settings/tax', 'Tax rules'],
  ['/sales/orders', 'Orders'], ['/sales/support', 'Support tickets'],
  ['/customers/profiles', 'Customer profiles'], ['/customers/segments', 'Customer Segments'],
  ['/customers/attributes', 'Customer Attributes'], ['/customers/cohorts', 'Cohort & retention'],
  ['/marketing/promotions', 'Promotions & coupons'], ['/marketing/reviews', 'Review moderation'],
  ['/reports/dashboard', 'Sales dashboard'], ['/reports/ai-models', 'AI models'], ['/reports/cohorts', 'Cohort & retention'],
  ['/content/pages', 'Pages & blocks'], ['/system/users', 'Admin users'],
  ['/system/roles', 'Roles & permissions'], ['/system/audit', 'Audit log'],
  ['/system/import', 'Import'], ['/system/export', 'Export'],
] as const;

for (const [path, heading] of screens) {
  test(`admin screen ${path} loads without runtime or API failures`, async ({ page }) => {
    const errors: string[] = [];
    const expectedUnavailable = path === '/reports/ai-models' && process.env.ADMIN_TEST_ASSISTANT_UNAVAILABLE === '1';
    const unavailableBodies: Promise<unknown>[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (expectedUnavailable && new URL(response.url()).pathname === '/api/v1/admin/assistant/usage' && response.status() === 503) {
        unavailableBodies.push(response.json());
        return;
      }
      if (response.url().includes('/api/') && response.status() >= 400)
        errors.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });
    await page.goto(path);
    if (path === '/settings/delivery-fee' || path === '/settings/tax') {
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Configuration');
      await expect(page.getByRole('heading', { level: 2, name: heading, exact: true })).toBeVisible();
      await expect(page).toHaveURL(`/system/configuration/${path.split('/').at(-1)}`);
    } else await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
    await page.waitForLoadState('networkidle');
    if (expectedUnavailable) {
      expect(unavailableBodies.length).toBeGreaterThan(0);
      for (const body of await Promise.all(unavailableBodies))
        expect(body).toEqual({ error: 'Assistant temporarily unavailable. You can still contact support.' });
      await expect(page.getByText('Model usage could not be loaded.', { exact: true })).toBeVisible();
      await expect(page.getByText('Shopper activity could not be loaded.', { exact: true })).toBeVisible();
      await expect(page.getByRole('table', { name: 'Shopper model usage in the last 24 hours' })).toHaveCount(0);
    }
    await expect(page.getByRole('alert')).toHaveCount(expectedUnavailable ? 2 : 0);
    expect(errors).toEqual([]);
  });
}

test('every sidebar destination has a working route', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();
  const links = await page.locator('.sidebar nav a').evaluateAll(nodes => nodes.map(n => n.getAttribute('href')!));
  for (const href of new Set(links)) {
    await page.goto(href);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'This page isn’t available' }), `Sidebar destination ${href}`).toHaveCount(0);
  }
});

for (const [path, action] of [
  ['/catalog/products', 'Add Product'], ['/customers/segments', 'Add Segment'],
  ['/customers/attributes', 'Add Attribute'], ['/catalog/sources', 'Add inventory location'],
  ['/catalog/stocks', 'Create new stock'],
]) {
  test(`primary action is top right on ${path}`, async ({ page }) => {
    await page.goto(path);
    const button = page.getByRole(['/catalog/stocks', '/catalog/sources'].includes(path) ? 'link' : 'button', { name: action, exact: true });
    await expect(button).toBeVisible();
    const b = (await button.boundingBox())!;
    const h = (await page.getByRole('heading', { level: 1 }).boundingBox())!;
    expect(b.x).toBeGreaterThan(h.x + h.width / 2);
    expect(Math.abs(b.y - h.y)).toBeLessThan(120);
  });
}


test('admin assistant waits for explicit confirmation before running a real report', async ({ page }) => {
  const queries: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/v1/admin/assistant/query') queries.push(request.postData() || ''); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Ask Rocento AI', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Admin assistant', exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Run report', exact: true })).toBeEnabled();
  expect(queries).toEqual([]);
  await drawer.getByRole('button', { name: 'New chat', exact: true }).click();
  const response = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/v1/admin/assistant/query');
  await drawer.getByRole('button', { name: 'Run report', exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(drawer.locator('.merchant-turn')).toHaveCount(1);
  await expect(drawer.getByRole('alert')).toHaveCount(0);
  expect(queries).toHaveLength(1);
});


for (const width of [1440, 390]) {
  test(`shared headers fit every admin screen at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 1000 });
    const paths = [...screens.map(([path]) => path), '/content/themes', '/catalog/attributes/sets', '/catalog/products/new', '/catalog/sources/new', '/catalog/stocks/new', '/customers/segments/new', '/catalog/attributes/definitions/new', '/catalog/attributes/sets/new'];
    for (const path of paths) {
      await page.goto(path);
      const headers = page.locator('.admin-page-heading');
      const configuration = path === '/settings/delivery-fee' || path === '/settings/tax';
      await expect(headers, path).toHaveCount(configuration ? 2 : 1);
      const header = configuration ? headers.first() : headers;
      await expect(header.getByRole('heading', { level: 1 }), path).toBeVisible();
      const box = (await header.boundingBox())!;
      expect(box.x, path).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, path).toBeLessThanOrEqual(width + 1);
      for (const control of await header.locator('button, a').all()) {
        if (!await control.isVisible()) continue;
        const bounds = (await control.boundingBox())!;
        expect(bounds.x, path).toBeGreaterThanOrEqual(box.x - 1);
        expect(bounds.x + bounds.width, path).toBeLessThanOrEqual(box.x + box.width + 1);
        expect(bounds.height, path).toBeGreaterThanOrEqual(width === 390 ? 44 : 40);
        const title = (await header.locator('h1').boundingBox())!;
        expect(bounds.x >= title.x + title.width - 1 || bounds.y >= title.y + title.height, path).toBeTruthy();
      }
      if (path === '/catalog/attributes') await page.screenshot({ path: testInfo.outputPath(`attributes-header-${width}.png`) });
    }
  });
}
