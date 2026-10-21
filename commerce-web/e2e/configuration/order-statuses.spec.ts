import { test, expect, type Page } from '@playwright/test';
const definition = { id: '10000000-0000-0000-0000-000000000001', code: 'processing', state: 'fulfilling', label: 'Processing', translations: {}, description: '', tone: 'info', customer_visible: true, is_default: true, is_system: true, active: true, revision: 1, updated_at: '2026-10-04T00:00:00Z' };
async function setup(page: Page, permissions = ['*'], conflict = false) {
  const rows = [definition]; const writes: Record<string, unknown>[] = [];
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/admin/me')) return route.fulfill({ json: { user: { id: definition.id, name: 'Status manager', email: 'status@example.test' }, permissions } });
    if (path.includes('/order-statuses')) {
      if (route.request().method() === 'GET') return route.fulfill({ json: rows });
      const input = route.request().postDataJSON(); writes.push(input);
      if (conflict) return route.fulfill({ status: 409, json: { error: 'Conflict' } });
      const row = { ...definition, ...input, is_system: false }; rows.push(row); return route.fulfill({ json: row });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto('/sales/order-statuses');
  await expect(page.getByRole('heading', { name: 'Order statuses', exact: true })).toBeVisible();
  return writes;
}
test('Sales offers custom statuses with translations and protected defaults', async ({ page }) => {
  const writes = await setup(page);
  await expect(page.getByRole('navigation', { name: 'Administration navigation' }).getByRole('link', { name: 'Order statuses', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Processing', exact: true }).click();
  for (const name of ['Code', 'Workflow stage', 'Active', 'Default for this stage']) await expect(page.getByLabel(name, { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Add status', exact: true }).click();
  await page.getByLabel('Label', { exact: true }).fill('Picking');
  await page.getByLabel('Code', { exact: true }).fill('picking');
  await page.getByLabel('Workflow stage', { exact: true }).selectOption('fulfilling');
  await page.getByText('Translated labels (0)', { exact: true }).click();
  await page.getByLabel('Language code', { exact: true }).fill('ar');
  await page.getByRole('button', { name: 'Add translation', exact: true }).click();
  await page.getByLabel('Label (ar)', { exact: true }).fill('جارٍ التجهيز');
  await page.getByLabel('Visible to customers', { exact: true }).uncheck();
  await page.getByLabel('Reason for change', { exact: true }).fill('Track warehouse picking');
  await page.getByRole('button', { name: 'Save status', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Internal only', exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ code: 'picking', state: 'fulfilling', customer_visible: false, expected_revision: 0, translations: { ar: 'جارٍ التجهيز' } });
});
test('read-only status managers have a Sales entry and no editing controls', async ({ page }) => {
  await setup(page, ['orders.statuses.read']);
  await expect(page.getByText('You have read-only access to order statuses.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add status', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit Processing', exact: true })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Administration navigation' }).getByRole('link', { name: 'Orders', exact: true })).toHaveCount(0);
});
test('conflicts keep edits for review and reload fetches the current revision', async ({ page }) => {
  await setup(page, ['*'], true);
  await page.getByRole('button', { name: 'Edit Processing', exact: true }).click();
  await page.getByLabel('Label', { exact: true }).fill('Packing');
  await page.getByLabel('Reason for change', { exact: true }).fill('Better label');
  await page.getByRole('button', { name: 'Save status', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Reload the latest version');
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue('Packing');
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Reload latest', exact: true }).click();
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue('Processing');
});
test('order labels stay within the current stage and leave operational actions separate', async ({ page }) => {
  await setup(page);
  const id = '20000000-0000-0000-0000-000000000001';
  const choices = [definition, { ...definition, code: 'picking', label: 'Picking', is_default: false, is_system: false }, { ...definition, code: 'complete', state: 'cash_collected', label: 'Complete' }];
  let display = { code: 'processing', label: 'Processing', tone: 'info', translations: {} };
  let revision = 1;
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  await page.route('**/api/v1/admin/order-statuses', route => route.fulfill({ json: choices }));
  await page.route(`**/api/v1/admin/orders/${id}`, route => route.fulfill({ json: { order: { id, number: 1001, status: 'fulfilling', status_display: display, status_revision: revision, created_at: '2026-10-04T00:00:00Z', contact: { email: 'shopper@example.test' }, location: {}, tax_snapshot: { name: 'No tax' }, discount_snapshot: [], discount_amount: '0.00', tax_amount: '0.00', subtotal: '10.00', delivery_fee: '0.00', total: '10.00', currency: 'USD' }, items: [], history: [], payment: { collected_at: null }, refunds: [], shipments: [], dispatch: null } }));
  await page.route(`**/api/v1/admin/orders/${id}/status-label`, async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    writes.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    display = { ...display, code: 'picking', label: 'Picking' }; revision++;
    return route.fulfill({ json: { status: 'ok' } });
  });
  await page.goto(`/sales/orders/${id}`);
  await expect(page.getByRole('heading', { name: 'Order #1001', exact: true, level: 1 })).toBeVisible();
  const picker = page.getByLabel('Status label', { exact: true });
  await expect(picker.locator('option')).toHaveText(['Processing', 'Picking']);
  await picker.selectOption('picking');
  await page.getByLabel('Reason for status change', { exact: true }).fill('Picking has started');
  await page.getByRole('button', { name: 'Update label', exact: true }).click();
  await expect(page.locator('.order-titlebar .order-status-label')).toHaveText('Picking');
  expect(writes).toEqual([{ path: `/api/v1/admin/orders/${id}/status-label`, body: { code: 'picking', expected_revision: 1, reason: 'Picking has started' } }]);
  await expect(page.getByRole('button', { name: 'Cancel order', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark cash collected', exact: true })).toHaveCount(0);
});
