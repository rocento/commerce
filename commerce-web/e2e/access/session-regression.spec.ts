import { test, expect } from '@playwright/test';

const identity = {
  user: { id: '11111111-1111-4111-8111-111111111111', name: 'Regression reviewer', email: 'reviewer@example.test' },
  permissions: [] as string[],
};

// Explicit customer-facing destinations, including editor deep links. Denied
// screens must not fetch the protected data merely because the URL was entered.
const protectedRoutes = [
  '/catalog/products', '/catalog/products/new', '/catalog/categories',
  '/catalog/categories/example', '/catalog/attributes', '/catalog/attributes/sets',
  '/catalog/attributes/sets/new', '/catalog/attributes/definitions/new',
  '/catalog/media', '/catalog/inventory', '/catalog/sources', '/catalog/sources/new',
  '/catalog/stocks', '/catalog/stocks/new', '/catalog/delivery-areas',
  '/catalog/relationships', '/catalog/enrichment', '/catalog/geography',
  '/sales/orders', '/sales/orders/example', '/sales/order-statuses', '/sales/order-geography',
  '/customers/profiles', '/customers/profiles/example', '/customers/segments',
  '/customers/segments/new', '/customers/attributes', '/customers/attributes/definitions/new',
  '/customers/cohorts', '/customers/geography', '/customers/journey',
  '/marketing/promotions', '/marketing/promotions/new', '/marketing/reviews',
  '/marketing/notifications', '/marketing/email-templates',
  '/reports/dashboard', '/reports/cohorts', '/reports/ai-models',
  '/storefront/pages', '/storefront/navigation', '/storefront/languages',
  '/storefront/markets', '/storefront/themes', '/storefront/channel-assignments',
  '/fulfillment/capacity', '/fulfillment/new-schedule', '/fulfillment/new-capacity',
  '/fulfillment/replenishment', '/fulfillment/replenishment/example',
  '/support/tickets', '/support/tickets/example',
  '/system/users', '/system/roles', '/system/audit', '/system/import', '/system/export',
  '/system/api-reference',
];

for (const path of protectedRoutes) {
  test(`no permissions: ${path} denies access without fetching data`, async ({ page }) => {
    const unexpected: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/v1/admin/me') return route.fulfill({ json: identity });
      unexpected.push(`${route.request().method()} ${pathname}`);
      return route.fulfill({ status: 403, json: { error: 'Forbidden' } });
    });
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'This page isn’t available' })).toBeVisible();
    await expect(page.locator('.sidebar nav a[href="' + path + '"]')).toHaveCount(0);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('sign-in failure, retry, reload and sign-out preserve the session boundary', async ({ page }) => {
  let signedIn = false;
  let attempts = 0;
  const unexpected: string[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/admin/me') return route.fulfill({
      status: signedIn ? 200 : 401, json: signedIn ? identity : { error: 'Unauthorized' },
    });
    if (path === '/api/v1/admin/auth/login') {
      expect(request.method()).toBe('POST');
      expect(request.headers()['x-commerce-request']).toBe('1');
      expect(request.postDataJSON()).toEqual({ email: identity.user.email, password: 'Synthetic test password!' });
      attempts++;
      signedIn = attempts > 1;
      return route.fulfill({ status: signedIn ? 200 : 401, json: signedIn ? identity : { error: 'Invalid credentials' } });
    }
    if (path === '/api/v1/admin/auth/logout') {
      expect(request.method()).toBe('POST');
      signedIn = false;
      return route.fulfill({ status: 204 });
    }
    unexpected.push(path);
    return route.fulfill({ status: 403, json: { error: 'Forbidden' } });
  });
  await page.goto('/catalog/products');
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.locator('.sidebar')).toHaveCount(0);
  await page.getByLabel('Work email').fill(identity.user.email);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic test password!');
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('.sidebar')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await expect(page.getByRole('heading', { name: 'This page isn’t available' })).toBeVisible();
  await expect(page).toHaveURL(/\/catalog\/products$/);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.locator('.sidebar')).toHaveCount(0);
  expect(attempts).toBe(2);
  expect(unexpected).toEqual([]);
});
