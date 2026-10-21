import { expect, test, type Page } from '@playwright/test';
import type { components } from '../../packages/api-client/src/schema';

const base = '/reports/ai-models';
const paths = {
  report: '/api/v1/admin/reports/assistant',
  merchant: '/api/v1/admin/assistant/metrics',
  usage: '/api/v1/admin/assistant/usage',
};

async function setup(page: Page, permissions = ['reports.read']) {
  const report: components['schemas']['AssistantReport'] = {
    configured: true, window_hours: 24, evaluated_at: '2026-10-04T16:05:27Z',
    total: 0, completed: 0, unavailable: 0, disconnected: 0, average_latency_ms: null,
  };
  const merchant: components['schemas']['MerchantMetrics'] = {
    conversations: 1, turns: 4, helpful: 0, not_helpful: 0, latency_ms: 10,
  };
  const usage: components['schemas']['AssistantUsage'] = {
    conversations: 11, turns: 29, errors: 2, helpful: 0, not_helpful: 0, latency_ms: 345,
    input_tokens: 6897, output_tokens: 86, usage_recorded: 4,
    model_calls: 4, tool_calls: 37, retrieval_count: 5,
    cost_recorded: 4, estimated_cost_micros: 2900,
    models: [{ provider: 'openai', model: 'gpt-4.1-mini-2025-04-14', input_tokens: 6897, output_tokens: 86, turns: 4 }],
    routes: [],
  };
  const requests: string[] = [];
  const state = { failed: new Set<string>(), merchantWait: null as Promise<void> | null };
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (path.endsWith('/admin/me')) return route.fulfill({ json: {
      user: { id: '10000000-0000-4000-8000-000000000001', name: 'Store administrator', email: 'admin@example.test' }, permissions,
    } });
    if (path === paths.merchant && state.merchantWait) await state.merchantWait;
    if (state.failed.has(path)) return route.fulfill({ status: 503, json: { error: 'Internal store database password diagnostic' } });
    if (path === paths.report) return route.fulfill({ json: report });
    if (path === paths.merchant) return route.fulfill({ json: merchant });
    if (path === paths.usage) return route.fulfill({ json: usage });
    return route.fulfill({ json: path.includes('capabilities') ? { system: {}, stores: [], locations: [], sources: [] } : [] });
  });
  return { report, merchant, usage, requests, state };
}

test('model usage and conversation activity remain distinct from empty request outcomes', async ({ page }, info) => {
  await setup(page);
  await page.goto(base);
  await expect(page.getByRole('heading', { level: 1, name: 'AI models' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Model usage', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Shopper assistant', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Merchant assistant', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Request outcomes', exact: true })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: 'gpt-4.1-mini-2025-04-14' })).toBeVisible();
  await expect(page.getByText('No assistant turns have been recorded in this period.')).toHaveCount(0);
  await expect(page.locator('main')).toContainText('6,897');
  await expect(page.locator('main')).toContainText('$0.0029');
  await page.screenshot({ path: info.outputPath('ai-models-desktop.png'), fullPage: true });
});

test('historical internal-engine rows never appear as models', async ({ page }) => {
  const fixture = await setup(page);
  const internalModels = ['commerce-language-engine', 'approved-knowledge', 'deterministic', 'unconfigured'];
  fixture.usage.models.unshift(...internalModels.map(model => ({ provider: 'openai', model, input_tokens: 0, output_tokens: 0, turns: 3 })));
  await page.goto(base);
  await expect(page.getByRole('rowheader', { name: 'gpt-4.1-mini-2025-04-14' })).toBeVisible();
  for (const model of internalModels) await expect(page.getByRole('rowheader', { name: model, exact: true })).toHaveCount(0);
  fixture.usage.models = [fixture.usage.models[0]];
  Object.assign(fixture.usage, { input_tokens: 0, output_tokens: 0, usage_recorded: 0, model_calls: 0, cost_recorded: 0, estimated_cost_micros: 0 });
  await page.getByRole('button', { name: 'Refresh report', exact: true }).click();
  await expect(page.getByRole('rowheader', { name: 'gpt-4.1-mini-2025-04-14' })).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('commerce-language-engine');
  await expect(page.locator('main')).not.toContainText('$0.0000');
  await expect(page.getByRole('heading', { name: 'Shopper assistant', exact: true })).toBeVisible();
});

test('refresh waits for every section and partial failures preserve available data', async ({ page }) => {
  const fixture = await setup(page);
  await page.goto(base);
  const refresh = page.getByRole('button', { name: 'Refresh report', exact: true });
  await expect(refresh).toBeEnabled();
  let release!: () => void;
  fixture.state.merchantWait = new Promise<void>(resolve => { release = resolve; });
  fixture.state.failed.add(paths.merchant);
  const initial = fixture.requests.filter(path => path === paths.report).length;
  await refresh.click();
  try {
    await expect.poll(() => fixture.requests.filter(path => path === paths.report).length).toBe(initial + 1);
    await expect(page.getByRole('button', { name: /refresh/i })).toBeDisabled();
  } finally {
    release();
  }
  await expect(refresh).toBeEnabled();
  await expect(page.locator('main')).not.toContainText('Internal store database');
  await expect(page.locator('main')).not.toContainText('configure and migrate');
  await expect(page.getByRole('rowheader', { name: 'gpt-4.1-mini-2025-04-14' })).toBeVisible();
  fixture.state.failed.clear();
  fixture.state.merchantWait = null;
  await refresh.click();
  await expect(refresh).toBeEnabled();
});

test('mobile report fits the viewport and preserves the model table', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.goto(base);
  await expect(page.getByRole('rowheader', { name: 'gpt-4.1-mini-2025-04-14' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('ai-models-mobile.png'), fullPage: true });
});

test('unavailable usage and outcomes leave merchant activity visible with recoverable errors', async ({ page }) => {
  const fixture = await setup(page);
  fixture.state.failed.add(paths.usage);
  fixture.report.configured = false;
  await page.goto(base);
  await expect(page.getByText('Model usage could not be loaded.', { exact: true })).toBeVisible();
  await expect(page.getByText('Shopper activity could not be loaded.', { exact: true })).toBeVisible();
  await expect(page.getByText('Request outcome reporting is unavailable.', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Merchant assistant', exact: true })).toContainText('Saved answers');
  await expect(page.locator('main')).not.toContainText('Internal store database');
  fixture.state.failed.clear();
  await page.getByRole('button', { name: 'Retry model usage', exact: true }).click();
  await expect(page.getByRole('rowheader', { name: 'gpt-4.1-mini-2025-04-14' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('report permission protects both the navigation and direct route', async ({ page }) => {
  const fixture = await setup(page, ['catalog.read']);
  await page.goto(base);
  await expect(page.getByRole('heading', { level: 1, name: 'AI models' })).toHaveCount(0);
  await expect(page.locator('a[href="/reports/ai-models"]')).toHaveCount(0);
  await expect(page.locator('main')).toContainText(/access|permission/i);
  expect(fixture.requests.filter(path => Object.values(paths).includes(path))).toEqual([]);
});
