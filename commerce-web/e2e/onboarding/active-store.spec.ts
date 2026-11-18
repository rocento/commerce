import { test, expect } from '@playwright/test';

test('active store opens details without setup, payments or draft writes', async ({ page }, testInfo) => {
  let fail = false, signedIn = true;
  const writes: string[] = [], payments: string[] = [];
  await page.route('**/api/control/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname.replace('/api/control/', '');
    if (req.method() !== 'GET') writes.push(path);
    if (path.includes('payment')) payments.push(path);
    if (path === 'me') return route.fulfill(signedIn ? { json: { id: 'account', email: 'owner@example.test', verified: true } } : { status: 401, json: { code: 'UNAUTHENTICATED' } });
    if (path === 'onboarding/draft') return route.fulfill({ json: { id: 'draft', version: 3, brand: 'Green Market', slug: 'green-market', plan: 'LAUNCH', theme: 'grocery', payment: 'ROCENTO', tenant_id: 'store' } });
    if (path === 'stores/store/provisioning') return route.fulfill(fail ? { status: 503, json: {} } : { json: { lifecycleStatus: 'ACTIVE', status: null, storefrontUrl: 'https://green-market.rocento.com', adminUrl: 'https://green-market-admin.rocento.com', serviceStartsAt: '2026-11-01T00:00:00Z', serviceEndsAt: '2026-12-01T00:00:00Z' } });
    if (path === 'customer/auth/logout') { signedIn = false; return route.fulfill({ json: {} }); }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('http://127.0.0.1:3100');
  await expect(page.getByRole('heading', { name: 'Welcome back to Green Market' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open store admin' })).toHaveAttribute('href', 'https://green-market-admin.rocento.com');
  await expect(page.getByRole('navigation', { name: 'Setup progress' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Store setup status' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Rocento payment' })).toHaveCount(0);
  await expect(page.getByText('owner@example.test', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('active-store-desktop.png'), fullPage: true });
  fail = true;
  await page.getByRole('button', { name: 'Refresh details' }).click();
  await expect(page.locator('main [role=alert]')).toContainText('refresh your store details');
  await expect(page.getByRole('heading', { name: 'Store details', exact: true })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Refresh details' }).click();
  await expect(page.locator('main [role=alert]')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('active-store-mobile.png'), fullPage: true });
  expect(payments).toEqual([]);
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Setup progress' })).toBeVisible();
  expect(writes).toEqual(['customer/auth/logout']);
});
