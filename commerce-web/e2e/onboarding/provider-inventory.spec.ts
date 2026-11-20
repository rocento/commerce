import { test, expect } from '@playwright/test';

test('viewer fetches and filters provider inventory without mutations', async ({ page }, testInfo) => {
  let reads = 0, failed = false;
  const writes: string[] = [];
  await page.route('**/api/control/**', async route => {
    const request = route.request();
    if (request.method() !== 'GET') writes.push(request.url());
    const path = new URL(request.url()).pathname.split('/').pop();
    if (path === 'me') return route.fulfill({ json: { id: 'viewer', email: 'viewer@example.test', role: 'VIEWER' } });
    if (path === 'clients') return route.fulfill({ json: { items: [], total: 0, page: 0 } });
    if (path === 'dashboard') {
      reads++;
      if (failed) return route.fulfill({ status: 503, json: { code: 'SERVICE_UNAVAILABLE' } });
      return route.fulfill({ json: {
        counts: { clients: 0, active: 0, awaitingPayment: 0, setupAttention: 0 }, jobs: [], payments: [], activity: [],
        hosts: [
          { id: 'aws-host', provider: 'aws', reference: 'i-recorded', state: 'READY', usedSlots: 2, maxSlots: 3, address: '192.0.2.1', error: null, updatedAt: '2026-11-18T10:00:00Z' },
          { id: 'gcp-host', provider: 'gcp', reference: 'gcp-failed', state: 'FAILED', usedSlots: 0, maxSlots: 3, address: null, error: 'BOOT_TIMEOUT', updatedAt: '2026-11-18T09:00:00Z' },
        ],
      } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('http://127.0.0.1:3101');
  await page.getByRole('button', { name: 'Provisioning', exact: true }).click();
  const table = page.getByRole('table', { name: 'Provider servers' });
  await expect(table.getByRole('cell', { name: 'AWS i-recorded aws-host', exact: true })).toBeVisible();
  await expect(table.getByText('boot timeout')).toBeVisible();
  await page.getByLabel('Filter provider').selectOption('aws');
  await expect(table.getByText('gcp-failed')).toHaveCount(0);
  await page.getByLabel('Search servers').fill('192.0.2.1');
  await expect(table.getByRole('cell', { name: 'AWS i-recorded aws-host', exact: true })).toBeVisible();
  await page.getByLabel('Server status').selectOption('FAILED');
  await expect(page.getByText('No servers match these filters.')).toBeVisible();
  await page.getByLabel('Server status').selectOption('');
  const before = reads;
  await page.getByRole('button', { name: 'Refresh provider data', exact: true }).click();
  await expect.poll(() => reads).toBeGreaterThan(before);
  failed = true;
  await page.getByRole('button', { name: 'Refresh provider data', exact: true }).click();
  await expect(page.locator('.error[role=alert]')).toBeVisible();
  await expect(table.getByRole('cell', { name: 'AWS i-recorded aws-host', exact: true })).toBeVisible();
  expect(writes).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('provider-mobile.png'), fullPage: true });
});
