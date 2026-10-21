import { test, expect } from '@playwright/test';

const initial = { enabled: false, provider: 'openai', model: 'test-model', key_configured: true, source: 'admin', editable: true };
test.beforeEach(async ({ page }) => {
  // Fully mocked frontend-state tests. No production API requests.
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
  await page.route('**/api/v1/admin/assistant/readiness', route => route.fulfill({ json: { checks: [], currency_modes: [], quantity_modes: [], payment_modes: [], delivery_modes: [], feature_flags: [], last_acceptance: { status: 'not_run', message: 'Not yet checked', checked_at: null }, provider_configured: true, enabled: false } }));
  await page.route('**/api/v1/admin/me', route => route.fulfill({ json: { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Quality Admin', email: 'qa@example.test' }, permissions: ['assistant.settings.read', 'assistant.settings.write'] } }));
});
test('QA-AI-01 saved toggle persists across refresh without returning a key', async ({ page }) => {
  let saved = { ...initial };
  let writes = 0;
  await page.route('**/api/v1/admin/assistant/settings', async route => {
    if (route.request().method() === 'PUT') {
      const input = route.request().postDataJSON();
      expect(input).not.toHaveProperty('api_key');
      saved = { ...saved, enabled: input.enabled };
      writes++;
    }
    await route.fulfill({ json: saved });
  });
  await page.goto('/settings/ai-assistant');
  await expect(page.getByRole('heading', { name: 'Shopping Assistance', exact: true })).toBeVisible();
  await page.getByLabel('Enable AI assistant', { exact: true }).check();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toContainText('Settings saved');
  expect(writes).toBe(1);
  await page.reload();
  await expect(page.getByLabel('Enable AI assistant', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Replace API key')).toHaveValue('');
});
test('QA-AI-02 read-only permission disables writes', async ({ page }) => {
  await page.route('**/api/v1/admin/me', route => route.fulfill({ json: { user: { name: 'Reader' }, permissions: ['assistant.settings.read'] } }));
  await page.route('**/api/v1/admin/assistant/settings', route => route.fulfill({ json: initial }));
  await page.goto('/settings/ai-assistant');
  await expect(page.getByRole('button', { name: 'Save settings', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Enable AI assistant', { exact: true })).toBeDisabled();
});
test('QA-AI-03 missing permission denies direct route before settings request', async ({ page }) => {
  let reads = 0;
  await page.route('**/api/v1/admin/me', route => route.fulfill({ json: { user: { name: 'Denied' }, permissions: [] } }));
  await page.route('**/api/v1/admin/assistant/settings', route => { reads++; return route.fulfill({ json: initial }); });
  await page.goto('/settings/ai-assistant');
  await expect(page.getByRole('heading', { name: 'Configuration access restricted' })).toBeVisible();
  expect(reads).toBe(0);
});
test('QA-AI-04 unavailable settings show an actionable error', async ({ page }) => {
  await page.route('**/api/v1/admin/assistant/settings', route => route.fulfill({ status: 503, json: { error: 'AI settings service is unavailable.' } }));
  await page.goto('/settings/ai-assistant');
  await expect(page.getByRole('alert')).toContainText('AI settings service is unavailable');
  await expect(page.getByRole('button', { name: 'Save settings', exact: true })).toHaveCount(0);
});

test('malformed readiness metadata shows an error without breaking settings', async ({ page }) => {
  await page.route('**/api/v1/admin/assistant/settings', route => route.fulfill({ json: initial }));
  await page.route('**/api/v1/admin/assistant/readiness', route => route.fulfill({ json: [] }));
  await page.goto('/settings/ai-assistant');
  await expect(page.getByRole('alert')).toContainText('invalid readiness metadata');
  await expect(page.getByRole('button', { name: 'Save settings', exact: true })).toBeEnabled();
});
